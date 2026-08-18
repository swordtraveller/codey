import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, ContextManagementConfig, DevelopmentProgress } from '../shared/types'

contextBridge.exposeInMainWorld(
  'runtime',
  Object.freeze({ electron: process.versions.electron }),
)

contextBridge.exposeInMainWorld(
  'codey',
  Object.freeze({
    getConfig: () => ipcRenderer.invoke('config:get'),
    saveConfig: (config: AppConfig) => ipcRenderer.invoke('config:save', config),
    getProjects: () => ipcRenderer.invoke('projects:get'),
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
    develop: (projectId: string, conversationId: string, content: string) =>
      ipcRenderer.invoke('development:send', projectId, conversationId, content),
    onDevelopmentProgress: (listener: (progress: DevelopmentProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: DevelopmentProgress) =>
        listener(progress)
      ipcRenderer.on('development:progress', handler)
      return () => ipcRenderer.removeListener('development:progress', handler)
    },
  }),
)
