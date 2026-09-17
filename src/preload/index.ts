import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentLimitsConfig,
  AppConfig,
  CommandApprovalRequest,
  CommandApprovalResponse,
  ContextManagementConfig,
  ConversationStateChange,
  DevelopmentProgress,
  DevelopmentProgressState,
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
} from '../shared/types'
import type { BridgeChannelStatus } from '../shared/bridge'

contextBridge.exposeInMainWorld(
  'runtime',
  Object.freeze({ electron: process.versions.electron }),
)

contextBridge.exposeInMainWorld(
  'codey',
  Object.freeze({
    getConfig: () => ipcRenderer.invoke('config:get'),
    getPerformanceTraceStatus: (): Promise<PerformanceTraceStatus> => ipcRenderer.invoke('performance:get-status'),
    listPerformanceTraceFiles: (): Promise<PerformanceTraceFile[]> => ipcRenderer.invoke('performance:list-files'),
    readPerformanceTraceFile: (fileName: string): Promise<string> => ipcRenderer.invoke('performance:read-file', fileName),
    openPerformanceTraceFile: (fileName: string): Promise<void> => ipcRenderer.invoke('performance:open-file', fileName),
    setPerformanceTracingEnabled: (enabled: boolean): Promise<PerformanceTraceStatus> => ipcRenderer.invoke('performance:set-enabled', enabled),
    exportPerformanceTraces: (): Promise<string | null> => ipcRenderer.invoke('performance:export'),
    revealPerformanceTraces: (): Promise<void> => ipcRenderer.invoke('performance:reveal'),
    recordPerformanceTrace: (event: PerformanceTraceEvent): void => { ipcRenderer.send('performance:record', event) },
    saveConfig: (config: AppConfig) => ipcRenderer.invoke('config:save', config),
    fetchModelCapabilities: (modelName: string): Promise<ModelCapabilitiesResult> =>
      ipcRenderer.invoke('models:fetch-capabilities', modelName),
    testModelConnectivity: (model: ModelConfig): Promise<ModelConnectivityResult> =>
      ipcRenderer.invoke('models:test-connectivity', model),
    testProviderConnectivity: (provider: { baseUrl: string; apiKey: string }): Promise<ModelConnectivityResult> =>
      ipcRenderer.invoke('models:test-provider', provider),
    listProviderModels: (provider: { baseUrl: string; apiKey: string }): Promise<{ status: 'ok'; models: string[] } | { status: 'error'; detail: string }> =>
      ipcRenderer.invoke('models:list-provider-models', provider),
    getProjects: () => ipcRenderer.invoke('projects:get'),
    listSkills: (): Promise<InstalledSkill[]> => ipcRenderer.invoke('skills:list'),
    previewGitHubSkill: (url: string): Promise<SkillImportPreview> => ipcRenderer.invoke('skills:preview-github', url),
    installSkillPreview: (previewId: string, selectedCandidateIds: string[]): Promise<InstalledSkill> =>
      ipcRenderer.invoke('skills:install-preview', previewId, selectedCandidateIds),
    removeSkill: (skillId: string): Promise<void> => ipcRenderer.invoke('skills:remove', skillId),
    getBridgeChannels: (): Promise<BridgeChannelStatus[]> => ipcRenderer.invoke('bridge:status'),
    createBridgeChannel: (bridgeUrl: string): Promise<BridgeChannelStatus> => ipcRenderer.invoke('bridge:create', bridgeUrl),
    approveBridgeRequest: (channelId: string, requestId: string, devicePublicKey: JsonWebKey): Promise<BridgeChannelStatus[]> => ipcRenderer.invoke('bridge:approve', channelId, requestId, devicePublicKey),
    rejectBridgeRequest: (channelId: string, requestId: string): Promise<BridgeChannelStatus[]> => ipcRenderer.invoke('bridge:reject', channelId, requestId),
    syncBridge: (channelId?: string): Promise<BridgeChannelStatus[]> => ipcRenderer.invoke('bridge:sync', channelId),
    refreshBridgeEnrollment: (channelId: string): Promise<BridgeChannelStatus> => ipcRenderer.invoke('bridge:refresh', channelId),
    removeBridgeChannel: (channelId: string): Promise<BridgeChannelStatus[]> => ipcRenderer.invoke('bridge:remove', channelId),
    createProject: (name: string) => ipcRenderer.invoke('projects:create', name),
    addProjectFolder: (projectId: string) =>
      ipcRenderer.invoke('projects:add-folder', projectId),
    setProjectModelConfig: (projectId: string, modelConfigId: string | null) =>
      ipcRenderer.invoke('projects:set-model-config', projectId, modelConfigId),
    setProjectContextConfig: (
      projectId: string,
      contextConfig: ContextManagementConfig | null,
    ) => ipcRenderer.invoke('projects:set-context-config', projectId, contextConfig),
    setProjectSkillSelection: (projectId: string, selection: ResourceSelectionOverride): Promise<Project> =>
      ipcRenderer.invoke('projects:set-skill-selection', projectId, selection),
    setProjectArchived: (projectId: string, archived: boolean) =>
      ipcRenderer.invoke('projects:set-archived', projectId, archived),
    createConversation: (projectId: string) =>
      ipcRenderer.invoke('conversations:create', projectId),
    setConversationModelConfig: (
      projectId: string,
      conversationId: string,
      modelConfigId: string | null,
    ) => ipcRenderer.invoke(
      'conversations:set-model-config',
      projectId,
      conversationId,
      modelConfigId,
    ),
    setConversationContextConfig: (
      projectId: string,
      conversationId: string,
      contextConfig: ContextManagementConfig | null,
    ) => ipcRenderer.invoke(
      'conversations:set-context-config',
      projectId,
      conversationId,
      contextConfig,
    ),
    setConversationSkillSelection: (
      projectId: string,
      conversationId: string,
      selection: ResourceSelectionOverride,
    ): Promise<Project> => ipcRenderer.invoke(
      'conversations:set-skill-selection',
      projectId,
      conversationId,
      selection,
    ),
    setConversationAgentLimits: (
      projectId: string,
      conversationId: string,
      agentLimits: AgentLimitsConfig | null,
    ) => ipcRenderer.invoke(
      'conversations:set-agent-limits',
      projectId,
      conversationId,
      agentLimits,
    ),
    setConversationCommandExecution: (
      projectId: string,
      conversationId: string,
      commandExecution: CommandExecutionConfig | null,
    ) => ipcRenderer.invoke(
      'conversations:set-command-execution',
      projectId,
      conversationId,
      commandExecution,
    ),
    setProjectCommandExecutionDefault: (
      projectId: string,
      commandExecution: CommandExecutionConfig | null,
    ) => ipcRenderer.invoke(
      'projects:set-command-execution-default',
      projectId,
      commandExecution,
    ),
    setProjectAgentLimitsDefault: (
      projectId: string,
      agentLimits: AgentLimitsConfig | null,
    ) => ipcRenderer.invoke(
      'projects:set-agent-limits-default',
      projectId,
      agentLimits,
    ),
    onCommandReviewRequest: (listener: (request: CommandApprovalRequest) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, request: CommandApprovalRequest) => listener(request)
      ipcRenderer.on('command-review:request', handler)
      return () => ipcRenderer.removeListener('command-review:request', handler)
    },
    respondCommandReview: (requestId: string, response: CommandApprovalResponse) =>
      ipcRenderer.invoke('command-review:respond', requestId, response),
    detectShells: (): Promise<ShellDetectionResult> => ipcRenderer.invoke('shells:detect'),
    getCachedShellDetection: (): Promise<ShellDetectionResult | null> => ipcRenderer.invoke('shells:cached'),
    pickBashExecutable: (): Promise<string | null> => ipcRenderer.invoke('shells:pick-bash'),
    listWslDistros: (): Promise<string[]> => ipcRenderer.invoke('shells:list-wsl-distros'),
    getWsl2ManualConfig: (): Promise<Wsl2ManualConfig | null> => ipcRenderer.invoke('shells:get-wsl2-config'),
    setWsl2ManualConfig: (config: Wsl2ManualConfig | null): Promise<void> => ipcRenderer.invoke('shells:set-wsl2-config', config),
    getPromptSnapshot: (): Promise<PromptSnapshot> => ipcRenderer.invoke('prompts:snapshot'),
    getToolHelpSnapshot: (): Promise<ToolHelpSnapshot> => ipcRenderer.invoke('tools:help-snapshot'),
    setConversationArchived: (projectId: string, conversationId: string, archived: boolean) =>
      ipcRenderer.invoke('conversations:set-archived', projectId, conversationId, archived),
    setConversationReadState: (projectId: string, conversationId: string, lastReadMessageId: string | null, lastReadAt: number | null) =>
      ipcRenderer.invoke('conversations:set-read-state', projectId, conversationId, lastReadMessageId, lastReadAt),
    develop: (projectId: string, conversationId: string, content: string, images: ImageAttachment[] = [], attachments: MediaAttachment[] = [], traceId?: string) =>
      ipcRenderer.invoke('development:send', projectId, conversationId, content, images, attachments, traceId),
    screenshot: (hideWindow: boolean) => ipcRenderer.invoke('clipboard:screenshot', hideWindow),
    onScreenshotSource: (listener: (source: ScreenshotSource) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, source: ScreenshotSource) => listener(source)
      ipcRenderer.on('screenshot:source', handler)
      ipcRenderer.send('clipboard:screenshot-ready')
      return () => ipcRenderer.removeListener('screenshot:source', handler)
    },
    completeScreenshotSelection: (captureId: string, selection: ScreenshotSelection) =>
      ipcRenderer.send('clipboard:screenshot-complete', captureId, selection),
    cancelScreenshotSelection: (captureId: string) =>
      ipcRenderer.send('clipboard:screenshot-cancel', captureId),
    stopDevelopment: (projectId: string, conversationId: string) =>
      ipcRenderer.invoke('development:stop', projectId, conversationId),
    subscribeDevelopmentProgress: (
      projectId: string | null,
      conversationId: string | null,
    ): Promise<DevelopmentProgressState> =>
      ipcRenderer.invoke('development:subscribe', projectId, conversationId),
    openFrontendPreview: (projectId: string, conversationId: string, serverId: string) =>
      ipcRenderer.invoke('frontend:open-preview', projectId, conversationId, serverId),
    onDevelopmentProgress: (listener: (progress: DevelopmentProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: DevelopmentProgress) =>
        listener(progress)
      ipcRenderer.on('development:progress', handler)
      return () => ipcRenderer.removeListener('development:progress', handler)
    },
    onConversationStateChange: (listener: (change: ConversationStateChange) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, change: ConversationStateChange) =>
        listener(change)
      ipcRenderer.on('conversation:state-change', handler)
      return () => ipcRenderer.removeListener('conversation:state-change', handler)
    },
    onProjectUpdated: (listener: (project: Project) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, project: Project) => listener(project)
      ipcRenderer.on('project:updated', handler)
      return () => ipcRenderer.removeListener('project:updated', handler)
    },
    openContextDebug: (projectId: string, conversationId: string) =>
      ipcRenderer.invoke('context-debug:open', projectId, conversationId),
    getContextDebugOverview: (projectId: string, conversationId: string) =>
      ipcRenderer.invoke('context-debug:overview', projectId, conversationId),
    getContextDebugRevision: (projectId: string, conversationId: string) =>
      ipcRenderer.invoke('context-debug:revision', projectId, conversationId),
    readColdMessage: (projectId: string, conversationId: string, messageId: string) =>
      ipcRenderer.invoke('context-debug:read-cold', projectId, conversationId, messageId),
    readContextLayerMessage: (projectId: string, conversationId: string, messageId: string) =>
      ipcRenderer.invoke('context-debug:read-layer', projectId, conversationId, messageId),
    searchColdContext: (projectId: string, conversationId: string, query: string) =>
      ipcRenderer.invoke('context-debug:search', projectId, conversationId, query),
    promoteContext: (projectId: string, conversationId: string, messageId: string) =>
      ipcRenderer.invoke('context-debug:promote', projectId, conversationId, messageId),
    setContextPin: (projectId: string, conversationId: string, messageId: string, pinnedToHot: boolean) =>
      ipcRenderer.invoke('context-debug:set-pin', projectId, conversationId, messageId, pinnedToHot),
    demoteContext: (projectId: string, conversationId: string, messageId?: string) =>
      ipcRenderer.invoke('context-debug:demote', projectId, conversationId, messageId),
    unpinLowestPriorityContext: (projectId: string, conversationId: string) =>
      ipcRenderer.invoke('context-debug:unpin-lowest', projectId, conversationId),
    simulateTokenLimit: (projectId: string, conversationId: string, requestTokens: number) =>
      ipcRenderer.invoke('context-debug:simulate', projectId, conversationId, requestTokens),
    showNotification: (payload: { type: string; title: string; body: string; projectId?: string; conversationId?: string; messageId?: string }) =>
      ipcRenderer.invoke('notifications:show', payload),
    getNotificationSettings: () => ipcRenderer.invoke('notifications:get-settings'),
    setNotificationSettings: (settings: any) => ipcRenderer.invoke('notifications:set-settings', settings),
    onNotificationClicked: (callback: (data: { conversationId?: string; projectId?: string; messageId?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipcRenderer.on('notification:clicked', handler)
      return () => ipcRenderer.removeListener('notification:clicked', handler)
    },
  }),
)
