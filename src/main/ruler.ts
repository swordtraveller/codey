import { performance } from 'node:perf_hooks'
import type { ContextManagementConfig, ModelConfig } from '../shared/types'
import { defaultContextManagementConfig } from '../shared/types'
import { manageContext, type ContextMessage } from './context'
import { countContextTokens } from './context-utils'
import { toProviderMessages } from './model-messages'

export const RULER_TASKS = ['niah_single', 'niah_multi', 'variable_tracking'] as const
export const RULER_OFFICIAL_TASKS = ['niah_single', 'niah_multivalue', 'variable_tracking'] as const
export type RulerTaskName = typeof RULER_TASKS[number] | typeof RULER_OFFICIAL_TASKS[number]

export type RulerCase = {
  id: string
  task: RulerTaskName
  messages: ContextMessage[]
  latestUserMessageId: string
  expectedAnswers: string[]
  inputText?: string
  targetTokens?: number
  tokenizer?: string
  seed?: number
}

export type RulerStrategy = 'builtin' | 'rhai'

export type RulerCaseResult = {
  caseId: string
  task: RulerTaskName
  strategy: RulerStrategy
  correct: boolean
  answer: string
  expectedAnswers: string[]
  originalTokens: number
  compressedTokens: number
  compressionRatio: number
  contextBuildMs: number
  rhaiMs: number
  remoteRequestMs: number
  coldRecallCount: number
  overflow?: string
  error?: string
  strategyApplied: boolean
}

export type RulerEvaluationResult = {
  benchmark: 'ruler-subset' | 'ruler-official-subset'
  generatedAt: string
  model: string
  tasks: RulerTaskName[]
  strategies: RulerStrategy[]
  results: RulerCaseResult[]
  mode?: 'legacy' | 'official'
  tokenizer?: string
  targetTokens?: number
  seed?: number
  summary: Record<string, {
    cases: number
    correct: number
    accuracy: number
    averageContextBuildMs: number
    averageRhaiMs: number
    averageRemoteRequestMs: number
    averageCompressionRatio: number
  }>
}

export type RulerGenerationOptions = {
  tasks?: RulerTaskName[]
  samplesPerTask?: number
  fillerItems?: number
}

export type RulerRemoteConfig = {
  baseUrl: string
  apiKey: string
  modelName: string
  timeoutMs?: number
  maxOutputTokens?: number
}

export type RulerEvaluationOptions = {
  modelConfig: ModelConfig
  contextConfig?: Partial<ContextManagementConfig>
  remote: RulerRemoteConfig
  tasks?: RulerTaskName[]
  samplesPerTask?: number
  fillerItems?: number
  rhaiScript?: string
  signal?: AbortSignal
}

const fillerSentences = [
  'The project uses small, reviewable changes and keeps user data local.',
  'A reliable development workflow records the input and output of each operation.',
  'Prefer explicit boundaries over implicit global state when designing an agent.',
  'A test should describe one observable behavior and avoid unrelated setup.',
  'The interface should remain responsive while background work is running.',
]

function message(id: string, role: ContextMessage['role'], content: string): ContextMessage {
  return {
    id,
    role,
    content,
    createdAt: new Date(0).toISOString(),
    contextLayer: 'hot',
    contextSource: 'live',
    representation: 'original',
  }
}

function addFiller(messages: ContextMessage[], count: number, seed: number): void {
  for (let index = 0; index < count; index += 1) {
    const sentence = fillerSentences[(seed + index) % fillerSentences.length]
    messages.push(message(`filler-${seed}-${index}`, index % 2 === 0 ? 'user' : 'assistant', `${sentence} Note ${seed}-${index}.`))
  }
}

