import { getEncoding } from 'js-tiktoken'
import type { ContextManagementConfig, ContextMetrics, ContextRepresentation, ContextSummaryArtifact, ModelConfig } from '../shared/types'
import type { ToolCall } from './tools'

export type ContextMessage = {
  id?: string
  createdAt?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  pinnedToHot?: boolean
  representation?: ContextRepresentation
  truthRefs?: string[]
  contextLayer?: 'hot' | 'warm'
  contextRegion?: 'permanent' | 'long-term' | 'newborn'
  contextSource?: 'live' | 'hot-demotion' | 'warm-recall' | 'cold-summary-recall' | 'cold-truth-recall' | 'hot' | 'warm' | 'cold-recall'
  recalledAtRoundId?: string
  lastAccessedAt?: string
  manualContextLayer?: 'warm'
  /** Legacy persisted values, accepted only for migration. */
  manualProtected?: boolean
  protection?: 'none' | 'partial' | 'full'
}

type TextPart = { text: string; protected: boolean }

export type ContextResult = {
  /** Only Hot is sent to the model. */
  messages: ContextMessage[]
  /** Warm is diagnostic working memory and is never sent directly. */
  warmMessages: ContextMessage[]
  summaryArtifacts: ContextSummaryArtifact[]
  metrics: ContextMetrics
  toolDefinitionTokens: number
}

export const SUMMARY_LABEL = '[SUMMARY — LOSSY, NOT AUTHORITATIVE]'
const encoder = getEncoding('o200k_base')
const protectedBlockPattern = /```[\s\S]*?```|Traceback \(most recent call\):[\s\S]*?(?=\n\n|$)|(?:^|\n)(?:Error|Exception|Caused by):[^\n]*(?:\n\s+at [^\n]*)*|(?:^|\n)(?:(?:\d{4}-\d{2}-\d{2}[T ][^\n]*)|(?:(?:\[[^\]\n]+\]\s*)?(?:DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b[^\n]*))/g

export function countContextTokens(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length
}

function isPinned(message: ContextMessage): boolean {
  return message.role === 'system' || message.pinnedToHot === true
}

function isLongTermCandidate(message: ContextMessage): boolean {
  return message.role === 'user' && /(?:\b(?:i|we)\s+(?:prefer|like|always use|usually use|do not want)|我(?:喜欢|偏好|习惯|希望)|请(?:始终|以后|默认)|不要再用|不要使用)/i.test(message.content ?? '')
}

function isResident(message: ContextMessage): boolean {
  return isPinned(message) || message.contextRegion === 'long-term' || isLongTermCandidate(message)
}

function isRecalled(message: ContextMessage): boolean {
  return ['warm-recall', 'cold-summary-recall', 'cold-truth-recall', 'cold-recall'].includes(message.contextSource ?? '')
}

/** Remove incomplete tool-call blocks before sending messages to a Chat Completions provider. */
export function normalizeToolCallSequence(messages: ContextMessage[]): ContextMessage[] {
  const result: ContextMessage[] = []
  let changed = false
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role === 'tool') {
      changed = true
      continue
    }
    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      result.push(message)
      continue
    }

    const expected = new Set(message.tool_calls.map((toolCall) => toolCall.id))
    const responses: ContextMessage[] = []
    let next = index + 1
    while (next < messages.length && messages[next].role === 'tool') {
      responses.push(messages[next])
      next += 1
    }
    const received = new Set(responses.map((response) => response.tool_call_id))
    const complete = expected.size > 0
      && received.size === expected.size
      && [...expected].every((id) => received.has(id))
      && responses.every((response) => response.tool_call_id && expected.has(response.tool_call_id))

    if (complete) {
      result.push(message, ...responses)
    } else if (message.content) {
      changed = true
      result.push({ ...message, tool_calls: undefined })
    } else {
      changed = true
    }
    index = next - 1
  }
  return changed ? result : messages
}

function refsFor(message: ContextMessage): string[] {
  return message.truthRefs?.length ? message.truthRefs : message.id ? [message.id] : []
}

function splitText(content: string): TextPart[] {
  const parts: TextPart[] = []
  let index = 0
  for (const match of content.matchAll(protectedBlockPattern)) {
    const start = match.index ?? 0
    if (start > index) parts.push({ text: content.slice(index, start), protected: false })
    parts.push({ text: match[0], protected: true })
    index = start + match[0].length
  }
  if (index < content.length) parts.push({ text: content.slice(index), protected: false })
  return parts
}

function filterNaturalLanguage(text: string): string {
  const seen = new Set<string>()
  return text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter((paragraph) => {
    if (!paragraph || seen.has(paragraph)) return false
    seen.add(paragraph)
    return true
  }).join('\n\n')
}

