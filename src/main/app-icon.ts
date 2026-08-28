import { app } from 'electron'
import { join } from 'node:path'

export function getAppIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../build/icon.png')
}