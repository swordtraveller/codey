import { performance } from 'node:perf_hooks'
import { getEncoding } from 'js-tiktoken'
import type { ContextManagementConfig, ModelConfig } from '../shared/types'
import { defaultContextManagementConfig } from '../shared/types'
import { manageContext, type ContextMessage } from './context'
import { countContextTokens } from './context-utils'
import {
  RULER_OFFICIAL_TASKS,
  type RulerCase,
  type RulerCaseResult,
  type RulerEvaluationResult,
  type RulerRemoteConfig,
  type RulerStrategy,
  requestRulerModel,
} from './ruler'

export type OfficialRulerTaskName = typeof RULER_OFFICIAL_TASKS[number]
export type RulerTokenizerName = 'cl100k_base' | 'o200k_base'

export type OfficialRulerGenerationOptions = {
  tasks?: OfficialRulerTaskName[]
  samplesPerTask?: number
  maxLen?: number
  tokensToGenerate?: number
  seed?: number
  tokenizer?: RulerTokenizerName
}

export type OfficialRulerEvaluationOptions = {
  modelConfig: ModelConfig
  contextConfig?: Partial<ContextManagementConfig>
  remote: RulerRemoteConfig
  tasks?: OfficialRulerTaskName[]
  samplesPerTask?: number
  maxLen?: number
  tokensToGenerate?: number
  seed?: number
  tokenizer?: RulerTokenizerName
  rhaiScript?: string
  signal?: AbortSignal
}

const tokenizerCache = new Map<RulerTokenizerName, ReturnType<typeof getEncoding>>()
const niahTemplate = 'Some special magic {type_needle_v} are hidden within the following text. Make sure to memorize it. I will quiz you about the {type_needle_v} afterwards.\n{context}\nWhat are all the special magic {type_needle_v} for {query} mentioned in the provided text?'
const variableTrackingTemplate = 'Memorize and track the chain(s) of variable assignment hidden in the following text.\n\n{context}\nQuestion: Find all variables that are assigned the value {query} in the text above.'
const noiseSentence = 'The grass is green. The sky is blue. The sun is yellow. Here we go. There and back again.'

function tokenizerFor(name: RulerTokenizerName): ReturnType<typeof getEncoding> {
  const cached = tokenizerCache.get(name)
  if (cached) return cached
  const encoding = getEncoding(name)
  tokenizerCache.set(name, encoding)
  return encoding
}

export function countRulerTokens(text: string, tokenizer: RulerTokenizerName = 'cl100k_base'): number {
  return tokenizerFor(tokenizer).encode(text).length
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function randomInt(random: () => number, min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min
}

function officialMessage(id: string, role: ContextMessage['role'], content: string): ContextMessage {
  return {
    id,
    role,
    content,
    createdAt: new Date(0).toISOString(),
    enteredHotAt: new Date(0).toISOString(),
    lastAccessedAt: new Date(0).toISOString(),
    contextLayer: 'hot',
    contextSource: 'live',
    representation: 'original',
  }
}

function distributeNeedles(fillerItems: number, needles: string[]): string[] {
  const output: string[] = []
  let needleIndex = 0
  for (let index = 0; index <= fillerItems; index += 1) {
    while (needleIndex < needles.length && Math.floor((needleIndex + 1) * (fillerItems + 1) / (needles.length + 1)) <= index) {
      output.push(needles[needleIndex++])
    }
    if (index > 0) output.push(`${noiseSentence} Filler ${index}.`)
  }
  while (needleIndex < needles.length) output.push(needles[needleIndex++])
  return output
}

function buildNiahInput(fillerItems: number, key: string, values: string[], valueType: string): string {
  const needles = values.map((value) => `One of the special magic ${valueType} for ${key} is: ${value}.`)
  const context = distributeNeedles(fillerItems, needles).join('\n')
  const singular = values.length === 1
  const type = singular ? valueType.replace(/s$/, '') : valueType
  const query = key
  return niahTemplate
    .replaceAll('{type_needle_v}', type)
    .replace('{context}', context)
    .replace('{query}', query)
}

function buildVariableTrackingInput(fillerItems: number, variables: string[], initialValue: string, numHops: number): string {
  const assignments = [`VAR ${variables[0]} = ${initialValue}`]
  for (let index = 0; index < numHops; index += 1) assignments.push(`VAR ${variables[index + 1]} = VAR ${variables[index]}`)
  const context = distributeNeedles(fillerItems, assignments.map((item) => `${item}.`)).join('\n')
  return variableTrackingTemplate.replace('{context}', context).replace('{query}', initialValue)
}

function fitFillerCount(builder: (count: number) => string, targetTokens: number, tokenizer: RulerTokenizerName): string {
  if (countRulerTokens(builder(0), tokenizer) > targetTokens) throw new Error('Official RULER prompt exceeds max-len before haystack filler is added')
  let low = 0
  let high = Math.max(16, Math.ceil(targetTokens / 8))
  while (countRulerTokens(builder(high), tokenizer) <= targetTokens) high *= 2
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (countRulerTokens(builder(middle), tokenizer) <= targetTokens) low = middle + 1
    else high = middle - 1
  }
  return builder(Math.max(0, high))
}

