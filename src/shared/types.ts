export type ModelConfig = {
  baseUrl: string
  apiKey: string
  modelName: string
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
}

export type Conversation = {
  id: string
  title: string
  messages: ChatMessage[]
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

export type DevelopmentResult = {
  project?: Project
  writtenFiles: string[]
  error?: string
}
