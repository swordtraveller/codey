import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentLimitsConfig,
  AppConfig,
  ContextManagementConfig,
  ConversationStateChange,
  DevelopmentProgress,
  DevelopmentProgressState,
  ImageAttachment,
  Project,
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
    getProjects: () => ipcRenderer.invoke('projects:get'),
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
    setConversationAgentLimits: (
      projectId: string,
      conversationId: string,
      agentLimits: AgentLimitsConfig,
    ) => ipcRenderer.invoke(
      'conversations:set-agent-limits',
      projectId,
      conversationId,
      agentLimits,
    ),
    develop: (projectId: string, conversationId: string, content: string, images: ImageAttachment[] = [], traceId?: string) =>
      ipcRenderer.invoke('development:send', projectId, conversationId, content, images, traceId),
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
  }),
)
