import type { ImageAttachment } from '../shared/image-attachments'
import type { ContextManagementConfig, ContextMetrics, ContextRepresentation, ContextSummaryArtifact, ModelConfig } from '../shared/types'
import type { ToolCall } from './tools'
import { countContextMessageTokens, countContextTokens, createContextTokenCounter, normalizeToolCallSequence } from './context-utils'
import { applyCustomRhaiStrategy } from './rhai-strategy'
export { countContextMessageTokens, countContextTokens, normalizeToolCallSequence } from './context-utils'

export type ContextMessage = {
  id?: string
  createdAt?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  images?: ImageAttachment[]
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
  enteredHotAt?: string
  reuseCount?: number
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
  hotTokenBudget?: number
  hotHighWatermark?: number
  hotLowWatermark?: number
  overflow?: {
    reason: 'latest_user_too_large' | 'pinned_hot_overflow' | 'current_round_too_large' | 'hot_overflow'
    requiredReleaseTokens: number
  }
}

export const SUMMARY_LABEL = '[SUMMARY — LOSSY, NOT AUTHORITATIVE]'
const protectedBlockPattern = /```[\s\S]*?```|Traceback \(most recent call\):[\s\S]*?(?=\n\n|$)|(?:^|\n)(?:Error|Exception|Caused by):[^\n]*(?:\n\s+at [^\n]*)*|(?:^|\n)(?:(?:\d{4}-\d{2}-\d{2}[T ][^\n]*)|(?:(?:\[[^\]\n]+\]\s*)?(?:DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b[^\n]*))/g

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

function timestamp(value?: string): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizedContent(message: ContextMessage): string {
  return `${message.role}:${message.content ?? ''}`.replace(/\r\n/g, '\n').trim()
}

function replaceableIds(messages: ContextMessage[]): Set<string> {
  const replaceable = new Set<string>()
  const latestByContent = new Map<string, ContextMessage>()
  const originalTruthRefs = new Set(messages.filter((message) => message.representation !== 'summary').flatMap(refsFor))
  for (const message of messages) {
    const key = normalizedContent(message)
    const previous = latestByContent.get(key)
    if (previous?.id) replaceable.add(previous.id)
    latestByContent.set(key, message)
    if (message.representation === 'summary' && refsFor(message).some((ref) => originalTruthRefs.has(ref)) && message.id) {
      replaceable.add(message.id)
    }
  }
  return replaceable
}

