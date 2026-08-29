import type { ImageAttachment } from './image-attachments'
export type { ImageAttachment, ImageMediaType } from './image-attachments'

export type AppLanguage = 'system' | 'en' | 'zh-CN'

export type ModelConfig = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  modelName: string
  modelMaxContext: number
}

export const defaultModelConfig: ModelConfig = {
  id: '',
  name: '',
  baseUrl: '',
  apiKey: '',
  modelName: '',
  modelMaxContext: 128_000,
}

export type ContextManagementConfig = {
  layeredEnabled: boolean
  filterEnabled: boolean
  rewriteEnabled: boolean
  truncateEnabled: boolean
  safeOutputMargin: number
  recentKeepRounds: number
  hotTokenBudget: number
  warmTokenBudget: number
  coldRecallTokenBudget: number
  /** Developer-only conversation override for a custom Rhai strategy. */
  customStrategyEnabled?: boolean
  customStrategyScript?: string
}

export const defaultContextManagementConfig: ContextManagementConfig = {
  layeredEnabled: false,
  filterEnabled: true,
  rewriteEnabled: true,
  truncateEnabled: true,
  safeOutputMargin: 16_000,
  recentKeepRounds: 5,
  hotTokenBudget: 64_000,
  warmTokenBudget: 32_000,
  coldRecallTokenBudget: 8_000,
  customStrategyEnabled: false,
  customStrategyScript: '',
}

export const maximumAgentLimit = 100

export type AgentLimitsConfig = {
  modelRequestsPerRound: number
  toolCallsPerRequest: number
}

export const defaultAgentLimitsConfig: AgentLimitsConfig = {
  modelRequestsPerRound: 64,
  toolCallsPerRequest: 32,
}

export type AppConfig = {
  modelConfigs: ModelConfig[]
  activeModelConfigId: string | null
  contextManagement: ContextManagementConfig
  language: AppLanguage
  developerMode: boolean
  keepAwakeEnabled: boolean
  keepAwakeOnlyWhileWorking: boolean
  networkAccessEnabled: boolean
  performanceTracingEnabled: boolean
}

export const defaultAppConfig: AppConfig = {
  modelConfigs: [],
  activeModelConfigId: null,
  contextManagement: defaultContextManagementConfig,
  language: 'system',
  developerMode: false,
  keepAwakeEnabled: false,
  keepAwakeOnlyWhileWorking: true,
  networkAccessEnabled: false,
  performanceTracingEnabled: false,
}

export type ModelConfigSnapshot = Omit<ModelConfig, 'apiKey'>
export type PerformanceTraceScope = 'renderer' | 'main' | 'agent'

export type PerformanceTraceValue = number | boolean | string | null

export type ContextAction = {
  type: 'promote' | 'demote' | 'summarize' | 'recall'
  messageIds: string[]
  truthRefs: string[]
  tokenDelta?: number
}

export type PerformanceTraceEvent = {
  traceId: string
  scope: PerformanceTraceScope
  phase: string
  projectId?: string
  conversationId?: string
  durationMs?: number
  data?: Record<string, PerformanceTraceValue>
}

export type PerformanceTraceStatus = {
  enabled: boolean
  path: string
  sizeBytes: number
}

export type PerformanceTraceFile = {
  name: string
  sizeBytes: number
  modifiedAt: string
}

export type ContextMetrics = {
  originalTokens: number
  compressedTokens: number
  modelMaxContext: number
  triggerThreshold: number
  compressionRatio: number
  layered: boolean
  recalled: boolean
  filtered: boolean
  rewritten: boolean
  truncated: boolean
}

export type AssistantMessageBlock =
  | { type: 'content'; content: string }
  | { type: 'function_call'; id: string; name: string; parameters: string; result?: string; resultError?: boolean }

export type ContextCompressionNotice = {
  originalTokens: number
  compressedTokens: number
  compressionRatio: number
  method: string
}