function createSingleNeedleCase(index: number, fillerItems: number): RulerCase {
  const answer = `RULER-SINGLE-${index + 1}`
  const messages: ContextMessage[] = [message('system', 'system', 'You are a benchmark answerer. Follow the latest user instruction and answer exactly when asked.')]
  addFiller(messages, Math.max(1, Math.floor(fillerItems / 2)), index)
  messages.push(message(`needle-${index}`, 'user', `A hidden benchmark record says: the retrieval key is ${answer}. Keep this fact exact.`))
  addFiller(messages, Math.ceil(fillerItems / 2), index + 11)
  const latestUserMessageId = `query-${index}`
  messages.push(message(latestUserMessageId, 'user', `What is the retrieval key from the hidden benchmark record? Reply with only the key.`))
  return { id: `niah-single-${index}`, task: 'niah_single', messages, latestUserMessageId, expectedAnswers: [answer] }
}

function createMultiNeedleCase(index: number, fillerItems: number): RulerCase {
  const answers = ['ALPHA', 'BRAVO', 'CHARLIE'].map((value) => `RULER-${value}-${index + 1}`)
  const messages: ContextMessage[] = [message('system', 'system', 'You are a benchmark answerer. Preserve exact identifiers and answer the latest question.')]
  messages.push(message(`needle-${index}-0`, 'user', `Record A contains the exact value ${answers[0]}.`))
  addFiller(messages, Math.floor(fillerItems / 3), index + 3)
  messages.push(message(`needle-${index}-1`, 'assistant', `Record B contains the exact value ${answers[1]}.`))
  addFiller(messages, Math.floor(fillerItems / 3), index + 7)
  messages.push(message(`needle-${index}-2`, 'user', `Record C contains the exact value ${answers[2]}.`))
  addFiller(messages, Math.ceil(fillerItems / 3), index + 13)
  const latestUserMessageId = `query-${index}`
  messages.push(message(latestUserMessageId, 'user', 'Return the three exact values in order, separated by commas.'))
  return { id: `niah-multi-${index}`, task: 'niah_multi', messages, latestUserMessageId, expectedAnswers: answers }
}

function createVariableTrackingCase(index: number, fillerItems: number): RulerCase {
  const first = 7 + index
  const second = first * 3
  const answer = String(second - 4)
  const messages: ContextMessage[] = [message('system', 'system', 'You are a benchmark answerer. Perform the variable updates exactly and answer only the final value.')]
  messages.push(message(`variable-${index}-0`, 'user', `Set variable counter = ${first}.`))
  addFiller(messages, fillerItems, index + 17)
  messages.push(message(`variable-${index}-1`, 'assistant', `Update counter = counter * 3, so counter is now ${second}.`))
  const latestUserMessageId = `query-${index}`
  messages.push(message(latestUserMessageId, 'user', 'Update counter = counter - 4. What is the final value? Reply with only the number.'))
  return { id: `variable-tracking-${index}`, task: 'variable_tracking', messages, latestUserMessageId, expectedAnswers: [answer] }
}

export function generateRulerCases(options: RulerGenerationOptions = {}): RulerCase[] {
  const tasks = options.tasks?.length ? options.tasks : [...RULER_TASKS]
  const samplesPerTask = Math.max(1, Math.floor(options.samplesPerTask ?? 1))
  const fillerItems = Math.max(0, Math.floor(options.fillerItems ?? 24))
  const cases: RulerCase[] = []
  for (const task of tasks) {
    for (let index = 0; index < samplesPerTask; index += 1) {
      cases.push(task === 'niah_single'
        ? createSingleNeedleCase(index, fillerItems)
        : task === 'niah_multi'
          ? createMultiNeedleCase(index, fillerItems)
          : createVariableTrackingCase(index, fillerItems))
    }
  }
  return cases
}

