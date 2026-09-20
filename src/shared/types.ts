import type { ImageAttachment } from './image-attachments'
import type { MediaAttachment, MediaAttachmentMediaType, MediaKind } from './media-attachments'
export type { ImageAttachment, ImageMediaType } from './image-attachments'
export type { MediaAttachment, MediaAttachmentMediaType, MediaKind, AudioMediaType, VideoMediaType, PdfMediaType } from './media-attachments'

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

/** A model provider: an OpenAI-compatible endpoint plus credentials. */
export type ProviderConfig = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
}

export const defaultProviderConfig: ProviderConfig = {
  id: '',
  name: '',
  baseUrl: '',
  apiKey: '',
}

/** A named model definition: API model name plus window and modality
 *  capabilities. Shared across providers — a Model combines it with one. */
export type ModelDefinition = {
  id: string
  modelName: string
  modelMaxContext: number
  modelMaxOutputTokens?: number
  supportsImageInput?: boolean
  supportsPdfInput?: boolean
  supportsVideoInput?: boolean
  supportsAudioInput?: boolean
}

export const defaultModelDefinition: ModelDefinition = {
  id: '',
  modelName: '',
  modelMaxContext: 128_000,
  supportsImageInput: false,
  supportsPdfInput: false,
  supportsVideoInput: false,
  supportsAudioInput: false,
}

/** A model = one provider + one model definition. The id is the stable
 *  reference used by projects, conversations, and model groups. */
export type ModelLink = {
  id: string
  name: string
  providerId: string
  definitionId: string
}

export const defaultModelLink: ModelLink = {
  id: '',
  name: '',
  providerId: '',
  definitionId: '',
}

/** Default attempts per chain member before failing over. */
export const modelGroupDefaultRetries = 3
export const modelGroupMinRetries = 1
export const modelGroupMaxRetries = 10

/** An ordered failover group of models. */
export type ModelGroupConfig = {
  id: string
  name: string
  modelIds: string[]
  retriesPerModel: number
}

/** One executable member of a resolved target's failover chain. */
export type ModelChainMember = {
  modelId: string
  label: string
  providerName?: string
  baseUrl: string
  apiKey: string
  modelName: string
}

/** The flattened runtime config the whole pipeline keeps consuming: envelope
 *  fields (weakest member for groups) plus the executable chain. baseUrl /
 *  apiKey / modelName mirror the first member for logging compatibility. */
