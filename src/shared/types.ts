export type AppLanguage = 'system' | 'en' | 'zh-CN'

export type ModelConfig = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  modelName: string
  modelMaxContext: number
  safeOutputMargin: number
  recentKeepRounds: number
}

export const defaultModelConfig: ModelConfig = {
  id: '',
  name: '',
  baseUrl: '',
  apiKey: '',
  modelName: '',
  modelMaxContext: 128_000,
  safeOutputMargin: 16_000,
  recentKeepRounds: 5,
}

export type AppConfig = {
  modelConfigs: ModelConfig[]
  activeModelConfigId: string | null
  language: AppLanguage
}

export const defaultAppConfig: AppConfig = {
  modelConfigs: [],
  activeModelConfigId: null,
  language: 'system',
}

export type ModelConfigSnapshot = Omit<ModelConfig, 'apiKey'>

export type ContextMetrics = {
  originalTokens: number
  compressedTokens: number
  modelMaxContext: number
  triggerThreshold: number
  compressionRatio: number
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