function splitForContext(inputText: string, task: OfficialRulerTaskName, seed: number): RulerCase['messages'] {
  const questionMarker = task === 'variable_tracking' ? '\nQuestion:' : '\nWhat are all the special magic'
  const markerIndex = inputText.lastIndexOf(questionMarker)
  const contextText = markerIndex >= 0 ? inputText.slice(0, markerIndex) : inputText
  const question = markerIndex >= 0 ? inputText.slice(markerIndex).trim() : 'Answer the benchmark question using the context above.'
  const chunks = contextText.match(/[\s\S]{1,8000}/g) ?? [contextText]
  return [
    officialMessage(`official-system-${seed}`, 'system', 'You are evaluating an official-style RULER long-context retrieval task. Follow the benchmark question and answer concisely.'),
    ...chunks.map((chunk, index) => officialMessage(`official-context-${seed}-${index}`, 'user', chunk)),
    officialMessage(`official-query-${seed}`, 'user', question),
  ]
}

function generateOfficialCase(task: OfficialRulerTaskName, index: number, options: Required<Pick<OfficialRulerGenerationOptions, 'maxLen' | 'tokensToGenerate' | 'seed' | 'tokenizer'>>): RulerCase {
  const random = seededRandom(options.seed + index)
  const targetInputTokens = Math.max(1, options.maxLen - options.tokensToGenerate)
  if (task === 'variable_tracking') {
    const numHops = 4
    const variables = Array.from({ length: numHops + 1 }, () => Array.from({ length: 5 }, () => String.fromCharCode(65 + randomInt(random, 0, 25))).join(''))
    const initialValue = String(randomInt(random, 10_000, 99_999))
    const inputText = fitFillerCount((fillerItems) => buildVariableTrackingInput(fillerItems, variables, initialValue, numHops), targetInputTokens, options.tokenizer)
    const messages = splitForContext(inputText, task, options.seed + index)
    return {
      id: `official-variable-tracking-${index}`,
      task,
      messages,
      latestUserMessageId: `official-query-${options.seed + index}`,
      expectedAnswers: variables,
      inputText,
      targetTokens: options.maxLen,
      tokenizer: options.tokenizer,
      seed: options.seed + index,
    }
  }

  const key = `RULER-KEY-${randomInt(random, 100_000, 999_999)}`
  const valueCount = task === 'niah_multivalue' ? 4 : 1
  const values = Array.from({ length: valueCount }, () => String(randomInt(random, 1_000_000, 9_999_999)))
  const inputText = fitFillerCount((fillerItems) => buildNiahInput(fillerItems, key, values, 'numbers'), targetInputTokens, options.tokenizer)
  const messages = splitForContext(inputText, task, options.seed + index)
  return {
    id: `official-${task}-${index}`,
    task,
    messages,
    latestUserMessageId: `official-query-${options.seed + index}`,
    expectedAnswers: values,
    inputText,
    targetTokens: options.maxLen,
    tokenizer: options.tokenizer,
    seed: options.seed + index,
  }
}

export function generateOfficialRulerCases(options: OfficialRulerGenerationOptions = {}): RulerCase[] {
  const tasks = options.tasks?.length ? options.tasks : [...RULER_OFFICIAL_TASKS]
  const samplesPerTask = Math.max(1, Math.floor(options.samplesPerTask ?? 1))
  const resolved = {
    maxLen: Math.max(128, Math.floor(options.maxLen ?? 4096)),
    tokensToGenerate: Math.max(1, Math.floor(options.tokensToGenerate ?? 128)),
    seed: Math.floor(options.seed ?? 42),
    tokenizer: options.tokenizer ?? 'cl100k_base' as RulerTokenizerName,
  }
  return tasks.flatMap((task) => Array.from({ length: samplesPerTask }, (_, index) => generateOfficialCase(task, index, resolved)))
}

export function scoreOfficialRulerAnswer(answer: string, expectedAnswers: string[]): boolean {
  const normalized = answer.toLocaleLowerCase()
  return expectedAnswers.every((expected) => normalized.includes(expected.toLocaleLowerCase()))
}