export type DevelopmentTimelineItem =
  | { type: 'block'; block: AssistantMessageBlock }
  | { type: 'compression'; compression: ContextCompressionNotice }

export type ConversationTurnResult = 'processing' | 'normal' | 'timeout' | 'other' | 'stopped'

export type ConversationTurnRecord = {
  startedAt: number
  endedAt?: number
  result: ConversationTurnResult
  error?: string
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: ImageAttachment[]
  blocks?: AssistantMessageBlock[]
  compression?: ContextCompressionNotice
  modelConfig?: ModelConfigSnapshot
  contextConfig?: ContextManagementConfig
  turn?: ConversationTurnRecord
  createdAt?: string
}

export type ContextRepresentation = 'original' | 'summary'

export type ContextSource =
  | 'live'
  | 'hot-demotion'
  | 'warm-recall'
  | 'cold-summary-recall'
  | 'cold-truth-recall'
  | 'hot'
  | 'warm'
  | 'cold-recall'

export type ContextRegion = 'permanent' | 'long-term' | 'newborn'

export type AgentContextMessage = {
  id?: string
  createdAt?: string
  role: ChatMessage['role'] | 'tool'
  content: string | null
  images?: ImageAttachment[]
  toolCalls?: unknown[]
  toolCallId?: string
  pinnedToHot?: boolean
  representation?: ContextRepresentation
  truthRefs?: string[]
  contextLayer?: 'hot' | 'warm'
  contextRegion?: ContextRegion
  contextSource?: ContextSource
  recalledAtRoundId?: string
  lastAccessedAt?: string
  enteredHotAt?: string
  reuseCount?: number
  manualContextLayer?: 'warm'
  /** Legacy persisted fields, read only for migration. */
  manualProtected?: boolean
  /** Legacy persisted fields, read only for migration. */
  protection?: 'none' | 'partial' | 'full'
}

export type ContextSummaryArtifact = {
  id: string
  role: AgentContextMessage['role']
  content: string
  sourceMessageIds: string[]
  sourcePointers: string[]
  timeRange: { from: string; to: string }
  compressionMethod: string
  originalTokens: number
  compressedTokens: number
  generation: number
  createdAt: string
}

export type ContextDebugMessage = Omit<AgentContextMessage, 'role'> & {
  role: AgentContextMessage['role'] | 'system'
}

export type Conversation = {
  id: string
  title: string
  archived: boolean
  modelConfigId: string | null
  contextConfigOverride: ContextManagementConfig | null
  agentLimits: AgentLimitsConfig
  messages: ChatMessage[]
  agentMessages: AgentContextMessage[]
  context?: ContextMetrics
}

export type ProjectFolder = {
  id: string
  path: string
}

export type Project = {
  id: string
  name: string
  archived: boolean
  defaultModelConfigId: string | null
  contextConfigOverride: ContextManagementConfig | null
  folders: ProjectFolder[]
  pythonEnvironmentFolderId: string | null
  conversations: Conversation[]
}

export type DevelopmentStreamDelta = {
  content?: string
  toolCalls?: Array<{
    index: number
    id?: string
    name?: string
    parameters?: string
  }>
}

export type DevelopmentProgressUpdate =
  | { type: 'reset' }
  | { type: 'append'; items: DevelopmentTimelineItem[] }
  | { type: 'replace-stream'; blocks: AssistantMessageBlock[] }
  | { type: 'append-stream'; delta: DevelopmentStreamDelta }
  | { type: 'commit-stream'; items: DevelopmentTimelineItem[] }
  | { type: 'update-tool-result'; toolCallId: string; result: string; resultError: boolean }

export type DevelopmentProgress = {
  projectId: string
  conversationId: string
  update: DevelopmentProgressUpdate
}

export type DevelopmentProgressState = {
  timeline: DevelopmentTimelineItem[]
  streamingBlocks: AssistantMessageBlock[]
}

