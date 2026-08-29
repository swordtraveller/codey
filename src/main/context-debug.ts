import { randomUUID } from 'node:crypto'
import type {
  AgentContextMessage,
  ContextAction,
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
import { contextImportanceScore, countContextTokens, type ContextMessage, type ContextResult } from './context'
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
const promotedHotIds = new Map<string, Set<string>>()

function key(projectId: string, conversationId: string): string { return `${projectId}:${conversationId}` }

function timeValue(value?: string): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

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
    enteredHotAt: message.enteredHotAt ?? message.createdAt ?? new Date(0).toISOString(),
    lastAccessedAt: message.lastAccessedAt,
    reuseCount: message.reuseCount ?? 0,
    importanceScore: contextImportanceScore(message),
  }
}

function addAudit(projectId: string, conversationId: string, event: Omit<ContextAuditEvent, 'id' | 'timestamp' | 'projectId' | 'conversationId'>): void {
  const storageKey = key(projectId, conversationId)
  const list = audits.get(storageKey) ?? []
  list.push({ ...event, id: randomUUID(), timestamp: new Date().toISOString(), projectId, conversationId })
  audits.set(storageKey, list.slice(-300))
}

function addAutomaticActionAudit(
  projectId: string,
  conversationId: string,
  snapshot: ContextDebugSnapshot,
  type: ContextAuditEvent['type'],
  action: ContextAction,
  description: string,
): void {
  const storageKey = key(projectId, conversationId)
  const messageIds = [...new Set(action.messageIds)].sort()
  const list = audits.get(storageKey) ?? []
  const alreadyRecorded = list.some((event) =>
    event.roundId === snapshot.roundId
      && event.type === type
      && event.messageIds.length === messageIds.length
      && [...event.messageIds].sort().every((id, index) => id === messageIds[index])
  )
  if (alreadyRecorded) return
  addAudit(projectId, conversationId, {
    roundId: snapshot.roundId,
    roundCount: snapshot.roundCount,
    requestId: snapshot.requestId,
    type,
    messageIds: action.messageIds,
    truthRefs: action.truthRefs,
    tokenDelta: action.tokenDelta,
    description,
    simulated: false,
  })
}

export function buildContextDebugSnapshot(result: ContextResult, config: import('../shared/types').ContextManagementConfig, requestId = randomUUID(), roundId = requestId, roundCount = 0): ContextDebugSnapshot {
  const system = result.messages.filter((message) => message.role === 'system')
  const hot = result.messages.filter((message) => message.role !== 'system')
  const hotItems = [...system.map((message) => toItem(message, 'system')), ...hot.map((message) => toItem(message, sourceOf(message)))]
  const warmItems = result.warmMessages.map((message) => toItem(message, sourceOf(message) === 'cold-summary-recall' ? 'cold-summary-recall' : 'hot-demotion'))
  const pinnedHotTokens = hotItems.filter((item) => item.pinnedToHot).reduce((sum, item) => sum + item.tokenCount, 0)
  return {
    requestId,
    roundId,
    roundCount,
    createdAt: new Date().toISOString(),
    modelMaxContext: result.metrics.modelMaxContext,
    triggerThreshold: result.metrics.triggerThreshold,
    systemTokens: countContextTokens(system),
    toolDefinitionTokens: result.toolDefinitionTokens,
    hotTokens: countContextTokens(result.messages),
    hotTokenBudget: result.hotTokenBudget ?? config.hotTokenBudget,
    hotHighWatermark: result.hotHighWatermark ?? Math.floor(config.hotTokenBudget * 0.9),
    hotLowWatermark: result.hotLowWatermark ?? Math.floor(config.hotTokenBudget * 0.8),
    warmTokens: countContextTokens(result.warmMessages),
    warmTokenBudget: config.warmTokenBudget,
    pinnedHotTokens,
    requestTokens: result.metrics.compressedTokens,
    config,
    hot: hotItems,
    warm: warmItems,
  }
}

