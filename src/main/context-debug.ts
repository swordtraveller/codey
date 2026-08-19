import { randomUUID } from 'node:crypto'
import type {
  AgentContextMessage,
  ContextAuditEvent,
  ContextDebugOverview,
  ContextDebugMessage,
  ContextDebugSnapshot,
  ContextLayerItem,
  ColdRecallPreview,
  ConversationRuntimeState,
  ProtectionLevel,
  ProtectionReason,
  TokenLimitSimulation,
} from '../shared/types'
import { countContextTokens, type ContextMessage, type ContextResult } from './context'
import {
  appendConversationMessages,
  readConversationIndex,
  readConversationMessage,
  getConversationStorageRevision,
  readConversationStorageOverview,
  updateConversationLayer,
  updateConversationProtection,
} from './conversation-store'
import { getProject, updateConversationAgentMessages } from './workspace'

const snapshots = new Map<string, ContextDebugSnapshot>()
const snapshotMessages = new Map<string, Map<string, ContextDebugMessage>>()
const audits = new Map<string, ContextAuditEvent[]>()

function key(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`
}

function protectionFor(message: ContextMessage): ProtectionLevel {
  if (message.role === 'system') return 'full'
  if (message.role === 'tool' || message.tool_calls?.length) return 'partial'
  return message.protection ?? 'none'
}

function protectionReasons(message: ContextMessage): ProtectionReason[] {
  if (message.role === 'system') return ['system']
  if (message.role === 'tool' || message.tool_calls?.length) return ['tool']
  return protectionFor(message) === 'none' ? [] : ['manual']
}

function toItem(
  message: ContextMessage,
  source: ContextLayerItem['source'],
  compressed = false,
): ContextLayerItem {
  const content = message.content ?? ''
  return {
    id: message.id ?? randomUUID(),
    role: message.role,
    tokenCount: countContextTokens(message),
    createdAt: message.createdAt ?? new Date(0).toISOString(),
    preview: content.replace(/\s+/g, ' ').trim().slice(0, 240),
    protection: protectionFor(message),
    protectionReasons: protectionReasons(message),
    source,
    compressed,
    pendingDemotion: false,
  }
}

function addAudit(
  projectId: string,
  conversationId: string,
  event: Omit<ContextAuditEvent, 'id' | 'timestamp' | 'projectId' | 'conversationId'>,
): void {
  const storageKey = key(projectId, conversationId)
  const list = audits.get(storageKey) ?? []
  list.push({
    ...event,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    projectId,
    conversationId,
  })
  audits.set(storageKey, list.slice(-300))
}

export function buildContextDebugSnapshot(
  result: ContextResult,
  config: import('../shared/types').ContextManagementConfig,
  requestId = randomUUID(),
  roundId = requestId,
): ContextDebugSnapshot {
  const system = result.messages.filter((message) => message.role === 'system')
  const warm = result.messages.filter(
    (message) => message.role !== 'system' && message.contextLayer === 'warm',
  )
  const hot = result.messages.filter(
    (message) => message.role !== 'system' && message.contextLayer !== 'warm',
  )
  const compressed = result.metrics.filtered || result.metrics.rewritten
  const hotItems = [
    ...system.map((message) => toItem(message, 'system')),
    ...hot.map((message) => toItem(message, 'hot', compressed)),
  ]

  return {
    requestId,
    roundId,
    createdAt: new Date().toISOString(),
    modelMaxContext: result.metrics.modelMaxContext,
    triggerThreshold: result.metrics.triggerThreshold,
    systemTokens: countContextTokens(system),
    toolDefinitionTokens: result.toolDefinitionTokens,
    hotTokens: hotItems.reduce((sum, item) => sum + item.tokenCount, 0),
    hotTokenBudget: config.hotTokenBudget,
    warmTokens: countContextTokens(warm),
    warmTokenBudget: config.warmTokenBudget,
    protectedHotTokens: hotItems
      .filter((item) => item.protection !== 'none')
      .reduce((sum, item) => sum + item.tokenCount, 0),
    requestTokens: result.metrics.compressedTokens,
    config,
    hot: hotItems,
    warm: warm.map((message) => toItem(
      message,
      message.contextSource === 'cold-recall' ? 'cold-recall' : 'hot-demotion',
      compressed,
    )),
  }
}

export function rememberSnapshot(
  projectId: string,
  conversationId: string,
  snapshot: ContextDebugSnapshot,
  messages: ContextMessage[],
): void {
  const storageKey = key(projectId, conversationId)
  const previous = snapshots.get(storageKey)
  const currentHot = new Set(snapshot.hot.map((item) => item.id))
  const currentWarm = new Set(snapshot.warm.map((item) => item.id))

  if (previous) {
    const demoted = previous.hot.filter((item) => currentWarm.has(item.id)).map((item) => item.id)
    const persisted = previous.warm
      .filter((item) => !currentHot.has(item.id) && !currentWarm.has(item.id))
      .map((item) => item.id)
    if (demoted.length > 0) {
      addAudit(projectId, conversationId, {
        roundId: snapshot.roundId,
        requestId: snapshot.requestId,
        type: 'hot_to_warm',
        messageIds: demoted,
        description: `${demoted.length} message(s) moved from Hot to Warm`,
        simulated: false,
      })
    }
    if (persisted.length > 0) {
      addAudit(projectId, conversationId, {
        roundId: snapshot.roundId,
        requestId: snapshot.requestId,
        type: 'warm_to_cold',
        messageIds: persisted,
        description: `${persisted.length} message(s) left Warm and remain available in Cold`,
        simulated: false,
      })
    }
  }

  const recalled = snapshot.warm
    .filter((item) => item.source === 'cold-recall')
    .map((item) => item.id)
  if (recalled.length > 0) {
    addAudit(projectId, conversationId, {
      roundId: snapshot.roundId,
      requestId: snapshot.requestId,
      type: 'cold_recall',
      messageIds: recalled,
      description: `${recalled.length} Cold message(s) recalled into Warm`,
      simulated: false,
    })
  }

  if (snapshot.hotTokens > 0 && snapshot.protectedHotTokens / snapshot.hotTokens >= 0.8) {
    addAudit(projectId, conversationId, {
      roundId: snapshot.roundId,
      requestId: snapshot.requestId,
      type: 'protected_ratio_warning',
      messageIds: snapshot.hot.filter((item) => item.protection !== 'none').map((item) => item.id),
      description: 'Protected messages occupy at least 80% of Hot tokens',
      simulated: false,
    })
  }

  snapshots.set(storageKey, snapshot)
  const currentMessages = new Map<string, ContextDebugMessage>()
  for (const message of messages) {
    if (!message.id) continue
    currentMessages.set(message.id, {
      id: message.id,
      createdAt: message.createdAt,
      role: message.role,
      content: message.content,
      toolCalls: message.tool_calls,
      toolCallId: message.tool_call_id,
      protection: protectionFor(message),
      contextLayer: message.contextLayer,
      contextSource: message.contextSource,
      manualContextLayer: message.manualContextLayer,
    })
  }
  snapshotMessages.set(storageKey, currentMessages)
}

export async function persistContextDebugMessages(
  projectId: string,
  conversationId: string,
  messages: AgentContextMessage[],
): Promise<void> {
  await appendConversationMessages(projectId, conversationId, messages)
}

async function getDebugRevision(
  projectId: string,
  conversationId: string,
  runtimeState: ConversationRuntimeState,
): Promise<string> {
  const storageRevision = await getConversationStorageRevision(projectId, conversationId)
  const snapshot = snapshots.get(key(projectId, conversationId))
  const audit = audits.get(key(projectId, conversationId)) ?? []
  const lastAudit = audit.at(-1)
  return [
    runtimeState,
    storageRevision,
    snapshot?.requestId ?? '',
    snapshot?.createdAt ?? '',
    snapshot?.requestTokens ?? '',
    snapshot?.hot.length ?? 0,
    snapshot?.warm.length ?? 0,
    audit.length,
    lastAudit?.id ?? '',
  ].join('|')
}

export async function getContextDebugRevision(
  projectId: string,
  conversationId: string,
  runtimeState: ConversationRuntimeState,
): Promise<string> {
  return getDebugRevision(projectId, conversationId, runtimeState)
}

export async function getContextDebugOverview(
  projectId: string,
  conversationId: string,
  runtimeState: ConversationRuntimeState,
): Promise<ContextDebugOverview> {
  const project = await getProject(projectId)
  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) throw new Error('Conversation not found')
  const snapshot = snapshots.get(key(projectId, conversationId)) ?? null
  const visible = new Set(
    [...(snapshot?.hot ?? []), ...(snapshot?.warm ?? [])].map((item) => item.id),
  )
  const persisted = await readConversationIndex(projectId, conversationId)
  const allCold = persisted.filter((item) => !visible.has(item.id))
  const coldStorage = await readConversationStorageOverview(projectId, conversationId, persisted)
  const revision = await getDebugRevision(projectId, conversationId, runtimeState)

  return {
    projectId,
    conversationId,
    conversationTitle: conversation.title,
    revision,
    runtimeState,
    snapshot,
    coldStorage,
    cold: allCold.slice(-500),
    coldTotal: allCold.length,
    audit: audits.get(key(projectId, conversationId)) ?? [],
  }
}

export function readContextSnapshotMessage(
  projectId: string,
  conversationId: string,
  messageId: string,
): ContextDebugMessage {
  const message = snapshotMessages.get(key(projectId, conversationId))?.get(messageId)
  if (!message) throw new Error('Context message not found in the current snapshot')
  return message
}

export async function readColdContextMessage(
  projectId: string,
  conversationId: string,
  messageId: string,
): Promise<AgentContextMessage> {
  return readConversationMessage(projectId, conversationId, messageId)
}

export async function searchColdContext(
  projectId: string,
  conversationId: string,
  query: string,
): Promise<ColdRecallPreview> {
  const queryTerms = query.toLowerCase().match(/[a-z0-9_-]{2,}|\p{Script=Han}{1,}/gu) ?? []
  const snapshot = snapshots.get(key(projectId, conversationId))
  const visible = new Set([...(snapshot?.hot ?? []), ...(snapshot?.warm ?? [])].map((item) => item.id))
  const matches = (await readConversationIndex(projectId, conversationId))
    .filter((item) => !visible.has(item.id))
    .map((item) => ({
      item,
      score: queryTerms.reduce(
        (score, term) => score + (
          item.terms.some((value) => value.includes(term)) ||
          item.preview.toLowerCase().includes(term)
            ? 1
            : 0
        ),
        0,
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 50)
    .map(({ item }) => item)

  addAudit(projectId, conversationId, {
    type: 'cold_recall',
    messageIds: matches.map((item) => item.id),
    description: `Previewed ${matches.length} Cold search result(s)`,
    simulated: true,
  })
  return { query, matches }
}

export async function setContextProtection(
  projectId: string,
  conversationId: string,
  messageId: string,
  protection: ProtectionLevel,
): Promise<void> {
  const snapshotMessage = snapshotMessages.get(key(projectId, conversationId))?.get(messageId)
  const requiredProtection = snapshotMessage
    ? snapshotMessage.role === 'system'
      ? 'full'
      : snapshotMessage.role === 'tool' || snapshotMessage.toolCalls?.length
        ? 'partial'
        : null
    : await readConversationMessage(projectId, conversationId, messageId).then((message) =>
        message.role === 'tool' || message.toolCalls?.length ? 'partial' as const : null,
      )
  if (requiredProtection && protection !== requiredProtection) {
    throw new Error('System and tool message protection cannot be changed')
  }
  await updateConversationProtection(projectId, conversationId, messageId, protection)
  await updateConversationAgentMessages(projectId, conversationId, (messages) =>
    messages.map((message) => message.id === messageId
      ? { ...message, protection, manualProtected: protection !== 'none' }
      : message),
  )
  const snapshot = snapshots.get(key(projectId, conversationId))
  if (snapshot) {
    for (const item of [...snapshot.hot, ...snapshot.warm]) {
      if (item.id === messageId) {
        item.protection = protection
        item.protectionReasons = protection === 'none' ? [] : ['manual']
      }
    }
    snapshot.protectedHotTokens = snapshot.hot
      .filter((item) => item.protection !== 'none')
      .reduce((sum, item) => sum + item.tokenCount, 0)
  }
  const message = snapshotMessages.get(key(projectId, conversationId))?.get(messageId)
  if (message) {
    message.protection = protection
    message.manualProtected = protection !== 'none'
  }
  addAudit(projectId, conversationId, {
    type: 'protection_changed',
    messageIds: [messageId],
    description: `Protection changed to ${protection}`,
    simulated: false,
  })
}

export async function demoteContext(
  projectId: string,
  conversationId: string,
  messageId?: string,
): Promise<void> {
  const snapshot = snapshots.get(key(projectId, conversationId))
  if (!snapshot) throw new Error('No context snapshot is available')
  const selected = snapshot.hot.filter((item) =>
    item.source !== 'system' &&
    item.protection !== 'full' &&
    (!messageId || item.id === messageId),
  )
  if (selected.length === 0) throw new Error('No eligible Hot messages to demote')
  const ids = new Set(selected.map((item) => item.id))
  await updateConversationLayer(projectId, conversationId, ids, 'warm')
  await updateConversationAgentMessages(projectId, conversationId, (messages) =>
    messages.map((message) => message.id && ids.has(message.id)
      ? { ...message, manualContextLayer: 'warm' }
      : message),
  )
  snapshot.hot = snapshot.hot.filter((item) => !ids.has(item.id))
  snapshot.warm.push(...selected.map((item) => ({
    ...item,
    source: 'hot-demotion' as const,
    pendingDemotion: false,
  })))
  snapshot.hotTokens = snapshot.hot.reduce((sum, item) => sum + item.tokenCount, 0)
  snapshot.warmTokens = snapshot.warm.reduce((sum, item) => sum + item.tokenCount, 0)
  snapshot.protectedHotTokens = snapshot.hot
    .filter((item) => item.protection !== 'none')
    .reduce((sum, item) => sum + item.tokenCount, 0)
  addAudit(projectId, conversationId, {
    roundId: snapshot.roundId,
    requestId: snapshot.requestId,
    type: 'manual_demotion',
    messageIds: [...ids],
    description: `Manually moved ${ids.size} message(s) from Hot to Warm`,
    simulated: false,
  })
}

export function simulateTokenLimit(
  projectId: string,
  conversationId: string,
  requestTokens: number,
): TokenLimitSimulation {
  const snapshot = snapshots.get(key(projectId, conversationId))
  const modelMaxContext = snapshot?.modelMaxContext ?? 128000
  const triggerThreshold = snapshot?.triggerThreshold ?? modelMaxContext - 16000
  const status = requestTokens >= modelMaxContext
    ? 'exceeded'
    : requestTokens >= triggerThreshold
      ? 'warning'
      : 'normal'
  addAudit(projectId, conversationId, {
    type: 'token_simulation',
    messageIds: [],
    description: `Simulated ${requestTokens} request tokens`,
    simulated: true,
  })
  return { requestTokens, triggerThreshold, modelMaxContext, status }
}
