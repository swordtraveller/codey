import { BrowserWindow } from 'electron'
import { isAllowedPreviewUrl } from './frontend-runtime'

const previewWindows = new Map<string, BrowserWindow>()

function parsePreviewUrl(value: string): URL {
  if (!isAllowedPreviewUrl(value)) {
    throw new Error('Preview URL must use localhost or 127.0.0.1')
  }
  return new URL(value)
}

export function openPreviewWindow(serverId: string, previewUrl: string): void {
  const url = parsePreviewUrl(previewUrl)
  const existing = previewWindows.get(serverId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    if (existing.webContents.getURL() !== url.toString()) {
      void existing.loadURL(url.toString()).catch(() => closePreviewWindow(serverId))
    }
    return
  }

  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    title: 'Codey Preview',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `temp:codey-preview-${serverId}`,
    },
  })
  const preventExternalNavigation = (event: Electron.Event, targetUrl: string): void => {
    try {
      if (parsePreviewUrl(targetUrl).origin !== url.origin) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  }

  previewWindows.set(serverId, window)
  window.on('closed', () => {
    if (previewWindows.get(serverId) === window) previewWindows.delete(serverId)
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', preventExternalNavigation)
  window.webContents.on('will-redirect', preventExternalNavigation)
  void window.loadURL(url.toString()).catch(() => closePreviewWindow(serverId))
}

export function closePreviewWindow(serverId: string): void {
  previewWindows.get(serverId)?.close()
  previewWindows.delete(serverId)
}

export function closeAllPreviewWindows(): void {
  for (const window of previewWindows.values()) window.close()
  previewWindows.clear()
}