export function rememberSnapshot(
  projectId: string,
  conversationId: string,
  snapshot: ContextDebugSnapshot,
  messages: ContextMessage[],
  summaries: ContextSummaryArtifact[] = [],
  actions: ContextAction[] = [],
): void {
  const storageKey = key(projectId, conversationId)
  const auditAction = (action: ContextAction): void => {
    const type = action.type === 'demote' ? 'hot_to_warm'
      : action.type === 'summarize' ? 'warm_to_cold'
        : action.type === 'promote' ? 'warm_to_hot' : 'cold_recall'
    const description = action.type === 'demote'
      ? `${action.messageIds.length} message(s) moved from Hot to Warm`
      : action.type === 'summarize'
        ? `${action.messageIds.length} Warm message(s) summarized for Cold storage`
        : action.type === 'promote'
          ? `${action.messageIds.length} message(s) promoted from Warm to Hot`
          : `${action.messageIds.length} context record(s) recalled into Warm`
    addAutomaticActionAudit(projectId, conversationId, snapshot, type, action, description)
  }

  const previous = snapshots.get(storageKey)
  if (actions.length > 0) {
    actions.forEach(auditAction)
  } else {
    if (previous) {
      const currentHot = new Set(snapshot.hot.map((item) => item.id))
      const demoted = previous.hot.filter((item) => !currentHot.has(item.id) && item.source !== 'system').map((item) => item.id)
      if (demoted.length > 0) addAudit(projectId, conversationId, { roundId: snapshot.roundId, roundCount: snapshot.roundCount, requestId: snapshot.requestId, type: 'hot_to_warm', messageIds: demoted, description: `${demoted.length} message(s) moved from Hot to Warm`, simulated: false })
    }
    const recalled = snapshot.hot.filter((item) => item.source === 'cold-truth-recall' || item.source === 'cold-summary-recall').map((item) => item.id)
    if (recalled.length > 0) addAudit(projectId, conversationId, { roundId: snapshot.roundId, roundCount: snapshot.roundCount, requestId: snapshot.requestId, type: 'cold_recall', messageIds: recalled, description: `${recalled.length} Cold record(s) promoted into Hot Newborn`, simulated: false })
    if (summaries.length > 0) addAudit(projectId, conversationId, { roundId: snapshot.roundId, roundCount: snapshot.roundCount, requestId: snapshot.requestId, type: 'warm_to_cold', messageIds: summaries.flatMap((summary) => summary.sourceMessageIds), tokenDelta: summaries.reduce((sum, summary) => sum + summary.originalTokens - summary.compressedTokens, 0), description: `${summaries.length} Warm message(s) summarized for Cold storage`, simulated: false })
  }
  if (snapshot.hotTokens > 0 && snapshot.pinnedHotTokens / snapshot.hotTokens >= 0.8) addAudit(projectId, conversationId, { roundId: snapshot.roundId, roundCount: snapshot.roundCount, requestId: snapshot.requestId, type: 'pinned_ratio_warning', messageIds: snapshot.hot.filter((item) => item.pinnedToHot).map((item) => item.id), description: 'Pinned Hot messages occupy at least 80% of Hot tokens', simulated: false })
  const promoted = promotedHotIds.get(storageKey)
  if (promoted) {
    const currentHot = new Set(snapshot.hot.map((item) => item.id))
    const retained = new Set([...promoted].filter((id) => currentHot.has(id)))
    if (retained.size > 0) promotedHotIds.set(storageKey, retained)
    else promotedHotIds.delete(storageKey)
  }
  snapshots.set(storageKey, snapshot)
  const currentMessages = new Map<string, ContextDebugMessage>()
  for (const message of messages) {
    if (!message.id) continue
    currentMessages.set(message.id, { id: message.id, createdAt: message.createdAt, role: message.role, content: message.content, toolCalls: message.tool_calls, toolCallId: message.tool_call_id, pinnedToHot: message.pinnedToHot, representation: message.representation, truthRefs: message.truthRefs, contextLayer: message.contextLayer, contextRegion: message.contextRegion, contextSource: message.contextSource, manualContextLayer: message.manualContextLayer })
  }
  snapshotMessages.set(storageKey, currentMessages)
}

export function hasContextDebugSnapshot(projectId: string, conversationId: string): boolean {
  return snapshots.has(key(projectId, conversationId))
}

