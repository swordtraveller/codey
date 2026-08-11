interface RuntimeInfo {
  readonly electron: string
}

type ModelConfig = {
  baseUrl: string
  apiKey: string
  modelName: string
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

type ChatResult = {
  reply?: string
  error?: string
}

declare global {
  interface Window {
    readonly runtime?: RuntimeInfo
    readonly codey: {
      getConfig(): Promise<ModelConfig>
      saveConfig(config: ModelConfig): Promise<ModelConfig>
      chat(messages: ChatMessage[]): Promise<ChatResult>
    }
  }
}

export {}
