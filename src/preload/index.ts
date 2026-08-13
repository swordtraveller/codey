import { contextBridge, ipcRenderer } from 'electron'
import type { DevelopmentProgress, ModelConfig } from '../shared/types'

contextBridge.exposeInMainWorld(
  'runtime',
  Object.freeze({ electron: process.versions.electron }),
)

contextBridge.exposeInMainWorld(
  'codey',
  Object.freeze({
    getConfig: () => ipcRenderer.invoke('config:get'),
    saveConfig: (config: ModelConfig) => ipcRenderer.invoke('config:save', config),
    getProjects: () => ipcRenderer.invoke('projects:get'),
    createProject: (name: string) => ipcRenderer.invoke('projects:create', name),
    addProjectFolder: (projectId: string) =>
      ipcRenderer.invoke('projects:add-folder', projectId),
    createConversation: (projectId: string) =>
      ipcRenderer.invoke('conversations:create', projectId),
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
