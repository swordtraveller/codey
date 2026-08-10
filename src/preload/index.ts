import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld(
  'runtime',
  Object.freeze({ electron: process.versions.electron })
)
