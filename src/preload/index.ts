import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld(
  'runtime',
  Object.freeze({ electron: process.versions.electron }),
)

contextBridge.exposeInMainWorld(
  'codey',
  Object.freeze({
    getConfig: () => ipcRenderer.invoke('config:get'),
    saveConfig: (config: unknown) => ipcRenderer.invoke('config:save', config),
    chat: (messages: unknown) => ipcRenderer.invoke('chat:send', messages),
  }),
)
