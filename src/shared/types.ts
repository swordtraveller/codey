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
  /** Optional provider-defined output token limit; undefined means no explicit limit. */
  modelMaxOutputTokens?: number
  /** Multimodal input capabilities, default off. */
  supportsImageInput?: boolean
  supportsPdfInput?: boolean
  supportsVideoInput?: boolean
  supportsAudioInput?: boolean
}

export const defaultModelConfig: ModelConfig = {
  id: '',
  name: '',
  baseUrl: '',
  apiKey: '',
  modelName: '',
  modelMaxContext: 128_000,
  supportsImageInput: false,
  supportsPdfInput: false,
  supportsVideoInput: false,
  supportsAudioInput: false,
}

export type ModelCapabilitiesResult =
  | {
    status: 'ok'
    maxContextTokens?: number
    maxOutputTokens?: number
    image: boolean
    pdf: boolean
    video: boolean
    audio: boolean
  }
  | { status: 'not-found' }
  | { status: 'network-error' }

export type ModelConnectivityResult =
  | { status: 'ok'; models: number }
  | { status: 'network-error'; detail: string }
  | { status: 'auth-error'; detail: string }
  | { status: 'model-not-found'; available: string[] }
  | { status: 'endpoint-error'; detail: string }

export type ContextManagementConfig = {
  layeredEnabled: boolean
  filterEnabled: boolean
  rewriteEnabled: boolean
  truncateEnabled: boolean
  /** Default mode: hard cap on model input tokens (compression trigger line). */
  maxInputTokens: number
  recentKeepRounds: number
  hotTokenBudget: number
  warmTokenBudget: number
  coldRecallTokenBudget: number
  /** Developer-only conversation override for a custom Rhai strategy. */
  customStrategyEnabled?: boolean
  customStrategyScript?: string
  /** User-authored prompt describing the custom strategy; injected into the
   *  system message when the custom strategy is active. May be empty. */
  customStrategyPrompt?: string
}

export const defaultStrategyPrompt = [
  'Older conversation history may be filtered, rewritten, or truncated to fit the input budget.',
  'Treat the retained messages as the conversation record; missing older exchanges were compressed away by the context policy.',
].join('\n')

export const layeredStrategyPrompt = [
  'Hot context is the only context sent to you. Messages are never compressed while resident in Hot; recalled summaries remain explicitly labeled and non-authoritative. Warm context is never sent directly.',
  'Hot is organized into Permanent system rules, Long-term durable preferences, and Newborn current or recalled content. Long-term preferences are retained only when the user clearly states one.',
  'Any recalled summary is explicitly labeled SUMMARY — LOSSY, NOT AUTHORITATIVE and includes Cold truth references. Treat it only as a locator; use context_read for exact facts, code, logs, dates, numbers, tool arguments, or prior decisions.',
  'Use context_search to find older context and context_read to read selected exact truth or labeled summary records into the current Hot request.',
  'Tool calls and tool results are retained unchanged in Cold truth. Read the truth record whenever exact tool data matters.',
].join('\n')