function normalizeAnswer(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[^a-z0-9, .-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function scoreRulerAnswer(answer: string, expectedAnswers: string[]): boolean {
  const normalized = normalizeAnswer(answer)
  if (expectedAnswers.length === 1) return normalized === normalizeAnswer(expectedAnswers[0])
  const positions = expectedAnswers.map((expected) => normalized.indexOf(normalizeAnswer(expected)))
  return positions.every((position) => position >= 0) && positions.every((position, index) => index === 0 || position >= positions[index - 1])
}

function endpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`
}

function responseText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.filter((part): part is { type?: string; text?: string } => Boolean(part && typeof part === 'object'))
    .map((part) => part.text ?? '')
    .join('')
}

export async function requestRulerModel(
  messages: ContextMessage[],
  remote: RulerRemoteConfig,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), remote.timeoutMs ?? 120_000)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(endpoint(remote.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${remote.apiKey}`,
      },
      body: JSON.stringify({
        model: remote.modelName,
        messages: toProviderMessages(messages),
        temperature: 0,
        max_tokens: remote.maxOutputTokens ?? 256,
      }),
      signal: controller.signal,
    })
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } }
    if (!response.ok) throw new Error(payload.error?.message || `Remote model request failed with HTTP ${response.status}`)
    const content = responseText(payload.choices?.[0]?.message?.content)
    if (!content) throw new Error('Remote model returned an empty response')
    return content
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
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

export async function runRulerEvaluation(options: RulerEvaluationOptions): Promise<RulerEvaluationResult> {
  const tasks = options.tasks?.length ? options.tasks : [...RULER_TASKS]
  const cases = generateRulerCases({ tasks, samplesPerTask: options.samplesPerTask, fillerItems: options.fillerItems })
  const strategies: RulerStrategy[] = options.rhaiScript ? ['builtin', 'rhai'] : ['builtin']
  const results: RulerCaseResult[] = []

  for (const currentCase of cases) {
    for (const strategy of strategies) {
      const config = evaluationConfig(options.modelConfig, {
        ...options.contextConfig,
        customStrategyEnabled: strategy === 'rhai',
        customStrategyScript: strategy === 'rhai' ? options.rhaiScript : '',
      })
      const originalTokens = countContextTokens(currentCase.messages)
      const started = performance.now()
      const rhaiStarted = performance.now()
      const contextResult = manageContext(currentCase.messages, [], options.modelConfig, config, {
        allowCustomStrategy: strategy === 'rhai',
        latestUserMessageId: currentCase.latestUserMessageId,
      })
      const rhaiMs = strategy === 'rhai' ? performance.now() - rhaiStarted : 0
      const contextBuildMs = performance.now() - started
      const compressedTokens = countContextTokens(contextResult.messages)
      const result: RulerCaseResult = {
        caseId: currentCase.id,
        task: currentCase.task,
        strategy,
        correct: false,
        answer: '',
        expectedAnswers: currentCase.expectedAnswers,
        originalTokens,
        compressedTokens,
        compressionRatio: compressedTokens ? originalTokens / compressedTokens : 1,
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
        result.correct = scoreRulerAnswer(result.answer, result.expectedAnswers)
      } catch (error) {
        result.error = error instanceof Error ? error.message : 'Remote model request failed'
      }
      results.push(result)
    }
  }

  const summary: RulerEvaluationResult['summary'] = {}
  for (const strategy of strategies) {
    const items = results.filter((result) => result.strategy === strategy)
    const average = (selector: (result: RulerCaseResult) => number) => items.length
      ? items.reduce((total, result) => total + selector(result), 0) / items.length : 0
    summary[strategy] = {
      cases: items.length,
      correct: items.filter((result) => result.correct).length,
      accuracy: items.length ? items.filter((result) => result.correct).length / items.length : 0,
      averageContextBuildMs: average((result) => result.contextBuildMs),
      averageRhaiMs: average((result) => result.rhaiMs),
      averageRemoteRequestMs: average((result) => result.remoteRequestMs),
      averageCompressionRatio: average((result) => result.compressionRatio),
    }
  }
  return {
    benchmark: 'ruler-subset',
    generatedAt: new Date().toISOString(),
    model: options.remote.modelName,
    tasks,
    strategies,
    results,
    summary,
  }
}



