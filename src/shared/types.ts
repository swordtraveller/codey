export type AppLanguage = 'system' | 'en' | 'zh-CN'

export type ModelConfig = {
  baseUrl: string
  apiKey: string
  modelName: string
  modelMaxContext: number
  safeOutputMargin: number
  recentKeepRounds: number
  language: AppLanguage
}

export const defaultModelConfig: ModelConfig = {
  baseUrl: '',
  apiKey: '',
  modelName: '',
  modelMaxContext: 128_000,
  safeOutputMargin: 16_000,
  recentKeepRounds: 5,
  language: 'system',
}

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