function rewriteNaturalLanguage(text: string): string {
  return text
    .replace(/\b(?:please|kindly|basically|actually|just)\b[:,]?\s*/gi, '')
    .replace(/(?:请注意|需要注意的是|简单来说|也就是)[，,:：]?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function transformMessage(message: ContextMessage, transform: (text: string) => string): ContextMessage {
  if (!message.content || message.role === 'system' || message.role === 'tool' || message.tool_calls || isResident(message) || message.representation === 'summary') return message
  const content = splitText(message.content).map((part) => part.protected ? part.text : transform(part.text)).filter(Boolean).join('\n\n')
  return content === message.content ? message : { ...message, content }
}

function splitRounds(messages: ContextMessage[]): ContextMessage[][] {
  const rounds: ContextMessage[][] = []
  for (const message of messages) {
    if (message.role === 'user' || rounds.length === 0) rounds.push([message])
    else rounds.at(-1)?.push(message)
  }
  return rounds
}

function getRecentStart(messages: ContextMessage[], rounds: number): number {
  let userMessages = 0
  for (let index = messages.length - 1; index > 0; index -= 1) {
    if (messages[index].role === 'user') {
      userMessages += 1
      if (userMessages === rounds) return index
    }
  }
  return 1
}

function labelSummary(content: string, refs: string[]): string {
  if (content.startsWith(SUMMARY_LABEL)) return content
  return [
    SUMMARY_LABEL,
    'This content is compressed and may omit details. It is not an authoritative source.',
    'Use context_read with a truth reference before relying on exact wording, code, logs, dates, numbers, versions, or tool data.',
    `Truth references: ${refs.join(', ') || 'unavailable'}`,
    '',
    content,
  ].join('\n')
}

function summaryMessage(original: ContextMessage, content: string): ContextMessage {
  const truthRefs = refsFor(original)
  return {
    ...original,
    content: labelSummary(content, truthRefs),
    representation: 'summary',
    truthRefs,
    contextLayer: 'warm',
    contextSource: original.contextSource === 'cold-summary-recall' ? 'cold-summary-recall' : 'hot-demotion',
  }
}

function stableSummaryId(ids: string[], content: string): string {
  let hash = 2166136261
  for (const character of `${ids.join('|')}|${content}`) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `summary-${(hash >>> 0).toString(16)}`
}

function buildSummaryArtifact(message: ContextMessage, content: string, method: string): ContextSummaryArtifact {
  const sourceMessageIds = refsFor(message)
  const body = labelSummary(content, sourceMessageIds)
  const createdAt = new Date().toISOString()
  return {
    id: stableSummaryId(sourceMessageIds, body),
    role: message.role === 'system' ? 'assistant' : message.role,
    content: body,
    sourceMessageIds,
    sourcePointers: sourceMessageIds.map((id) => `messages.jsonl#id=${id}`),
    timeRange: { from: message.createdAt ?? createdAt, to: message.createdAt ?? createdAt },
    compressionMethod: method,
    originalTokens: countContextTokens(message),
    compressedTokens: countContextTokens(body),
    generation: 1,
    createdAt,
  }
}

function metrics(originalTokens: number, compressedTokens: number, modelConfig: ModelConfig, contextConfig: ContextManagementConfig, state: Pick<ContextMetrics, 'layered' | 'recalled' | 'filtered' | 'rewritten' | 'truncated'>): ContextMetrics {
  return {
    originalTokens,
    compressedTokens,
    modelMaxContext: modelConfig.modelMaxContext,
    triggerThreshold: Math.max(1, modelConfig.modelMaxContext - contextConfig.safeOutputMargin),
    compressionRatio: compressedTokens ? originalTokens / compressedTokens : 1,
    ...state,
  }
}

function manageSingleLayer(messages: ContextMessage[], tools: object[], modelConfig: ModelConfig, contextConfig: ContextManagementConfig): ContextResult {
  const triggerThreshold = Math.max(1, modelConfig.modelMaxContext - contextConfig.safeOutputMargin)
  const count = (items: ContextMessage[]) => countContextTokens({ messages: items, tools })
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
      const before = count(older)
      older = older.map((message) => transformMessage(message, filterNaturalLanguage))
      managed = [...system, ...older, ...recent]
      filtered = count(older) < before
    }
    if (count(managed) >= triggerThreshold && contextConfig.rewriteEnabled) {
      const before = count(managed)
      older = older.map((message) => transformMessage(message, rewriteNaturalLanguage))
      managed = [...system, ...older, ...recent]
      rewritten = count(managed) < before
    }
    if (contextConfig.truncateEnabled) {
      const rounds = splitRounds(older)
      while (count(managed) >= triggerThreshold && rounds.length > 0) {
        rounds.shift()
        managed = [...system, ...rounds.flat(), ...recent]
        truncated = true
      }
    }
  }
  const sendable = normalizeToolCallSequence(managed)
  const compressedTokens = count(sendable)
  return {
    messages: sendable,
    warmMessages: [],
    summaryArtifacts: [],
    metrics: metrics(originalTokens, compressedTokens, modelConfig, contextConfig, { layered: false, recalled: false, filtered, rewritten, truncated }),
    toolDefinitionTokens: countContextTokens(tools),
  }
}