export type DevelopmentResult = {
  project?: Project
  writtenFiles: string[]
  stopped?: boolean
  error?: string
}

export type ConversationRuntimeState = 'idle' | 'running' | 'debugging'


export type ContextLayerItem = {
  id: string
  role: AgentContextMessage['role'] | 'system'
  tokenCount: number
  createdAt: string
  preview: string
  pinnedToHot: boolean
  representation: ContextRepresentation
  truthRefs: string[]
  region: ContextRegion
  source: 'system' | ContextSource
  pendingDemotion: boolean
  enteredHotAt: string
  lastAccessedAt?: string
  reuseCount: number
  importanceScore: number
}

export type ContextDebugSnapshot = {
  requestId: string
  roundId: string
  roundCount: number
  createdAt: string
  modelMaxContext: number
  triggerThreshold: number
  systemTokens: number
  toolDefinitionTokens: number
  hotTokens: number
  hotTokenBudget: number
  hotHighWatermark: number
  hotLowWatermark: number
  warmTokens: number
  warmTokenBudget: number
  pinnedHotTokens: number
  requestTokens: number
  config: ContextManagementConfig
  hot: ContextLayerItem[]
  warm: ContextLayerItem[]
}

export type ColdIndexItem = {
  id: string
  kind: 'truth' | 'summary'
  role: AgentContextMessage['role']
  tokenCount: number
  createdAt: string
  preview: string
  logicalPointer: string
  terms: string[]
  truthRefs: string[]
  compressionMethod?: string
  originalTokens?: number
  compressedTokens?: number
  contextRegion?: ContextRegion
  manualContextLayer?: 'warm'
  pinnedToHot?: boolean
  protection?: 'none' | 'partial' | 'full'
}

export type ColdStorageFile = {
  path: string
  exists: boolean
  sizeBytes: number
  modifiedAt: string | null
}

export type ColdStorageOverview = {
  folderPath: string
  messages: ColdStorageFile
  index: ColdStorageFile
  overrides: ColdStorageFile
  summaries: ColdStorageFile
  summaryIndex: ColdStorageFile
  recordCount: number
  summaryCount: number
  indexedBytes: number
  indexStatus: 'empty' | 'consistent' | 'mismatch'
  lastPersistedAt: string | null
}

export type ContextAuditEvent = {
  id: string
  timestamp: string
  projectId: string
  conversationId: string
  roundId?: string
  roundCount?: number
  requestId?: string
  truthRefs?: string[]
  type:
    | 'hot_to_warm'
    | 'warm_to_cold'
    | 'warm_to_hot'
    | 'cold_recall'
    | 'pin_changed'
    | 'manual_demotion'
    | 'pinned_ratio_warning'
    | 'token_simulation'
    | 'hot_warm_initialization'
  messageIds: string[]
  tokenDelta?: number
  description: string
  simulated: boolean
}

export type ContextDebugOverview = {
  projectId: string
  conversationId: string
  conversationTitle: string
  revision: string
  runtimeState: ConversationRuntimeState
  snapshot: ContextDebugSnapshot | null
  coldStorage: ColdStorageOverview
  cold: ColdIndexItem[]
  coldTotal: number
  audit: ContextAuditEvent[]
}

export type ColdRecallPreview = {
  query: string
  matches: ColdIndexItem[]
}

export type TokenLimitSimulation = {
  requestTokens: number
  triggerThreshold: number
  modelMaxContext: number
  status: 'normal' | 'warning' | 'exceeded'
}

export type ConversationStateChange = {
  projectId: string
  conversationId: string
  state: ConversationRuntimeState
}

export type ScreenshotSource = {
  captureId: string
  dataUrl: string
  width: number
  height: number
  scaleX: number
  scaleY: number
}

export type ScreenshotSelection = {
  x: number
  y: number
  width: number
  height: number
}