export function contextImportanceScore(message: ContextMessage, replaceable = false, now = Date.now()): number {
  const sourceScore = message.role === 'tool' ? 24
    : message.tool_calls?.length ? 22
      : message.role === 'user' ? 18
        : message.representation === 'summary' ? 6 : 12
  const enteredAgeDays = Math.max(0, (now - timestamp(message.enteredHotAt ?? message.createdAt)) / 86_400_000)
  const accessedAgeDays = Math.max(0, (now - timestamp(message.lastAccessedAt)) / 86_400_000)
  const enteredScore = Math.max(0, 20 - Math.floor(enteredAgeDays))
  const accessedScore = message.lastAccessedAt ? Math.max(0, 12 - Math.floor(accessedAgeDays)) : 0
  const reuseScore = Math.min(5, Math.max(0, message.reuseCount ?? 0)) * 3
  return sourceScore + enteredScore + accessedScore + reuseScore - (replaceable ? 20 : 0)
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

function splitClosedUnits(messages: ContextMessage[]): { units: ContextMessage[][]; hasOpenTail: boolean } {
  const units: ContextMessage[][] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const expected = new Set(message.tool_calls.map((toolCall) => toolCall.id))
      const unit = [message]
      let next = index + 1
      while (next < messages.length && messages[next].role === 'tool') {
        unit.push(messages[next])
        next += 1
      }
      const received = new Set(unit.slice(1).map((item) => item.tool_call_id))
      const complete = unit.length - 1 === expected.size
        && expected.size === received.size
        && [...expected].every((id) => received.has(id))
      if (!complete) return { units, hasOpenTail: true }
      units.push(unit)
      index = next - 1
    } else if (message.role === 'tool') {
      return { units, hasOpenTail: true }
    } else {
      units.push([message])
    }
  }
  return { units, hasOpenTail: false }
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
    originalTokens: countContextMessageTokens(message),
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
  const counter = createContextTokenCounter(tools)
  const originalTokens = counter.request(messages)
  let managed = messages
  let filtered = false
  let rewritten = false
  let truncated = false
  if (originalTokens >= triggerThreshold) {
    const recentStart = getRecentStart(messages, contextConfig.recentKeepRounds)
    const system = messages.slice(0, 1)
    let older = messages.slice(1, recentStart)
    const recent = messages.slice(recentStart)
    const systemTokens = counter.messages(system)
    const recentTokens = counter.messages(recent)
    let olderTokens = counter.messages(older)
    let managedMessageTokens = systemTokens + olderTokens + recentTokens
    const managedTokens = () => counter.requestBaseTokens + managedMessageTokens

    if (contextConfig.filterEnabled) {
      const before = olderTokens
      older = older.map((message) => transformMessage(message, filterNaturalLanguage))
      managed = [...system, ...older, ...recent]
      olderTokens = counter.messages(older)
      managedMessageTokens = systemTokens + olderTokens + recentTokens
      filtered = olderTokens < before
    }
    if (managedTokens() >= triggerThreshold && contextConfig.rewriteEnabled) {
      const before = olderTokens
      older = older.map((message) => transformMessage(message, rewriteNaturalLanguage))
      managed = [...system, ...older, ...recent]
      olderTokens = counter.messages(older)
      managedMessageTokens = systemTokens + olderTokens + recentTokens
      rewritten = olderTokens < before
    }
    if (contextConfig.truncateEnabled) {
      const rounds = splitRounds(older)
      while (managedTokens() >= triggerThreshold && rounds.length > 0) {
        const removed = rounds.shift() ?? []
        olderTokens -= counter.messages(removed)
        managedMessageTokens = systemTokens + olderTokens + recentTokens
        managed = [...system, ...rounds.flat(), ...recent]
        truncated = true
      }
    }
  }
  const sendable = normalizeToolCallSequence(managed)
  const compressedTokens = counter.request(sendable)
  return {
    messages: sendable,
    warmMessages: [],
    summaryArtifacts: [],
    metrics: metrics(originalTokens, compressedTokens, modelConfig, contextConfig, { layered: false, recalled: false, filtered, rewritten, truncated }),
    toolDefinitionTokens: counter.toolDefinitionTokens,
  }
}

