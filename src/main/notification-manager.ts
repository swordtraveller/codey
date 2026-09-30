import { Notification, type BrowserWindow } from 'electron'
import { defaultNotificationSettings, type NotificationOptions, type NotificationSettings } from '../shared/types'

/**
 * Main-process system notification wrapper.
 * The renderer only sends notification events; this class owns the native
 * Electron Notification and dedupes/decides when to actually surface one.
 */
class NotificationManager {
  private mainWindow: BrowserWindow | null = null
  private settings: NotificationSettings = { ...defaultNotificationSettings }
  /** type -> last shown timestamp, used to avoid duplicate interruptions. */
  private lastShownAt = new Map<NotificationOptions['type'], number>()
  private readonly dedupeWindowMs = 5_000

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  updateSettings(settings: Partial<NotificationSettings>): void {
    this.settings = { ...this.settings, ...settings }
  }

  getSettings(): NotificationSettings {
    return { ...this.settings }
  }

  private windowUnfocused(): boolean {
    return this.mainWindow === null || !this.mainWindow.isFocused()
  }

  private shouldShow(type: NotificationOptions['type']): boolean {
    if (!this.settings.enabled) return false

    const typeEnabled: Record<NotificationOptions['type'], boolean> = {
      'task-complete': this.settings.taskComplete,
      'task-failed': this.settings.taskFailed,
      'needs-confirmation': this.settings.needsConfirmation,
      'connection-error': this.settings.connectionError,
      'model-error': this.settings.modelError,
    }
    if (!typeEnabled[type]) return false

    // Only notify when the window is not focused, to avoid duplicate noise.
    if (this.settings.onlyWhenUnfocused && !this.windowUnfocused()) return false

    // Dedupe: identical type within a short window.
    const last = this.lastShownAt.get(type)
    const now = Date.now()
    if (last !== undefined && now - last < this.dedupeWindowMs) return false

    this.lastShownAt.set(type, now)
    return true
  }

  /** Show a system notification if the current settings allow it. */
  showNotification(options: NotificationOptions): void {
    if (!this.shouldShow(options.type)) return

    const notification = new Notification({
      title: options.title,
      body: options.body,
      silent: options.silent ?? false,
    })

    notification.on('click', () => {
      if (!this.mainWindow) return
      if (this.mainWindow.isMinimized()) this.mainWindow.restore()
      this.mainWindow.focus()
      this.mainWindow.webContents.send('notification:clicked', {
        conversationId: options.conversationId,
        projectId: options.projectId,
        messageId: options.messageId,
      })
    })

    notification.show()
  }
}

export const notificationManager = new NotificationManager()
