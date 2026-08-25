import type { BridgeChannelStatus } from '../../shared/bridge'
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
  ImageAttachment,
  Project,
  ScreenshotSelection,
  ScreenshotSource,
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
      getBridgeStatus(): Promise<BridgeChannelStatus | null>
      createBridgeChannel(bridgeUrl: string): Promise<BridgeChannelStatus>
      approveBridgeRequest(requestId: string, devicePublicKey: JsonWebKey): Promise<BridgeChannelStatus | null>
      rejectBridgeRequest(requestId: string): Promise<BridgeChannelStatus | null>
      syncBridge(): Promise<BridgeChannelStatus | null>
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
        images?: ImageAttachment[],
      ): Promise<DevelopmentResult>
      stopDevelopment(projectId: string, conversationId: string): Promise<boolean>
      screenshot(hideWindow: boolean): Promise<ImageAttachment | null>
      onScreenshotSource(listener: (source: ScreenshotSource) => void): () => void
      completeScreenshotSelection(captureId: string, selection: ScreenshotSelection): void
      cancelScreenshotSelection(captureId: string): void
      openFrontendPreview(
        projectId: string,
        conversationId: string,
        serverId: string,
      ): Promise<{ status: 'opened' | 'starting' | 'stopped' | 'failed' }>
      onDevelopmentProgress(listener: (progress: DevelopmentProgress) => void): () => void
      onConversationStateChange(listener: (change: ConversationStateChange) => void): () => void
      onProjectUpdated(listener: (project: Project) => void): () => void
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