function evaluationConfig(modelConfig: ModelConfig, overrides: Partial<ContextManagementConfig>): ContextManagementConfig {
  return {
    ...defaultContextManagementConfig,
    ...overrides,
    hotTokenBudget: Math.max(1_000, overrides.hotTokenBudget ?? defaultContextManagementConfig.hotTokenBudget),
    warmTokenBudget: Math.max(0, overrides.warmTokenBudget ?? defaultContextManagementConfig.warmTokenBudget),
    maxInputTokens: Math.min(modelConfig.modelMaxContext, overrides.maxInputTokens || 0),
  }
}

function textFromMessages(messages: ContextMessage[]): string {
  return messages.map((message) => message.content ?? '').join('\n')
}

function average(items: RulerCaseResult[], selector: (result: RulerCaseResult) => number): number {
  return items.length ? items.reduce((total, result) => total + selector(result), 0) / items.length : 0
}

export async function runOfficialRulerEvaluation(options: OfficialRulerEvaluationOptions): Promise<RulerEvaluationResult> {
  const tokenizer = options.tokenizer ?? 'cl100k_base'
  const seed = Math.floor(options.seed ?? 42)
  const maxLen = Math.max(128, Math.floor(options.maxLen ?? 4096))
  const cases = generateOfficialRulerCases({
    tasks: options.tasks,
    samplesPerTask: options.samplesPerTask,
    maxLen,
    tokensToGenerate: options.tokensToGenerate,
    seed,
    tokenizer,
  })
  const strategies: RulerStrategy[] = options.rhaiScript ? ['builtin', 'rhai'] : ['builtin']
  const results: RulerCaseResult[] = []

  for (const currentCase of cases) {
    for (const strategy of strategies) {
      const config = evaluationConfig(options.modelConfig, {
        ...options.contextConfig,
        customStrategyEnabled: strategy === 'rhai',
        customStrategyScript: strategy === 'rhai' ? options.rhaiScript : '',
      })
      const sourceTokens = countRulerTokens(currentCase.inputText ?? '', tokenizer)
      const started = performance.now()
      const rhaiStarted = performance.now()
      const contextResult = manageContext(currentCase.messages, [], options.modelConfig, config, {
        allowCustomStrategy: strategy === 'rhai',
        latestUserMessageId: currentCase.latestUserMessageId,
      })
      const rhaiMs = strategy === 'rhai' ? performance.now() - rhaiStarted : 0
      const contextBuildMs = performance.now() - started
      const managedText = textFromMessages(contextResult.messages)
      const compressedTokens = countRulerTokens(managedText, tokenizer)
      const result: RulerCaseResult = {
        caseId: currentCase.id,
        task: currentCase.task,
        strategy,
        correct: false,
        answer: '',
        expectedAnswers: currentCase.expectedAnswers,
        originalTokens: sourceTokens,
        compressedTokens,
        compressionRatio: compressedTokens ? sourceTokens / compressedTokens : 1,
        contextBuildMs,
        rhaiMs,
        remoteRequestMs: 0,
        coldRecallCount: contextResult.actions.filter((action) => action.type === 'recall').length,
        strategyApplied: strategy === 'builtin' || contextResult.customStrategyApplied === true,
        overflow: contextResult.overflow?.reason,
      }
      if (contextResult.overflow) {
        result.error = `Context overflow: ${contextResult.overflow.reason}`
        results.push(result)
        continue
      }
      if (!result.strategyApplied) {
        result.error = 'Rhai strategy was unavailable or returned an invalid selection'
        results.push(result)
        continue
      }
      try {
        const requestStarted = performance.now()
        result.answer = await requestRulerModel(contextResult.messages, options.remote, options.signal)
        result.remoteRequestMs = performance.now() - requestStarted
        result.correct = scoreOfficialRulerAnswer(result.answer, result.expectedAnswers)
      } catch (error) {
        result.error = error instanceof Error ? error.message : 'Remote model request failed'
      }
      results.push(result)
    }
  }

  const summary: RulerEvaluationResult['summary'] = {}
  for (const strategy of strategies) {
    const items = results.filter((result) => result.strategy === strategy)
    summary[strategy] = {
      cases: items.length,
      correct: items.filter((result) => result.correct).length,
      accuracy: items.length ? items.filter((result) => result.correct).length / items.length : 0,
      averageContextBuildMs: average(items, (result) => result.contextBuildMs),
      averageRhaiMs: average(items, (result) => result.rhaiMs),
      averageRemoteRequestMs: average(items, (result) => result.remoteRequestMs),
      averageCompressionRatio: average(items, (result) => result.compressionRatio),
    }
  }
  return {
    benchmark: 'ruler-official-subset',
    generatedAt: new Date().toISOString(),
    model: options.remote.modelName,
    tasks: options.tasks?.length ? options.tasks : [...RULER_OFFICIAL_TASKS],
    strategies,
    results,
    mode: 'official',
    tokenizer,
    targetTokens: maxLen,
    seed,
    summary,
  }
}
