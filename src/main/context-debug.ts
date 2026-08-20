import { randomUUID } from 'node:crypto'
import type {
  AgentContextMessage,
  ContextAuditEvent,
  ContextDebugMessage,
  ContextDebugOverview,
  ContextDebugSnapshot,
  ContextLayerItem,
  ContextSource,
  ContextSummaryArtifact,
  ColdRecallPreview,
  ColdIndexItem,
  ConversationRuntimeState,
  TokenLimitSimulation,
} from '../shared/types'
import { countContextTokens, type ContextMessage, type ContextResult } from './context'
import {
  appendConversationMessages,
  appendConversationSummaries,
  getConversationStorageRevision,
  readConversationIndex,
  readConversationMessage,
  readConversationStorageOverview,
  readConversationSummaryIndex,
  readContextRecords,
  searchConversationContext,
  updateConversationLayer,
  updateConversationPin,
} from './conversation-store'
import { getProject, updateConversationAgentMessages } from './workspace'

const snapshots = new Map<string, ContextDebugSnapshot>()
const snapshotMessages = new Map<string, Map<string, ContextDebugMessage>>()
const audits = new Map<string, ContextAuditEvent[]>()

function key(projectId: string, conversationId: string): string { return `${projectId}:${conversationId}` }

function sourceOf(message: ContextMessage): ContextSource {
  return message.contextSource ?? 'live'
}