function manageLayered(messages: ContextMessage[], tools: object[], modelConfig: ModelConfig, contextConfig: ContextManagementConfig): ContextResult {
  const triggerThreshold = Math.max(1, modelConfig.modelMaxContext - contextConfig.safeOutputMargin)
  const hotBudget = Math.max(1, Math.min(contextConfig.hotTokenBudget, triggerThreshold))
  const requestCount = (items: ContextMessage[]) => countContextTokens({ messages: items, tools })
  const layerCount = (items: ContextMessage[]) => countContextTokens(items)
  const originalTokens = requestCount(messages)
  const system = messages.filter((message) => message.role === 'system').map((message) => ({
    ...message,
    contextLayer: 'hot' as const,
    contextRegion: 'permanent' as const,
    contextSource: 'live' as const,
    representation: 'original' as const,
  }))
  const nonSystem = messages.filter((message) => message.role !== 'system')
  const explicitWarm = nonSystem.filter((message) => !isResident(message) && (message.contextLayer === 'warm' || message.manualContextLayer === 'warm'))
  const recalled = nonSystem.filter((message) => isRecalled(message))
  const eligible = nonSystem.filter((message) => !explicitWarm.includes(message) && !recalled.includes(message))
  const recentStart = getRecentStart([{ role: 'system', content: null }, ...eligible], contextConfig.recentKeepRounds) - 1
  const older = eligible.slice(0, Math.max(0, recentStart))
  const recent = eligible.slice(Math.max(0, recentStart))
  const warmCandidates = [...explicitWarm]
  const toHot = (message: ContextMessage): ContextMessage => ({
    ...message,
    contextLayer: 'hot',
    contextRegion: message.contextRegion ?? (isLongTermCandidate(message) ? 'long-term' : 'newborn'),
    contextSource: message.contextSource ?? 'live',
    representation: message.representation ?? 'original',
    truthRefs: refsFor(message),
  })
  let hot = [...older, ...recent].map(toHot)
  for (const round of splitRounds(older)) {
    if (requestCount([...system, ...hot]) < triggerThreshold && layerCount(hot) <= hotBudget) break
    const demoted = round.filter((message) => !isResident(message) && !isRecalled(message))
    if (demoted.length === 0) continue
    const ids = new Set(demoted.map((message) => message.id))
    hot = hot.filter((message) => !ids.has(message.id))
    warmCandidates.push(...demoted)
  }
  for (const message of recalled) {
    const candidate = [...hot, toHot(message)]
    if (requestCount([...system, ...candidate]) >= triggerThreshold || layerCount(candidate) > hotBudget) continue
    hot = candidate
  }
  const managed = normalizeToolCallSequence([...system, ...hot])

  let filtered = false
  let rewritten = false
  const warmMessages: ContextMessage[] = []
  const summaryArtifacts: ContextSummaryArtifact[] = []
  let warmTokens = 0
  const orderedWarm = [...new Set(warmCandidates)].sort((left, right) => messages.indexOf(left) - messages.indexOf(right))
  for (let index = orderedWarm.length - 1; index >= 0; index -= 1) {
    const original = orderedWarm[index]
    const prepared: ContextMessage = {
      ...original,
      contextLayer: 'warm',
      contextRegion: original.contextRegion ?? 'newborn',
      contextSource: original.contextSource === 'cold-summary-recall' ? 'cold-summary-recall' : 'hot-demotion',
      representation: original.representation ?? 'original',
      truthRefs: refsFor(original),
    }
    const tokenCount = countContextTokens(prepared)
    if (warmTokens + tokenCount <= contextConfig.warmTokenBudget) {
      warmMessages.unshift(prepared)
      warmTokens += tokenCount
      continue
    }

    let transformed = original
    const methods: string[] = []
    if (contextConfig.filterEnabled) {
      const next = transformMessage(transformed, filterNaturalLanguage)
      if (next !== transformed) {
        filtered = true
        methods.push('filter')
      }
      transformed = next
    }
    if (contextConfig.rewriteEnabled) {
      const next = transformMessage(transformed, rewriteNaturalLanguage)
      if (next !== transformed) {
        rewritten = true
        methods.push('rewrite')
      }
      transformed = next
    }
    const fallback = `A ${original.role} message was removed from Warm memory. Read the referenced Cold truth record for its exact content.`
    summaryArtifacts.unshift(buildSummaryArtifact(original, transformed.content !== original.content ? transformed.content ?? fallback : fallback, methods.join('/') || 'locator'))
  }

  const compressedTokens = requestCount(managed)
  return {
    messages: managed,
    warmMessages,
    summaryArtifacts,
    metrics: metrics(originalTokens, compressedTokens, modelConfig, contextConfig, {
      layered: true,
      recalled: hot.some((message) => ['cold-summary-recall', 'cold-truth-recall', 'cold-recall', 'warm-recall'].includes(message.contextSource ?? '')),
      filtered,
      rewritten,
      truncated: false,
    }),
    toolDefinitionTokens: countContextTokens(tools),
  }
}
export function manageContext(messages: ContextMessage[], tools: object[], modelConfig: ModelConfig, contextConfig: ContextManagementConfig): ContextResult {
  return contextConfig.layeredEnabled ? manageLayered(messages, tools, modelConfig, contextConfig) : manageSingleLayer(messages, tools, modelConfig, contextConfig)
}
