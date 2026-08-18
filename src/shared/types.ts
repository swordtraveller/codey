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
}

export type AppConfig = {
  modelConfigs: ModelConfig[]
  activeModelConfigId: string | null
  contextManagement: ContextManagementConfig
  language: AppLanguage
}

export const defaultAppConfig: AppConfig = {
  modelConfigs: [],
  activeModelConfigId: null,
  contextManagement: defaultContextManagementConfig,
  language: 'system',
}

export type ModelConfigSnapshot = Omit<ModelConfig, 'apiKey'>

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
  | { type: 'function_call'; id: string; name: string; parameters: string }

export type ContextCompressionNotice = {
  originalTokens: number
  compressedTokens: number
  compressionRatio: number
  method: string
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  blocks?: AssistantMessageBlock[]
  compression?: ContextCompressionNotice
  modelConfig?: ModelConfigSnapshot
  contextConfig?: ContextManagementConfig
}

export type AgentContextMessage = {
  role: ChatMessage['role'] | 'tool'
  content: string | null
  toolCalls?: unknown[]
  toolCallId?: string
}

export type Conversation = {
  id: string
  title: string
  modelConfigId: string | null
  contextConfigOverride: ContextManagementConfig | null
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
  defaultModelConfigId: string | null
  contextConfigOverride: ContextManagementConfig | null
  folders: ProjectFolder[]
  pythonEnvironmentFolderId: string | null
  conversations: Conversation[]
}

export type DevelopmentProgress = {
  projectId: string
  conversationId: string
  blocks: AssistantMessageBlock[]
}

export type DevelopmentResult = {
  project?: Project
  writtenFiles: string[]
  error?: string
}