function toItem(message: ContextMessage, source: ContextLayerItem['source']): ContextLayerItem {
  const id = message.id ?? randomUUID()
  const representation = message.representation ?? 'original'
  const pinnedToHot = message.role === 'system' || message.pinnedToHot === true
  return {
    id,
    role: message.role,
    tokenCount: countContextTokens(message),
    createdAt: message.createdAt ?? new Date(0).toISOString(),
    preview: (message.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
    pinnedToHot,
    representation,
    truthRefs: message.truthRefs?.length ? message.truthRefs : [id],
    region: message.contextRegion ?? (message.role === 'system' ? 'permanent' : 'newborn'),
    source,
    pendingDemotion: false,
  }
}

function addAudit(projectId: string, conversationId: string, event: Omit<ContextAuditEvent, 'id' | 'timestamp' | 'projectId' | 'conversationId'>): void {
  const storageKey = key(projectId, conversationId)
  const list = audits.get(storageKey) ?? []
  list.push({ ...event, id: randomUUID(), timestamp: new Date().toISOString(), projectId, conversationId })
  audits.set(storageKey, list.slice(-300))
}

export function buildContextDebugSnapshot(result: ContextResult, config: import('../shared/types').ContextManagementConfig, requestId = randomUUID(), roundId = requestId): ContextDebugSnapshot {
  const system = result.messages.filter((message) => message.role === 'system')
  const hot = result.messages.filter((message) => message.role !== 'system')
  const hotItems = [...system.map((message) => toItem(message, 'system')), ...hot.map((message) => toItem(message, sourceOf(message)))]
  const warmItems = result.warmMessages.map((message) => toItem(message, sourceOf(message) === 'cold-summary-recall' ? 'cold-summary-recall' : 'hot-demotion'))
  const pinnedHotTokens = hotItems.filter((item) => item.pinnedToHot).reduce((sum, item) => sum + item.tokenCount, 0)
  return {
    requestId,
    roundId,
    createdAt: new Date().toISOString(),
    modelMaxContext: result.metrics.modelMaxContext,
    triggerThreshold: result.metrics.triggerThreshold,
    systemTokens: countContextTokens(system),
    toolDefinitionTokens: result.toolDefinitionTokens,
    hotTokens: countContextTokens(result.messages),
    hotTokenBudget: config.hotTokenBudget,
    warmTokens: countContextTokens(result.warmMessages),
    warmTokenBudget: config.warmTokenBudget,
    pinnedHotTokens,
    requestTokens: result.metrics.compressedTokens,
    config,
    hot: hotItems,
    warm: warmItems,
  }
}

export function rememberSnapshot(projectId: string, conversationId: string, snapshot: ContextDebugSnapshot, messages: ContextMessage[], summaries: ContextSummaryArtifact[] = []): void {
  const storageKey = key(projectId, conversationId)
  const previous = snapshots.get(storageKey)
  if (previous) {
    const previousHot = new Set(previous.hot.map((item) => item.id))
    const currentHot = new Set(snapshot.hot.map((item) => item.id))
    const demoted = previous.hot.filter((item) => !currentHot.has(item.id) && item.source !== 'system').map((item) => item.id)
    if (demoted.length > 0) addAudit(projectId, conversationId, { roundId: snapshot.roundId, requestId: snapshot.requestId, type: 'hot_to_warm', messageIds: demoted, description: `${demoted.length} message(s) moved from Hot to Warm`, simulated: false })
  }
  const recalled = snapshot.hot.filter((item) => item.source === 'cold-truth-recall' || item.source === 'cold-summary-recall').map((item) => item.id)
  if (recalled.length > 0) addAudit(projectId, conversationId, { roundId: snapshot.roundId, requestId: snapshot.requestId, type: 'cold_recall', messageIds: recalled, description: `${recalled.length} Cold record(s) promoted into Hot Newborn`, simulated: false })
  if (summaries.length > 0) addAudit(projectId, conversationId, { roundId: snapshot.roundId, requestId: snapshot.requestId, type: 'warm_to_cold', messageIds: summaries.flatMap((summary) => summary.sourceMessageIds), tokenDelta: summaries.reduce((sum, summary) => sum + summary.originalTokens - summary.compressedTokens, 0), description: `${summaries.length} Warm message(s) summarized for Cold storage`, simulated: false })
  if (snapshot.hotTokens > 0 && snapshot.pinnedHotTokens / snapshot.hotTokens >= 0.8) addAudit(projectId, conversationId, { roundId: snapshot.roundId, requestId: snapshot.requestId, type: 'pinned_ratio_warning', messageIds: snapshot.hot.filter((item) => item.pinnedToHot).map((item) => item.id), description: 'Pinned Hot messages occupy at least 80% of Hot tokens', simulated: false })
  snapshots.set(storageKey, snapshot)
  const currentMessages = new Map<string, ContextDebugMessage>()
  for (const message of messages) {
    if (!message.id) continue
    currentMessages.set(message.id, { id: message.id, createdAt: message.createdAt, role: message.role, content: message.content, toolCalls: message.tool_calls, toolCallId: message.tool_call_id, pinnedToHot: message.pinnedToHot, representation: message.representation, truthRefs: message.truthRefs, contextLayer: message.contextLayer, contextRegion: message.contextRegion, contextSource: message.contextSource, manualContextLayer: message.manualContextLayer })
  }
  snapshotMessages.set(storageKey, currentMessages)
}

export function getRememberedWarmMessages(projectId: string, conversationId: string): AgentContextMessage[] {
  const storageKey = key(projectId, conversationId)
  const snapshot = snapshots.get(storageKey)
  const messages = snapshotMessages.get(storageKey)
  if (!snapshot || !messages) return []
  return snapshot.warm.flatMap((item) => {
    const message = messages.get(item.id)
    return message && message.role !== 'system' ? [{ ...message, role: message.role, contextLayer: 'warm' as const }] : []
  })
}
export async function persistContextDebugMessages(projectId: string, conversationId: string, messages: AgentContextMessage[], summaries: import('../shared/types').ContextSummaryArtifact[] = []): Promise<void> {
  await appendConversationMessages(projectId, conversationId, messages)
  await appendConversationSummaries(projectId, conversationId, summaries)
}

async function getDebugRevision(projectId: string, conversationId: string, runtimeState: ConversationRuntimeState): Promise<string> {
  const storageRevision = await getConversationStorageRevision(projectId, conversationId)
  const snapshot = snapshots.get(key(projectId, conversationId))
  const audit = audits.get(key(projectId, conversationId)) ?? []
  return [runtimeState, storageRevision, snapshot?.requestId ?? '', snapshot?.createdAt ?? '', snapshot?.requestTokens ?? '', snapshot?.hot.length ?? 0, snapshot?.warm.length ?? 0, audit.length, audit.at(-1)?.id ?? ''].join('|')
}

export async function getContextDebugRevision(projectId: string, conversationId: string, runtimeState: ConversationRuntimeState): Promise<string> { return getDebugRevision(projectId, conversationId, runtimeState) }

export async function getContextDebugOverview(projectId: string, conversationId: string, runtimeState: ConversationRuntimeState): Promise<ContextDebugOverview> {
  const project = await getProject(projectId)
  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) throw new Error('Conversation not found')
  const truth = await readConversationIndex(projectId, conversationId)
  const summaries = await readConversationSummaryIndex(projectId, conversationId)
  const visible = new Set([...(snapshots.get(key(projectId, conversationId))?.hot ?? []), ...(snapshots.get(key(projectId, conversationId))?.warm ?? [])].map((item) => item.id))
  const cold = [...summaries, ...truth.filter((item) => !visible.has(item.id))].slice(-500)
  return { projectId, conversationId, conversationTitle: conversation.title, revision: await getDebugRevision(projectId, conversationId, runtimeState), runtimeState, snapshot: snapshots.get(key(projectId, conversationId)) ?? null, coldStorage: await readConversationStorageOverview(projectId, conversationId, truth), cold, coldTotal: summaries.length + truth.filter((item) => !visible.has(item.id)).length, audit: audits.get(key(projectId, conversationId)) ?? [] }
}

export async function readColdContextMessage(projectId: string, conversationId: string, messageId: string): Promise<ContextDebugMessage> {
  const message = (await readContextRecords(projectId, conversationId, [messageId]))[0]
  if (!message) throw new Error('Cold record not found')
  return { ...message, role: message.role }
}

