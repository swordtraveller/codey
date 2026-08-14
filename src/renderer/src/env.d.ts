import type { DevelopmentProgress, DevelopmentResult, ModelConfig, Project } from '../../shared/types'

interface RuntimeInfo {
  readonly electron: string
}

declare global {
  interface Window {
    readonly runtime?: RuntimeInfo
    readonly codey: {
      getConfig(): Promise<ModelConfig>
      saveConfig(config: ModelConfig): Promise<ModelConfig>
      getProjects(): Promise<Project[]>
      createProject(name: string): Promise<Project>
      addProjectFolder(projectId: string): Promise<Project | null>
      createConversation(projectId: string): Promise<Project>
      develop(
        projectId: string,
        conversationId: string,
        content: string,
      ): Promise<DevelopmentResult>
      onDevelopmentProgress(listener: (progress: DevelopmentProgress) => void): () => void
    }
  }
}

export {}
