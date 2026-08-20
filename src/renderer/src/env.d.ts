import type {
  AgentLimitsConfig,
  AppConfig,
  ColdRecallPreview,
  ContextDebugMessage,
  ContextDebugOverview,
  ContextManagementConfig,
  ConversationStateChange,
  DevelopmentProgress,
  DevelopmentResult,
  Project,
  TokenLimitSimulation,
} from '../../shared/types'

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
      setProjectContextConfig(
        projectId: string,
        contextConfig: ContextManagementConfig | null,
      ): Promise<Project>
      createConversation(projectId: string): Promise<Project>
      setConversationModelConfig(
        projectId: string,
        conversationId: string,
        modelConfigId: string | null,
      ): Promise<Project>
      setConversationContextConfig(
        projectId: string,
        conversationId: string,
        contextConfig: ContextManagementConfig | null,
      ): Promise<Project>
      setConversationAgentLimits(
        projectId: string,
        conversationId: string,
        agentLimits: AgentLimitsConfig,
      ): Promise<Project>
      develop(
        projectId: string,
        conversationId: string,
        content: string,
      ): Promise<DevelopmentResult>
      stopDevelopment(projectId: string, conversationId: string): Promise<boolean>
      onDevelopmentProgress(listener: (progress: DevelopmentProgress) => void): () => void
      onConversationStateChange(listener: (change: ConversationStateChange) => void): () => void
      openContextDebug(projectId: string, conversationId: string): Promise<void>
      getContextDebugOverview(projectId: string, conversationId: string): Promise<ContextDebugOverview>
      getContextDebugRevision(projectId: string, conversationId: string): Promise<string>
      readColdMessage(projectId: string, conversationId: string, messageId: string): Promise<ContextDebugMessage>
      readContextLayerMessage(projectId: string, conversationId: string, messageId: string): Promise<ContextDebugMessage>
      searchColdContext(projectId: string, conversationId: string, query: string): Promise<ColdRecallPreview>
      setContextPin(
        projectId: string,
        conversationId: string,
        messageId: string,
        pinnedToHot: boolean,
      ): Promise<void>
      demoteContext(projectId: string, conversationId: string, messageId?: string): Promise<void>
      simulateTokenLimit(
        projectId: string,
        conversationId: string,
        requestTokens: number,
      ): Promise<TokenLimitSimulation>
    }
  }
}

export {}