export async function readContextSnapshotMessage(projectId: string, conversationId: string, messageId: string): Promise<ContextDebugMessage> {
  const message = snapshotMessages.get(key(projectId, conversationId))?.get(messageId)
  if (!message) throw new Error('Context message not found')
  return message
}

export async function searchColdContext(projectId: string, conversationId: string, query: string): Promise<ColdRecallPreview> {
  const matches = await searchConversationContext(projectId, conversationId, query, 50)
  addAudit(projectId, conversationId, { type: 'cold_recall', messageIds: matches.map((item) => item.id), description: `Previewed ${matches.length} Cold result(s)`, simulated: true })
  return { query, matches }
}

export async function setContextPin(projectId: string, conversationId: string, messageId: string, pinnedToHot: boolean): Promise<void> {
  const snapshot = snapshots.get(key(projectId, conversationId))
  const item = snapshot && [...snapshot.hot, ...snapshot.warm].find((candidate) => candidate.id === messageId)
  if (pinnedToHot && item?.representation === 'summary') throw new Error('Summary records cannot be pinned. Read the Cold truth record instead.')
  const movingWarmToHot = Boolean(snapshot && item && snapshot.warm.some((candidate) => candidate.id === messageId))
  if (pinnedToHot && snapshot && item && movingWarmToHot && snapshot.hotTokens + item.tokenCount > snapshot.hotTokenBudget) throw new Error('Cannot pin to Hot: resident content would exceed the Hot budget.')
  await updateConversationPin(projectId, conversationId, messageId, pinnedToHot)
  await updateConversationAgentMessages(projectId, conversationId, (messages) => messages.map((message) => message.id === messageId ? { ...message, pinnedToHot, manualContextLayer: pinnedToHot ? undefined : message.manualContextLayer } : message))
  if (snapshot && item) {
    item.pinnedToHot = pinnedToHot
    if (pinnedToHot && movingWarmToHot) {
      snapshot.warm = snapshot.warm.filter((candidate) => candidate.id !== messageId)
      snapshot.hot.push({ ...item, region: 'newborn', source: item.source === 'cold-summary-recall' ? 'cold-summary-recall' : 'warm-recall' })
      snapshot.hotTokens = countContextTokens(snapshot.hot)
      snapshot.warmTokens = countContextTokens(snapshot.warm)
    }
    snapshot.pinnedHotTokens = snapshot.hot.filter((candidate) => candidate.pinnedToHot).reduce((sum, candidate) => sum + candidate.tokenCount, 0)
  }
  addAudit(projectId, conversationId, { type: 'pin_changed', messageIds: [messageId], description: `${pinnedToHot ? 'Pinned' : 'Unpinned'} message in Hot`, simulated: false })
}
export async function demoteContext(projectId: string, conversationId: string, messageId?: string): Promise<void> {
  const snapshot = snapshots.get(key(projectId, conversationId))
  if (!snapshot) throw new Error('No context snapshot is available')
  const selected = snapshot.hot.filter((item) => item.source !== 'system' && item.representation === 'original' && !item.pinnedToHot && (!messageId || item.id === messageId))
  if (selected.length === 0) throw new Error('No eligible Hot messages to demote')
  const ids = new Set(selected.map((item) => item.id))
  await updateConversationLayer(projectId, conversationId, ids, 'warm')
  await updateConversationAgentMessages(projectId, conversationId, (messages) => messages.map((message) => message.id && ids.has(message.id) ? { ...message, manualContextLayer: 'warm', pinnedToHot: false } : message))
  snapshot.hot = snapshot.hot.filter((item) => !ids.has(item.id))
  snapshot.warm.push(...selected.map((item) => ({ ...item, source: 'hot-demotion' as const, pendingDemotion: false })))
  snapshot.hotTokens = countContextTokens(snapshot.hot)
  snapshot.warmTokens = countContextTokens(snapshot.warm)
  snapshot.pinnedHotTokens = snapshot.hot.filter((item) => item.pinnedToHot).reduce((sum, item) => sum + item.tokenCount, 0)
  addAudit(projectId, conversationId, { roundId: snapshot.roundId, requestId: snapshot.requestId, type: 'manual_demotion', messageIds: [...ids], description: `Manually moved ${ids.size} message(s) from Hot to Warm`, simulated: false })
}

export function simulateTokenLimit(projectId: string, conversationId: string, requestTokens: number): TokenLimitSimulation {
  const snapshot = snapshots.get(key(projectId, conversationId))
  const modelMaxContext = snapshot?.modelMaxContext ?? 128000
  const triggerThreshold = snapshot?.triggerThreshold ?? modelMaxContext - 16000
  const status = requestTokens >= modelMaxContext ? 'exceeded' : requestTokens >= triggerThreshold ? 'warning' : 'normal'
  addAudit(projectId, conversationId, { type: 'token_simulation', messageIds: [], description: `Simulated ${requestTokens} request tokens`, simulated: true })
  return { requestTokens, triggerThreshold, modelMaxContext, status }
}
