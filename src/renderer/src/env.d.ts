import type { AppConfig, DevelopmentProgress, DevelopmentResult, Project } from '../../shared/types'

interface RuntimeInfo {
  readonly electron: string
}

declare global {
  interface Window {
    readonly runtime?: RuntimeInfo
    readonly codey: {
      getConfig(): Promise<AppConfig>
      saveConfig(config: AppConfig): Promise<AppConfig>
      getProjects(): Promise<Project[]>
      createProject(name: string): Promise<Project>
      addProjectFolder(projectId: string): Promise<Project | null>
      setProjectModelConfig(projectId: string, modelConfigId: string | null): Promise<Project>
      createConversation(projectId: string): Promise<Project>
      setConversationModelConfig(
        projectId: string,
        conversationId: string,
        modelConfigId: string | null,
      ): Promise<Project>
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
