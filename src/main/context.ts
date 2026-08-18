import { getEncoding } from 'js-tiktoken'
import type { ContextManagementConfig, ContextMetrics, ModelConfig } from '../shared/types'
import type { ToolCall } from './tools'

export type ContextMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

type TextPart = { text: string; protected: boolean }

export type ContextResult = {
  messages: ContextMessage[]
  metrics: ContextMetrics
}

const encoder = getEncoding('o200k_base')
const protectedBlockPattern = /```[\s\S]*?```|Traceback \(most recent call last\):[\s\S]*?(?=\n\n|$)|(?:^|\n)(?:Error|Exception|Caused by):[^\n]*(?:\n\s+at [^\n]*)*|(?:^|\n)(?:(?:\d{4}-\d{2}-\d{2}[T ][^\n]*)|(?:(?:\[[^\]\n]+\]\s*)?(?:DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b[^\n]*))/g

function countTokens(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length
}

function splitText(content: string): TextPart[] {
  const parts: TextPart[] = []
  let index = 0
  for (const match of content.matchAll(protectedBlockPattern)) {
    const start = match.index ?? 0
    if (start > index) {
      parts.push({ text: content.slice(index, start), protected: false })
    }
    parts.push({ text: match[0], protected: true })
    index = start + match[0].length
  }
  if (index < content.length) {
    parts.push({ text: content.slice(index), protected: false })
  }
  return parts
}

function filterNaturalLanguage(text: string): string {
  const seen = new Set<string>()
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => {
      if (!paragraph || seen.has(paragraph)) {
        return false
      }
      seen.add(paragraph)
      return true
    })
    .join('\n\n')
}