export const defaultContextManagementConfig: ContextManagementConfig = {
  layeredEnabled: false,
  filterEnabled: true,
  rewriteEnabled: true,
  truncateEnabled: true,
  maxInputTokens: 0,
  recentKeepRounds: 5,
  hotTokenBudget: 64_000,
  warmTokenBudget: 32_000,
  coldRecallTokenBudget: 8_000,
  customStrategyEnabled: false,
  customStrategyScript: '',
  customStrategyPrompt: '',
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

/**
 * Derives experienced context budgets from a model's windows.
 *
 * input = floor(max((total - output) * 0.95, total * 0.618)) where output is
 * the model's max output tokens when known, otherwise half the context window.
 * warm = floor(input * 10); cold recall = floor(input * 0.1).
 */
export function deriveContextBudgets(total: number, maxOutputTokens?: number): {
  maxInputTokens: number
  hotTokenBudget: number
  warmTokenBudget: number
  coldRecallTokenBudget: number
} {
  const context = Math.floor(total)
  const output = maxOutputTokens !== undefined && maxOutputTokens >= 1
    ? Math.floor(maxOutputTokens)
    : Math.floor(context / 2)
  const input = Math.max(1, Math.floor(Math.max((context - output) * 0.95, context * 0.618)))
  return {
    maxInputTokens: input,
    hotTokenBudget: input,
    warmTokenBudget: Math.floor(input * 10),
    coldRecallTokenBudget: Math.floor(input * 0.1),
  }
}

/** The max input tokens to use when no explicit value is configured. */
export function resolveMaxInputTokens(config: ContextManagementConfig, total: number, maxOutputTokens?: number): number {
  if (Number.isFinite(config.maxInputTokens) && config.maxInputTokens >= 1) {
    return Math.min(Math.floor(config.maxInputTokens), Math.max(1, Math.floor(total)))
  }
  return deriveContextBudgets(total, maxOutputTokens).maxInputTokens
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
  maxInputTokens: number
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

export type CommandInterpreter = 'pwsh51' | 'pwsh7' | 'bash'
export type CommandEnvironment = 'bare' | 'wsl2' | 'docker' | 'windows-sandbox'

/** Developer-mode command-execution settings. The interpreter/environment
 *  matrix is constrained: v1 implements bare+bash; the remaining combos are
 *  reserved architecture openings. */
export type CommandExecutionConfig = {
  enabled: boolean
  /** Default interpreter/environment when the model does not override them. */
  interpreter: CommandInterpreter
  environment: CommandEnvironment
  /** Which environments each interpreter may run in (per-interpreter allowlist).
   *  The model may override interpreter/environment per call, but only within
   *  these enabled combos. */
  enabledEnvironments: Record<CommandInterpreter, CommandEnvironment[]>
  /** Rule interception is always active; this flag mirrors the UI switch that
   *  cannot be turned off (kept for forward compatibility). */
  ruleInterception: true
  modelAuditEnabled: boolean
  /** Model configuration id used for auditing; must resolve to a model whose
   *  modelName differs from the session model (case-insensitive). */
  auditModelConfigId: string | null
  manualConfirmationEnabled: boolean
  /** Extra deny rules (regex source) on top of the built-in blocklist. */
  denyRules: string[]
}

export const defaultCommandExecutionConfig: CommandExecutionConfig = {
  enabled: false,
  interpreter: 'bash',
  environment: 'bare',
  enabledEnvironments: {
    bash: ['bare'],
    pwsh7: ['bare'],
    pwsh51: ['bare'],
  },
  ruleInterception: true,
  modelAuditEnabled: false,
  auditModelConfigId: null,
  manualConfirmationEnabled: false,
  denyRules: [],
}

/** Commands may request their own timeout (seconds); the hard bounds. */
export const commandTimeoutMinSeconds = 1
export const commandTimeoutMaxSeconds = 86_400
/** Without manual confirmation, requested timeouts are clamped to this. */
export const commandTimeoutClampSeconds = 600
/** Requests above this require manual confirmation when it is enabled. */
export const commandConfirmationThresholdSeconds = 60
export const supportedCommandCombos: Array<{ interpreter: CommandInterpreter; environment: CommandEnvironment }> = [
  { interpreter: 'bash', environment: 'bare' },
  { interpreter: 'pwsh7', environment: 'bare' },
  { interpreter: 'pwsh51', environment: 'bare' },
  { interpreter: 'bash', environment: 'wsl2' },
  { interpreter: 'bash', environment: 'docker' },
  { interpreter: 'pwsh51', environment: 'docker' },
  { interpreter: 'pwsh7', environment: 'docker' },
]

/** Docker images used for sandboxed command execution. */
export const dockerBashImage = 'alpine:latest'
export const dockerPwshImage = 'mcr.microsoft.com/powershell:latest'

export function commandExecutionSupported(interpreter: CommandInterpreter, environment: CommandEnvironment): boolean {
  return supportedCommandCombos.some((combo) => combo.interpreter === interpreter && combo.environment === environment)
}

/** Manual wsl2 sandbox configuration (distro + sandbox user, no password). */
export type Wsl2ManualConfig = {
  distro: string
  sandboxUser: string
}

export type Wsl2SandboxProbe = {
  configured: boolean
  distro?: string
  sandboxUser?: string
  /** bwrap (bubblewrap) presence: gates the wsl2+bwrap combo. */
  bwrapAvailable: boolean
  /** socat presence: missing means the sandbox cannot proxy network work. */
  socatAvailable: boolean
  /** /etc/wsl.conf [interop] enabled; true is a sandbox-escape risk. */
  interopEnabled: boolean
  /** True when wsl.conf had no explicit [interop] enabled=false (defaults on). */
  interopExplicit: boolean
}

export type ShellDetectionResult = {
  interpreters: Array<{
    kind: CommandInterpreter
    available: boolean
    /** For git-bash under the bare environment: the resolved bash.exe path. */
    executablePath?: string
    detail: string
  }>
  environments: Array<{
    kind: CommandEnvironment
    available: boolean
    detail: string
  }>
  /** wsl2 sandbox details (bwrap/socat/interop) when a manual config exists. */
  wsl2Sandbox?: Wsl2SandboxProbe
  detectedAt: string
}

export type PromptSnapshotEntry = {
  id: string
  title: string
  scene: string
  content: string
}

export type PromptSnapshot = {
  entries: PromptSnapshotEntry[]
}

export type ToolHelpEntry = {
  name: string
  description: string
  parameters: string
  returns: string
}

export type ToolHelpSnapshot = {
  entries: ToolHelpEntry[]
}

export type Conversation = {
  id: string
  title: string
  archived: boolean
  modelConfigId: string | null
  contextConfigOverride: ContextManagementConfig | null
  /** Last context config saved per model config id; restored when the
   *  conversation switches back to that model. */
  perModelContextConfigs?: Record<string, ContextManagementConfig>
  agentLimits: AgentLimitsConfig
  commandExecution: CommandExecutionConfig
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
  commandExecutionDefault: CommandExecutionConfig
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
  maxInputTokens: number
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
  maxInputTokens: number
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