export function rememberInitializedSnapshot(
  projectId: string,
  conversationId: string,
  snapshot: ContextDebugSnapshot,
  messages: ContextMessage[],
  actions: ContextAction[] = [],
): void {
  rememberSnapshot(projectId, conversationId, snapshot, messages, [], actions)
  addAudit(projectId, conversationId, {
    roundId: snapshot.roundId,
    roundCount: snapshot.roundCount,
    requestId: snapshot.requestId,
    type: 'hot_warm_initialization',
    messageIds: [...snapshot.hot, ...snapshot.warm].map((item) => item.id),
    description: 'Initialized Hot and Warm from persisted conversation history',
    simulated: false,
  })
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

export function getPromotedHotMessages(projectId: string, conversationId: string): AgentContextMessage[] {
  const storageKey = key(projectId, conversationId)
  const promoted = promotedHotIds.get(storageKey)
  const messages = snapshotMessages.get(storageKey)
  if (!promoted || !messages) return []
  return [...promoted].flatMap((id) => {
    const message = messages.get(id)
    return message && message.role !== 'system' ? [{ ...message, role: message.role }] : []
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

export function promoteContext(projectId: string, conversationId: string, messageId: string): void {
  const storageKey = key(projectId, conversationId)
  const snapshot = snapshots.get(storageKey)
  const item = snapshot?.warm.find((candidate) => candidate.id === messageId)
  if (!snapshot || !item) throw new Error('Warm context message not found')
  if (snapshot.hotTokens + item.tokenCount > snapshot.hotTokenBudget) throw new Error('Cannot promote to Hot: content would exceed the Hot budget.')

  const source: ContextSource = item.source === 'cold-summary-recall' ? 'cold-summary-recall' : 'warm-recall'
  const enteredHotAt = new Date().toISOString()
  const promotedItem = { ...item, pinnedToHot: false, region: 'newborn' as const, source, enteredHotAt, lastAccessedAt: enteredHotAt, reuseCount: item.reuseCount + 1 }
  snapshot.warm = snapshot.warm.filter((candidate) => candidate.id !== messageId)
  snapshot.hot.push(promotedItem)
  snapshot.hotTokens = countContextTokens(snapshot.hot)
  snapshot.warmTokens = countContextTokens(snapshot.warm)

  const messages = snapshotMessages.get(storageKey)
  const message = messages?.get(messageId)
  if (messages && message) {
    messages.set(messageId, {
      ...message,
      pinnedToHot: false,
      manualContextLayer: undefined,
      contextLayer: 'hot',
      contextRegion: 'newborn',
      contextSource: source,
      lastAccessedAt: enteredHotAt,
      enteredHotAt,
      reuseCount: (message.reuseCount ?? 0) + 1,
    })
  }
  const promoted = promotedHotIds.get(storageKey) ?? new Set<string>()
  promoted.add(messageId)
  promotedHotIds.set(storageKey, promoted)
  addAudit(projectId, conversationId, { roundId: snapshot.roundId, requestId: snapshot.requestId, type: 'warm_to_hot', messageIds: [messageId], description: 'Promoted 1 message from Warm to Hot without pinning', simulated: false })
}

export async function setContextPin(projectId: string, conversationId: string, messageId: string, pinnedToHot: boolean): Promise<void> {
  const snapshot = snapshots.get(key(projectId, conversationId))
  const item = snapshot && [...snapshot.hot, ...snapshot.warm].find((candidate) => candidate.id === messageId)
  if (pinnedToHot && item?.representation === 'summary') throw new Error('Summary records cannot be pinned. Read the Cold truth record instead.')
  const movingWarmToHot = Boolean(snapshot && item && snapshot.warm.some((candidate) => candidate.id === messageId))
  if (pinnedToHot && snapshot && item && movingWarmToHot && snapshot.hotTokens + item.tokenCount > snapshot.hotTokenBudget) throw new Error('Cannot pin to Hot: resident content would exceed the Hot budget.')
  await updateConversationPin(projectId, conversationId, messageId, pinnedToHot)
  await updateConversationAgentMessages(projectId, conversationId, (messages) => messages.map((message) => message.id === messageId ? { ...message, pinnedToHot, manualContextLayer: pinnedToHot ? undefined : message.manualContextLayer } : message))
  if (pinnedToHot) promotedHotIds.get(key(projectId, conversationId))?.delete(messageId)
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
export async function unpinLowestPriorityContext(projectId: string, conversationId: string): Promise<void> {
  const storageKey = key(projectId, conversationId)
  const snapshot = snapshots.get(storageKey)
  if (!snapshot) throw new Error('No context snapshot is available')
  if (snapshot.hotTokens < snapshot.hotHighWatermark) throw new Error('Hot context has not reached the high watermark')
  const candidates = snapshot.hot
    .filter((item) => item.source !== 'system' && item.pinnedToHot)
    .sort((left, right) => left.importanceScore - right.importanceScore
      || timeValue(left.lastAccessedAt) - timeValue(right.lastAccessedAt)
      || timeValue(left.enteredHotAt) - timeValue(right.enteredHotAt)
      || right.tokenCount - left.tokenCount
      || left.id.localeCompare(right.id))
  if (candidates.length === 0) throw new Error('No pinned Hot messages are available')

  const requiredTokens = Math.max(1, snapshot.hotTokens - snapshot.hotLowWatermark)
  const selected: ContextLayerItem[] = []
  let releasedTokens = 0
  for (const item of candidates) {
    selected.push(item)
    releasedTokens += item.tokenCount
    if (releasedTokens >= requiredTokens) break
  }
  const ids = new Set(selected.map((item) => item.id))
  for (const id of ids) await updateConversationPin(projectId, conversationId, id, false)
  await updateConversationAgentMessages(projectId, conversationId, (messages) => messages.map((message) =>
    message.id && ids.has(message.id) ? { ...message, pinnedToHot: false } : message))
  for (const item of selected) item.pinnedToHot = false
  snapshot.pinnedHotTokens = snapshot.hot.filter((item) => item.pinnedToHot).reduce((sum, item) => sum + item.tokenCount, 0)
  addAudit(projectId, conversationId, {
    type: 'pin_changed',
    messageIds: [...ids],
    description: `Unpinned ${ids.size} lowest-priority Hot message(s) by explicit user request`,
    simulated: false,
  })
}
export async function demoteContext(projectId: string, conversationId: string, messageId?: string): Promise<void> {
  const snapshot = snapshots.get(key(projectId, conversationId))
  if (!snapshot) throw new Error('No context snapshot is available')
  const selected = snapshot.hot.filter((item) => item.source !== 'system' && item.representation === 'original' && !item.pinnedToHot && (!messageId || item.id === messageId))
  if (selected.length === 0) throw new Error('No eligible Hot messages to demote')
  const ids = new Set(selected.map((item) => item.id))
  const promoted = promotedHotIds.get(key(projectId, conversationId))
  for (const id of ids) promoted?.delete(id)
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