function rewriteNaturalLanguage(text: string): string {
  return text
    .replace(/\b(?:please|kindly|basically|actually|just)\b[:,]?\s*/gi, '')
    .replace(/(?:请注意|需要注意的是|简单来说|也就是)[，,:：]?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function transformMessage(
  message: ContextMessage,
  transform: (text: string) => string,
): ContextMessage {
  if (!message.content || message.role === 'system' || message.role === 'tool' || message.tool_calls) {
    return message
  }

  return {
    ...message,
    content: splitText(message.content)
      .map((part) => part.protected ? part.text : transform(part.text))
      .filter(Boolean)
      .join('\n\n'),
  }
}

function getRecentStart(messages: ContextMessage[], rounds: number): number {
  let userMessages = 0
  for (let index = messages.length - 1; index > 0; index -= 1) {
    if (messages[index].role === 'user') {
      userMessages += 1
      if (userMessages === rounds) {
        return index
      }
    }
  }
  return 1
}

function splitRounds(messages: ContextMessage[]): ContextMessage[][] {
  const rounds: ContextMessage[][] = []
  for (const message of messages) {
    if (message.role === 'user' || rounds.length === 0) {
      rounds.push([message])
    } else {
      rounds.at(-1)?.push(message)
    }
  }
  return rounds
}

function selectRecentRounds(rounds: ContextMessage[][], budget: number): {
  selected: ContextMessage[][]
  remaining: ContextMessage[][]
} {
  let tokens = 0
  let start = rounds.length
  while (start > 0) {
    const roundTokens = countTokens(rounds[start - 1])
    if (tokens + roundTokens > budget) {
      break
    }
    tokens += roundTokens
    start -= 1
  }
  return { selected: rounds.slice(start), remaining: rounds.slice(0, start) }
}

function queryTerms(messages: ContextMessage[]): string[] {
  const content = [...messages].reverse().find((message) => message.role === 'user')?.content?.toLowerCase() ?? ''
  const terms: string[] = content.match(/[a-z0-9_-]{2,}/g) ?? []
  for (const sequence of content.match(/\p{Script=Han}+/gu) ?? []) {
    if (sequence.length === 1) {
      terms.push(sequence)
      continue
    }
    for (let index = 0; index < sequence.length - 1; index += 1) {
      terms.push(sequence.slice(index, index + 2))
    }
  }
  return [...new Set(terms)].slice(0, 30)
}

function recallRounds(
  rounds: ContextMessage[][],
  terms: string[],
  budget: number,
): ContextMessage[][] {
  if (terms.length === 0 || budget <= 0) {
    return []
  }
  const ranked = rounds
    .map((round, index) => {
      const text = round.map((message) => message.content ?? '').join('\n').toLowerCase()
      return { round, index, score: terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0) }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)

  let tokens = 0
  const selected: typeof ranked = []
  for (const candidate of ranked) {
    const roundTokens = countTokens(candidate.round)
    if (tokens + roundTokens <= budget) {
      selected.push(candidate)
      tokens += roundTokens
    }
  }
  return selected.sort((left, right) => left.index - right.index).map(({ round }) => round)
}

function metrics(
  originalTokens: number,
  compressedTokens: number,
  modelConfig: ModelConfig,
  contextConfig: ContextManagementConfig,
  state: Pick<ContextMetrics, 'layered' | 'recalled' | 'filtered' | 'rewritten' | 'truncated'>,
): ContextMetrics {
  return {
    originalTokens,
    compressedTokens,
    modelMaxContext: modelConfig.modelMaxContext,
    triggerThreshold: Math.max(1, modelConfig.modelMaxContext - contextConfig.safeOutputMargin),
    compressionRatio: compressedTokens ? originalTokens / compressedTokens : 1,
    ...state,
  }
}

function manageSingleLayer(
  messages: ContextMessage[],
  tools: object[],
  modelConfig: ModelConfig,
  contextConfig: ContextManagementConfig,
): ContextResult {
  const triggerThreshold = Math.max(1, modelConfig.modelMaxContext - contextConfig.safeOutputMargin)
  const count = (items: ContextMessage[]) => countTokens({ messages: items, tools })
  const originalTokens = count(messages)
  let managed = messages
  let filtered = false
  let rewritten = false
  let truncated = false

  if (originalTokens >= triggerThreshold) {
    const recentStart = getRecentStart(messages, contextConfig.recentKeepRounds)
    const system = messages.slice(0, 1)
    let older = messages.slice(1, recentStart)
    const recent = messages.slice(recentStart)

    if (contextConfig.filterEnabled) {
      older = older.map((message) => transformMessage(message, filterNaturalLanguage))
      managed = [...system, ...older, ...recent]
      filtered = count(managed) < originalTokens
    }

    if (count(managed) >= triggerThreshold && contextConfig.rewriteEnabled) {
      const beforeRewrite = count(managed)
      older = older.map((message) => transformMessage(message, rewriteNaturalLanguage))
      managed = [...system, ...older, ...recent]
      rewritten = count(managed) < beforeRewrite
    }

    if (contextConfig.truncateEnabled) {
      const oldRounds = splitRounds(older)
      while (count(managed) >= triggerThreshold && oldRounds.length > 0) {
        oldRounds.shift()
        managed = [...system, ...oldRounds.flat(), ...recent]
        truncated = true
      }
    }
  }

  const compressedTokens = count(managed)
  return {
    messages: managed,
    metrics: metrics(originalTokens, compressedTokens, modelConfig, contextConfig, {
      layered: false,
      recalled: false,
      filtered,
      rewritten,
      truncated,
    }),
  }
}

function manageLayered(
  messages: ContextMessage[],
  tools: object[],
  modelConfig: ModelConfig,
  contextConfig: ContextManagementConfig,
): ContextResult {
  const triggerThreshold = Math.max(1, modelConfig.modelMaxContext - contextConfig.safeOutputMargin)
  const count = (items: ContextMessage[]) => countTokens({ messages: items, tools })
  const originalTokens = count(messages)
  const recentStart = getRecentStart(messages, contextConfig.recentKeepRounds)
  const system = messages.slice(0, 1)
  const hot = messages.slice(recentStart)
  const coldRounds = splitRounds(messages.slice(1, recentStart))
  const reservedHotTokens = Math.max(
    countTokens(hot),
    Math.min(contextConfig.hotTokenBudget, triggerThreshold),
  )
  const warmBudget = Math.min(
    contextConfig.warmTokenBudget,
    Math.max(0, triggerThreshold - countTokens({ messages: system, tools }) - reservedHotTokens),
  )
  const recallBudget = Math.min(contextConfig.coldRecallTokenBudget, warmBudget)
  const warmSelection = selectRecentRounds(coldRounds, Math.max(0, warmBudget - recallBudget))
  const recalledRounds = recallRounds(warmSelection.remaining, queryTerms(hot), recallBudget)
  let warm = [...recalledRounds, ...warmSelection.selected].flat()
  let managed = [...system, ...warm, ...hot]
  let filtered = false
  let rewritten = false
  let truncated = false

  if (count(managed) >= triggerThreshold && contextConfig.filterEnabled) {
    const transformed = warm.map((message) => transformMessage(message, filterNaturalLanguage))
    filtered = count(transformed) < count(warm)
    warm = transformed
    managed = [...system, ...warm, ...hot]
  }

  if (count(managed) >= triggerThreshold && contextConfig.rewriteEnabled) {
    const beforeRewrite = count(managed)
    warm = warm.map((message) => transformMessage(message, rewriteNaturalLanguage))
    managed = [...system, ...warm, ...hot]
    rewritten = count(managed) < beforeRewrite
  }

  if (contextConfig.truncateEnabled) {
    const warmRounds = splitRounds(warm)
    while (count(managed) >= triggerThreshold && warmRounds.length > 0) {
      warmRounds.shift()
      managed = [...system, ...warmRounds.flat(), ...hot]
      truncated = true
    }
  }

  const compressedTokens = count(managed)
  return {
    messages: managed,
    metrics: metrics(originalTokens, compressedTokens, modelConfig, contextConfig, {
      layered: true,
      recalled: recalledRounds.length > 0,
      filtered,
      rewritten,
      truncated,
    }),
  }
}

export function manageContext(
  messages: ContextMessage[],
  tools: object[],
  modelConfig: ModelConfig,
  contextConfig: ContextManagementConfig,
): ContextResult {
  return contextConfig.layeredEnabled
    ? manageLayered(messages, tools, modelConfig, contextConfig)
    : manageSingleLayer(messages, tools, modelConfig, contextConfig)
}
