import type { BridgeChannelStatus } from '../../shared/bridge'
import type {
  AgentLimitsConfig,
  AppConfig,
  ColdRecallPreview,
  CommandApprovalRequest,
  CommandApprovalResponse,
  ContextDebugMessage,
  ContextDebugOverview,
  ContextManagementConfig,
  ConversationStateChange,
  DevelopmentProgress,
  DevelopmentProgressState,
  DevelopmentResult,
  ImageAttachment,
  MediaAttachment,
  ModelCapabilitiesResult,
  CommandExecutionConfig,
  ModelConfig,
  ModelConnectivityResult,
  PromptSnapshot,
  ToolHelpSnapshot,
  ShellDetectionResult,
  Wsl2ManualConfig,
  Project,
  InstalledSkill,
  SkillImportPreview,
  ResourceSelectionOverride,
  PerformanceTraceEvent,
  PerformanceTraceFile,
  PerformanceTraceStatus,
  ScreenshotSelection,
  ScreenshotSource,
  TokenLimitSimulation,
  NotificationOptions,
  NotificationSettings,
} from '../../shared/types'

interface RuntimeInfo {
  readonly electron: string
}

declare global {
  interface Window {
    readonly runtime?: RuntimeInfo
    readonly codey: {
      getConfig(): Promise<AppConfig>
      getPerformanceTraceStatus(): Promise<PerformanceTraceStatus>
      listPerformanceTraceFiles(): Promise<PerformanceTraceFile[]>
      readPerformanceTraceFile(fileName: string): Promise<string>
      openPerformanceTraceFile(fileName: string): Promise<void>
      setPerformanceTracingEnabled(enabled: boolean): Promise<PerformanceTraceStatus>
      exportPerformanceTraces(): Promise<string | null>
      revealPerformanceTraces(): Promise<void>
      recordPerformanceTrace(event: PerformanceTraceEvent): void
      saveConfig(config: AppConfig): Promise<AppConfig>
      fetchModelCapabilities(modelName: string): Promise<ModelCapabilitiesResult>
      testModelConnectivity(model: ModelConfig): Promise<ModelConnectivityResult>
      testProviderConnectivity(provider: { baseUrl: string; apiKey: string }): Promise<ModelConnectivityResult>
      listProviderModels(provider: { baseUrl: string; apiKey: string }): Promise<{ status: 'ok'; models: string[] } | { status: 'error'; detail: string }>
      getProjects(): Promise<Project[]>
      listSkills(): Promise<InstalledSkill[]>
      previewGitHubSkill(url: string): Promise<SkillImportPreview>
      installSkillPreview(previewId: string, selectedCandidateIds: string[]): Promise<InstalledSkill>
      removeSkill(skillId: string): Promise<void>
      getBridgeChannels(): Promise<BridgeChannelStatus[]>
      createBridgeChannel(bridgeUrl: string): Promise<BridgeChannelStatus>
      approveBridgeRequest(channelId: string, requestId: string, devicePublicKey: JsonWebKey): Promise<BridgeChannelStatus[]>
      rejectBridgeRequest(channelId: string, requestId: string): Promise<BridgeChannelStatus[]>
      syncBridge(channelId?: string): Promise<BridgeChannelStatus[]>
      refreshBridgeEnrollment(channelId: string): Promise<BridgeChannelStatus>
      removeBridgeChannel(channelId: string): Promise<BridgeChannelStatus[]>
      createProject(name: string): Promise<Project>
      addProjectFolder(projectId: string): Promise<Project | null>
      setProjectModelConfig(projectId: string, modelConfigId: string | null): Promise<Project>
      setProjectContextConfig(
        projectId: string,
        contextConfig: ContextManagementConfig | null,
      ): Promise<Project>
      setProjectSkillSelection(projectId: string, selection: ResourceSelectionOverride): Promise<Project>
      setProjectArchived(projectId: string, archived: boolean): Promise<Project>
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
      setConversationSkillSelection(
        projectId: string,
        conversationId: string,
        selection: ResourceSelectionOverride,
      ): Promise<Project>
      setConversationAgentLimits(
        projectId: string,
        conversationId: string,
        agentLimits: AgentLimitsConfig | null,
      ): Promise<Project>
      setConversationCommandExecution(
        projectId: string,
        conversationId: string,
        commandExecution: CommandExecutionConfig | null,
      ): Promise<Project>
      setProjectCommandExecutionDefault(
        projectId: string,
        commandExecution: CommandExecutionConfig | null,
      ): Promise<Project>
      setProjectAgentLimitsDefault(
        projectId: string,
        agentLimits: AgentLimitsConfig | null,
      ): Promise<Project>
      onCommandReviewRequest(listener: (request: CommandApprovalRequest) => void): () => void
      respondCommandReview(requestId: string, response: CommandApprovalResponse): Promise<boolean>
      detectShells(): Promise<ShellDetectionResult>
      getCachedShellDetection(): Promise<ShellDetectionResult | null>
      pickBashExecutable(): Promise<string | null>
      listWslDistros(): Promise<string[]>
      getWsl2ManualConfig(): Promise<Wsl2ManualConfig | null>
      setWsl2ManualConfig(config: Wsl2ManualConfig | null): Promise<void>
      getPromptSnapshot(): Promise<PromptSnapshot>
      getToolHelpSnapshot(): Promise<ToolHelpSnapshot>
      setConversationArchived(projectId: string, conversationId: string, archived: boolean): Promise<Project>
      setConversationReadState(projectId: string, conversationId: string, lastReadMessageId: string | null, lastReadAt: number | null): Promise<Project>
      develop(
        projectId: string,
        conversationId: string,
        content: string,
        images?: ImageAttachment[],
        attachments?: MediaAttachment[],
        traceId?: string,
      ): Promise<DevelopmentResult>
      stopDevelopment(projectId: string, conversationId: string): Promise<boolean>
      subscribeDevelopmentProgress(
        projectId: string | null,
        conversationId: string | null,
      ): Promise<DevelopmentProgressState>
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
      promoteContext(projectId: string, conversationId: string, messageId: string): Promise<void>
      setContextPin(
        projectId: string,
        conversationId: string,
        messageId: string,
        pinnedToHot: boolean,
      ): Promise<void>
      demoteContext(projectId: string, conversationId: string, messageId?: string): Promise<void>
      unpinLowestPriorityContext(projectId: string, conversationId: string): Promise<void>
      simulateTokenLimit(
        projectId: string,
        conversationId: string,
        requestTokens: number,
      ): Promise<TokenLimitSimulation>
      showNotification(payload: NotificationOptions): Promise<void>
      getNotificationSettings(): Promise<NotificationSettings>
      setNotificationSettings(settings: Partial<NotificationSettings>): Promise<void>
      onNotificationClicked(callback: (data: { conversationId?: string; projectId?: string; messageId?: string }) => void): () => void
    }
  }
}

export {}