function manageLayered(messages: ContextMessage[], tools: object[], modelConfig: ModelConfig, contextConfig: ContextManagementConfig, runtime: ContextManagementRuntime): ContextResult {
  const triggerThreshold = Math.max(1, modelConfig.modelMaxContext - contextConfig.safeOutputMargin)
  const counter = createContextTokenCounter(tools)
  const toolDefinitionTokens = counter.toolDefinitionTokens
  const hotBudget = Math.max(1, Math.min(contextConfig.hotTokenBudget, triggerThreshold - toolDefinitionTokens))
  const highWatermark = Math.max(1, Math.floor(hotBudget * 0.9))
  const lowWatermark = Math.max(1, Math.floor(hotBudget * 0.8))
  const requestCount = (items: ContextMessage[]) => counter.request(items)
  const layerCount = (items: ContextMessage[]) => counter.layer(items)
  const messageCount = (items: ContextMessage[]) => counter.messages(items)
  const originalTokens = requestCount(messages)
  const now = new Date().toISOString()
  const system = messages.filter((message) => message.role === 'system').map((message) => ({
    ...message,
    contextLayer: 'hot' as const,
    contextRegion: 'permanent' as const,
    contextSource: 'live' as const,
    representation: 'original' as const,
    enteredHotAt: message.enteredHotAt ?? message.createdAt ?? now,
  }))
  const nonSystem = messages.filter((message) => message.role !== 'system')
  const explicitWarm = nonSystem.filter((message) => !isResident(message) && (message.contextLayer === 'warm' || message.manualContextLayer === 'warm'))
  const recalled = nonSystem.filter((message) => isRecalled(message) && !explicitWarm.includes(message))
  const eligible = nonSystem.filter((message) => !explicitWarm.includes(message) && !recalled.includes(message))
  let currentStart = runtime.latestUserMessageId
    ? eligible.findIndex((message) => message.id === runtime.latestUserMessageId && message.role === 'user')
    : -1
  if (currentStart < 0) {
    currentStart = eligible.reduce((found, message, index) => message.role === 'user' ? index : found, 0)
  }
  const historical = eligible.slice(0, currentStart)
  const current = eligible.slice(currentStart)
  const warmCandidates = [...explicitWarm]
  const toHot = (message: ContextMessage, fresh = false): ContextMessage => ({
    ...message,
    contextLayer: 'hot',
    contextRegion: message.contextRegion ?? (isLongTermCandidate(message) ? 'long-term' : 'newborn'),
    contextSource: message.contextSource ?? 'live',
    representation: message.representation ?? 'original',
    truthRefs: refsFor(message),
    enteredHotAt: fresh ? now : message.enteredHotAt ?? message.createdAt ?? now,
    reuseCount: Math.max(0, message.reuseCount ?? 0),
  })
  const historicalHot = historical.map((message) => toHot(message))
  const currentHot = current.map((message) => toHot(message))
  let hot = [...historicalHot, ...currentHot]
  let hotMessageTokens = messageCount(system) + messageCount(hot)
  const hotTokens = () => counter.layerBaseTokens + hotMessageTokens
  const hotRequestTokens = () => counter.requestBaseTokens + hotMessageTokens
  const fitsHardLimit = () => hotTokens() < hotBudget && hotRequestTokens() < triggerThreshold
  const replacementSet = replaceableIds([...historicalHot, ...recalled, ...currentHot])
  const demote = (items: ContextMessage[]): void => {
    const selected = new Set(items)
    hot = hot.filter((message) => !selected.has(message))
    hotMessageTokens -= messageCount(items)
    warmCandidates.push(...items)
  }
  const historicalCandidates = splitRounds(historicalHot)
    .map((round) => splitClosedUnits(round).units
      .filter((unit) => unit.every((message) => !isResident(message)))
      .flat())
    .filter((round) => round.length > 0)
    .map((round) => ({
      messages: round,
      score: Math.max(...round.map((message) => contextImportanceScore(message, Boolean(message.id && replacementSet.has(message.id))))),
      lastAccessedAt: Math.max(...round.map((message) => timestamp(message.lastAccessedAt))),
      enteredHotAt: Math.max(...round.map((message) => timestamp(message.enteredHotAt ?? message.createdAt))),
      tokens: messageCount(round),
    }))
    .sort((left, right) => left.score - right.score || left.lastAccessedAt - right.lastAccessedAt || left.enteredHotAt - right.enteredHotAt || right.tokens - left.tokens)

  if (hotTokens() >= highWatermark) {
    for (const candidate of historicalCandidates) {
      if (hotTokens() <= lowWatermark) break
      demote(candidate.messages)
    }
  }

  for (const message of recalled) {
    const promoted = toHot(message, !message.enteredHotAt)
    const insertAt = Math.max(0, hot.length - currentHot.filter((item) => hot.includes(item)).length)
    hot.splice(insertAt, 0, promoted)
    hotMessageTokens += counter.message(promoted)
    if (hotTokens() > highWatermark || !fitsHardLimit()) {
      hot.splice(hot.indexOf(promoted), 1)
      hotMessageTokens -= counter.message(promoted)
      if (message.contextSource === 'warm-recall') warmCandidates.push({ ...message, contextLayer: 'warm', contextSource: 'hot-demotion' })
    }
  }

  const latestUser = runtime.latestUserMessageId
    ? hot.find((message) => message.id === runtime.latestUserMessageId && message.role === 'user')
    : currentHot.find((message) => message.role === 'user')
  const latestOnlyMessageTokens = messageCount(system) + (latestUser ? counter.message(latestUser) : 0)
  const latestOnlyLayerTokens = counter.layerBaseTokens + latestOnlyMessageTokens
  const latestOnlyRequestTokens = counter.requestBaseTokens + latestOnlyMessageTokens
  let overflow: ContextResult['overflow']
  if (latestUser && (latestOnlyLayerTokens >= hotBudget || latestOnlyRequestTokens >= triggerThreshold)) {
    overflow = {
      reason: 'latest_user_too_large',
      requiredReleaseTokens: Math.max(1, latestOnlyLayerTokens - hotBudget + 1, latestOnlyRequestTokens - triggerThreshold + 1),
    }
  }

  if (!overflow && !fitsHardLimit()) {
    const currentInHot = currentHot.filter((message) => hot.includes(message))
    const { units, hasOpenTail } = splitClosedUnits(currentInHot.slice(1))
    const demotableUnits = (hasOpenTail ? units : units.slice(0, -1))
      .filter((unit) => unit.every((message) => !isResident(message)))
    for (const unit of demotableUnits) {
      if (hotTokens() <= highWatermark && fitsHardLimit()) break
      demote(unit)
    }
  }

  if (!overflow && !fitsHardLimit()) {
    const pinnedBlockers = hot.some((message) => message.pinnedToHot === true)
    overflow = {
      reason: pinnedBlockers ? 'pinned_hot_overflow' : current.length > 1 ? 'current_round_too_large' : 'hot_overflow',
      requiredReleaseTokens: Math.max(1, hotTokens() - hotBudget + 1, hotRequestTokens() - triggerThreshold + 1),
    }
  }

  const managed = normalizeToolCallSequence([...system, ...hot])
  let filtered = false
  let rewritten = false
  const warmMessages: ContextMessage[] = []
  const summaryArtifacts: ContextSummaryArtifact[] = []
  let warmTokens = 0
  const warmById = new Map<string, ContextMessage>()
  for (const message of warmCandidates) warmById.set(message.id ?? `${message.role}:${message.createdAt ?? ''}:${warmById.size}`, message)
  const orderedWarm = [...warmById.values()].sort((left, right) => messages.indexOf(left) - messages.indexOf(right))
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
    const tokenCount = counter.message(prepared)
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

  const compressedTokens = counter.request(managed)
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
    toolDefinitionTokens,
    hotTokenBudget: hotBudget,
    hotHighWatermark: highWatermark,
    hotLowWatermark: lowWatermark,
    overflow,
  }
}
export type ContextManagementRuntime = {
  allowCustomStrategy?: boolean
  latestUserMessageId?: string
}