export type RuntimeModelConfig = ModelConfig & {
  chain: ModelChainMember[]
  retriesPerModel: number
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
  /** Automatically derive tokens budget using formula when true. */
  autoBudgetEnabled?: boolean
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
  autoBudgetEnabled: true,
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

/** One blacklist/whitelist entry. Users author glob patterns
 *  (`git *`, `pnpm test ?`); the regex patternType is reserved for the
 *  built-in defaults and legacy migrated rules. */
export type CommandReviewRule = {
  id: string
  pattern: string
  patternType: 'glob' | 'regex'
  list: 'allow' | 'deny'
  source: 'builtin' | 'user' | 'approval'
  note?: string
  enabled: boolean
  createdAt?: string
}

/** Review settings shared by the three layers (global/project/conversation):
 *  what gets reviewed (elements) and who reviews (reviewers, fixed order). */
export type CommandReviewConfig = {
  /** Duration reference handed to the audit model (it judges whether the
   *  requested duration is reasonable) and the fallback duration when the
   *  model declares none. It never authorizes passage by itself. */
  durationAllowSeconds: number
  contentRules: CommandReviewRule[]
  /** Program rules always run; only the optional reviewers are listed here.
   *  Fixed order: program rules → audit model → manual confirmation. A
   *  whitelist hit is treated as passing the whole chain. */
  reviewers: {
    auditModel: boolean
    /** Model configuration id used for auditing; must resolve to a model whose
     *  modelName differs from the session model (case-insensitive). */
    auditModelConfigId: string | null
    manualConfirmation: boolean
  }
}

/** Built-in deny rules as editable default content (regex, case-insensitive
 *  against the whole command). They seed the global layer only; users may
 *  edit or remove them like any other rule. */
export const builtinCommandDenyPatterns: string[] = [
  '\\bformat\\s+[a-z]:',
  '\\bcd\\s+[a-z]:\\\\?\\s*&&\\s*(del|rd|format)',
  '\\brd\\s+\\/s\\s+\\/q\\s+%?(systemroot|windir|programfiles)',
  '\\breg(\\.exe)?\\s+(delete|add)\\s+(HKLM|HKCU)\\\\(system|software\\\\microsoft\\\\windows\\\\currentversion\\\\run)',
  '\\bbcdedit\\b',
  '\\bdiskpart\\b',
  '\\bcipher\\s+\\/w',
  '\\bshutdown\\b|\\brestart-computer\\b',
  '\\bvssadmin\\b',
  '\\bwevtutil\\s+cl\\b',
  '\\bpowershell.+-enc(odedcommand)?\\s+[a-z0-9+/=]{40,}',
  '\\b(curl|wget|invoke-webrequest|invoke-restmethod)\\b[^\\n|;]*\\|\\s*(cmd|powershell|pwsh|bash|iex|invoke-expression)',
  '\\bnet\\s+user\\b[^\\n]*\\/(add|delete)',
  '\\bschtasks\\b[^\\n]*\\/(create|delete)',
  '\\bsc(\\.exe)?\\s+(config|delete|stop|start)\\b',
  '\\bremove-item\\b[^\\n]*-recurse[^\\n]*-force[^\\n]*(c:\\\\|\\/etc\\/|~\\/?\\s*$)',
  '\\bgit\\s+push\\b[^\\n]*--force',
]

export function createBuiltinReviewRules(): CommandReviewRule[] {
  return builtinCommandDenyPatterns.map((pattern, index) => ({
    id: `builtin-${index + 1}`,
    pattern,
    patternType: 'regex',
    list: 'deny',
    source: 'builtin',
    enabled: true,
  }))
}

export const commandReviewDurationDefaultSeconds = 180
export const commandReviewDurationMinSeconds = 60
export const commandReviewDurationMaxSeconds = 86_400

export const defaultCommandReviewConfig: CommandReviewConfig = {
  durationAllowSeconds: commandReviewDurationDefaultSeconds,
  contentRules: createBuiltinReviewRules(),
  reviewers: {
    auditModel: false,
    auditModelConfigId: null,
    // On by default: unmatched commands reach a human at least once, and
    // approval memory (whitelist rules) keeps the friction low afterwards.
    manualConfirmation: true,
  },
}

/** Approval-memory form payload from the in-app approval card. */
export type CommandApprovalMemory = {
  patternType: 'exact' | 'prefix'
  scope: 'turn' | 'session' | 'project' | 'global'
  list: 'allow' | 'deny'
}

export type CommandApprovalRequest = {
  requestId: string
  command: string
  timeoutSeconds: number
  checks: string[]
  workspacePath: string
  environment: string
  /** Audit-model display name when that reviewer ran and allowed. */
  auditModelName?: string
  /** Audit-model reason text (may be empty when it simply allowed). */
  auditNote?: string
}

export type CommandApprovalResponse = {
  approved: boolean
  memory?: CommandApprovalMemory
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
  /** Review settings for run_command; null = inherit the global review
   *  defaults (AppConfig.commandReviewGlobal). */
  review: CommandReviewConfig | null
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
  review: null,
}


export type ResourceSelectionOverride = {
  enabledIds: string[]
  disabledIds: string[]
}

export const emptyResourceSelectionOverride: ResourceSelectionOverride = {
  enabledIds: [],
  disabledIds: [],
}

export type KnowledgeBaseMode = 'rg' | 'rag'

export type KnowledgeBaseStatus = 'ready' | 'indexing' | 'error' | 'model-required'

export type LocalEmbeddingProviderConfig = {
  kind: 'local'
  modelId: string
}

export type RemoteEmbeddingProviderConfig = {
  kind: 'remote'
  providerId: string
  modelId: string
}

export type EmbeddingProviderConfig = LocalEmbeddingProviderConfig | RemoteEmbeddingProviderConfig

export const defaultLocalEmbeddingModelId = 'Xenova/bge-small-zh-v1.5'

export type KnowledgeBase = {
  id: string
  name: string
  source: { kind: 'local-directory'; path: string }
  mode: KnowledgeBaseMode
  embeddingProvider: EmbeddingProviderConfig | null
  status: KnowledgeBaseStatus
  fileCount: number
  totalBytes: number
  createdAt: string
  updatedAt: string
  indexedAt: string | null
  error?: string
}

export type KnowledgeBaseSearchResult = {
  knowledgeBaseId: string
  knowledgeBaseName: string
  sourcePath: string
  relativePath: string
  lineStart?: number
  lineEnd?: number
  content: string
  score?: number
}

export type KnowledgeBaseModelProgress = {
  knowledgeBaseId?: string
  modelId: string
  status: 'downloading' | 'ready' | 'error'
  progress?: number
  file?: string
  error?: string
}

export type SkillToolRuntime = 'node' | 'python'

export type SkillTool = {
  id: string
  name: string
  description: string
  runtime: SkillToolRuntime
  entry: string
  timeoutMs: number
}

export type InstalledSkill = {
  id: string
  name: string
  description: string
  sourceUrl: string
  sourceOwner: string
  sourceRepo: string
  sourcePath: string
  sourceCommitSha: string
  packageSha256: string
  installedAt: string
  instructions: string
  tools: SkillTool[]
}

export type SkillImportCandidate = {
  id: string
  name: string
  runtime: SkillToolRuntime
  entry: string
  description: string
}

export type SkillImportPreview = {
  previewId: string
  skillId: string
  name: string
  description: string
  sourceUrl: string
  sourceCommitSha: string
  sourcePath: string
  fileCount: number
  totalBytes: number
  candidates: SkillImportCandidate[]
}

export type McpStdioServerConfig = {
  id: string
  name: string
  enabled: boolean
  command: string
  args: string[]
  env: Record<string, string>
  cwdMode: 'project-root' | 'custom'
  customCwd?: string
}

export type McpServerTestResult = {
  status: 'ok' | 'error'
  serverName?: string
  serverVersion?: string
  toolNames: string[]
  stderr?: string
  error?: string
}

export type AppConfig = {
  /** Legacy flat list — kept only for read-migration into the four-layer
   *  structure below; always empty after migration. */
  modelConfigs: ModelConfig[]
  providers: ProviderConfig[]
  modelDefinitions: ModelDefinition[]
  models: ModelLink[]
  modelGroups: ModelGroupConfig[]
  /** Global default target: a model id or a model group id. */
  activeModelConfigId: string | null
  contextManagement: ContextManagementConfig
  language: AppLanguage
  developerMode: boolean
  keepAwakeEnabled: boolean
  keepAwakeOnlyWhileWorking: boolean
  networkAccessEnabled: boolean
  performanceTracingEnabled: boolean
  /** Global command-review defaults; projects and conversations may override. */
  commandReviewGlobal: CommandReviewConfig
  /** Global command-execution defaults (interpreter, environment, enabled
   *  combos); projects and conversations may override. Review stays null
   *  here — the global review config above owns it. */
  commandExecutionGlobal: CommandExecutionConfig
  /** Global agent-limits defaults; projects and conversations may override. */
  agentLimitsGlobal: AgentLimitsConfig
  /** Skills enabled by default for every project. Users manage this list explicitly. */
  defaultSkillIds: string[]
  /** Knowledge bases enabled by default for every project. */
  defaultKnowledgeBaseIds: string[]
  /** User-managed local MCP servers. Enabled entries are started for each agent run. */
  mcpServers: McpStdioServerConfig[]
}

export const defaultAppConfig: AppConfig = {
  modelConfigs: [],
  providers: [],
  modelDefinitions: [],
  models: [],
  modelGroups: [],
  activeModelConfigId: null,
  contextManagement: defaultContextManagementConfig,
  language: 'system',
  developerMode: false,
  keepAwakeEnabled: false,
  keepAwakeOnlyWhileWorking: true,
  networkAccessEnabled: false,
  performanceTracingEnabled: false,
  commandReviewGlobal: { ...defaultCommandReviewConfig },
  commandExecutionGlobal: { ...defaultCommandExecutionConfig, review: null },
  agentLimitsGlobal: { ...defaultAgentLimitsConfig },
  defaultSkillIds: [],
  defaultKnowledgeBaseIds: [],
  mcpServers: [],
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

/** One review step in the run_command approval chain, rendered on the tool
 *  call card. Non-run_command tools get a single default-allow entry. */
export type CommandReviewStep = {
  stage: 'rules' | 'audit-model' | 'manual-confirmation' | 'duration' | 'execution'
  outcome: 'pass' | 'deny' | 'skipped' | 'clamped' | 'info'
  detail?: string
}

export type AssistantMessageBlock =
  | { type: 'content'; content: string }
  | { type: 'function_call'; id: string; name: string; parameters: string; result?: string; resultError?: boolean; review?: CommandReviewStep[] }

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
  attachments?: MediaAttachment[]
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
  attachments?: MediaAttachment[]
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

/** Commands may request their own timeout (seconds); the hard bounds. */
export const commandTimeoutMinSeconds = 1
export const commandTimeoutMaxSeconds = 86_400

export const supportedCommandCombos: Array<{ interpreter: CommandInterpreter; environment: CommandEnvironment }> = [
  { interpreter: 'bash', environment: 'bare' },
  { interpreter: 'bash', environment: 'docker' },
  { interpreter: 'bash', environment: 'wsl2' },
  { interpreter: 'pwsh7', environment: 'bare' },
  { interpreter: 'pwsh7', environment: 'docker' },
  { interpreter: 'pwsh7', environment: 'wsl2' },
  { interpreter: 'pwsh51', environment: 'bare' },
  { interpreter: 'pwsh51', environment: 'docker' },
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
  /** Interpreter availability inside the probed wsl2 distro (wsl2 runs the
   *  interpreter in-distro, so the host interpreter check does not apply). */
  wsl2Interpreters?: { bash: boolean; pwsh7: boolean }
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
  /** Toolset this tool belongs to; absent for the meta tool. */
  toolset?: string
  /** True when the toolset stays hidden until unlocked via find_hidden_toolset. */
  toolsetHidden?: boolean
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
  /** Hidden toolsets unlocked in this conversation (e.g. ["python"]); the
   *  matching tools are included in every model request once unlocked. */
  unlockedToolsets?: string[]
  /** Explicit per-conversation skill deltas over the project selection. */
  skillSelection: ResourceSelectionOverride
  /** Explicit per-conversation knowledge-base deltas over the project selection. */
  knowledgeBaseSelection: ResourceSelectionOverride
  /** Agent-limits override; null = inherit the project default. */
  agentLimits: AgentLimitsConfig | null
  /** Full command-execution override; null = inherit the project default. */
  commandExecution: CommandExecutionConfig | null
  messages: ChatMessage[]
  agentMessages: AgentContextMessage[]
  context?: ContextMetrics
  /** ID of the last message the user has read in this conversation. */
  lastReadMessageId?: string
  /** Timestamp when the conversation was last read (Unix timestamp in ms). */
  lastReadAt?: number
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
  /** Project-level command-execution default; null = inherit the built-in
   *  defaults plus the global review config. */
  commandExecutionDefault: CommandExecutionConfig | null
  /** Project-level agent-limits default; null = inherit the global default. */
  agentLimitsDefault: AgentLimitsConfig | null
  /** Explicit project skill deltas over global defaults. */
  skillSelection: ResourceSelectionOverride
  /** Explicit project knowledge-base deltas over global defaults. */
  knowledgeBaseSelection: ResourceSelectionOverride
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
  | { type: 'model-changed'; providerName: string; modelName: string }
  | { type: 'append'; items: DevelopmentTimelineItem[] }
  | { type: 'replace-stream'; blocks: AssistantMessageBlock[] }
  | { type: 'append-stream'; delta: DevelopmentStreamDelta }
  | { type: 'commit-stream'; items: DevelopmentTimelineItem[] }
  | { type: 'update-tool-result'; toolCallId: string; result: string; resultError: boolean }
  | { type: 'update-tool-review'; toolCallId: string; step: CommandReviewStep }

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


// --- System notifications ---

/** System notification category */
export type NotificationType =
  | 'task-complete'
  | 'task-failed'
  | 'needs-confirmation'
  | 'connection-error'
  | 'model-error'

export type NotificationOptions = {
  type: NotificationType
  title: string
  body: string
  conversationId?: string
  projectId?: string
  messageId?: string
  silent?: boolean
}

export type NotificationSettings = {
  enabled: boolean
  taskComplete: boolean
  taskFailed: boolean
  needsConfirmation: boolean
  connectionError: boolean
  modelError: boolean
  onlyWhenUnfocused: boolean
}

export const defaultNotificationSettings: NotificationSettings = {
  enabled: true,
  taskComplete: true,
  taskFailed: true,
  needsConfirmation: true,
  connectionError: true,
  modelError: true,
  onlyWhenUnfocused: true,
}
