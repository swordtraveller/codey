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

export type Project = {
  id: string
  name: string
  folders: string[]
  conversations: Conversation[]
}

export type ChatResult = {
  project?: Project
  error?: string
}