export function manageContext(
  messages: ContextMessage[],
  tools: object[],
  modelConfig: ModelConfig,
  contextConfig: ContextManagementConfig,
  runtime: ContextManagementRuntime = {},
): ContextResult {
  const customMessages = applyCustomRhaiStrategy(messages, tools, modelConfig, contextConfig, runtime)
  if (customMessages) {
    const counter = createContextTokenCounter(tools)
    const originalTokens = counter.request(messages)
    const compressedTokens = counter.request(customMessages)
    return {
      messages: customMessages.map((message) => ({
        ...message,
        contextLayer: 'hot',
        contextSource: message.contextSource ?? 'live',
        representation: message.representation ?? 'original',
      })),
      warmMessages: [],
      summaryArtifacts: [],
      metrics: metrics(originalTokens, compressedTokens, modelConfig, contextConfig, {
        layered: contextConfig.layeredEnabled,
        recalled: customMessages.some((message) => ['warm-recall', 'cold-summary-recall', 'cold-truth-recall', 'cold-recall'].includes(message.contextSource ?? '')),
        filtered: false,
        rewritten: false,
        truncated: false,
      }),
      toolDefinitionTokens: counter.toolDefinitionTokens,
    }
  }
  return contextConfig.layeredEnabled ? manageLayered(messages, tools, modelConfig, contextConfig, runtime) : manageSingleLayer(messages, tools, modelConfig, contextConfig)
}
