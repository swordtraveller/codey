import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import type { MessageNavigationEntry, MessageNavigationTarget } from '../shared/message-navigation'

type Options = {
  getMainWindow: () => BrowserWindow | null
  getEntries: (projectId: string, conversationId: string) => Promise<MessageNavigationEntry[]>
  loadRenderer: (window: BrowserWindow, query: Record<string, string>) => void
  icon: string
}

/** One disposable child window; selection is accepted only from that window. */
export function registerMessageNavigation({ getMainWindow, getEntries, loadRenderer, icon }: Options): void {
  let current: { window: BrowserWindow; projectId: string; conversationId: string; entries: MessageNavigationEntry[] } | undefined
  let generation = 0
  ipcMain.handle('message-navigation:open', async (event, projectId: string, conversationId: string) => {
    const parent = getMainWindow()
    if (!parent || parent.isDestroyed() || event.sender !== parent.webContents) throw new Error('Invalid navigation owner')
    if (typeof projectId !== 'string' || typeof conversationId !== 'string') throw new Error('Invalid conversation')
    const request = ++generation
    const entries = await getEntries(projectId, conversationId)
    if (request !== generation || parent.isDestroyed()) return
    if (current && !current.window.isDestroyed()) current.window.destroy()
    const window = new BrowserWindow({
      parent, width: 540, height: 640, minWidth: 360, minHeight: 300,
      title: 'Codey', icon, autoHideMenuBar: true, backgroundColor: '#f7f7f5',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, '../preload/index.js') },
    })
    current = { window, projectId, conversationId, entries }
    const close = (): void => { if (!window.isDestroyed()) window.destroy() }
    parent.once('closed', close)
    window.once('closed', () => {
      parent.removeListener('closed', close)
      if (current?.window === window) current = undefined
    })
    loadRenderer(window, { view: 'message-navigation' })
  })
  ipcMain.handle('message-navigation:entries', (event) => {
    if (!current || current.window.isDestroyed() || event.sender !== current.window.webContents) throw new Error('Invalid navigation window')
    return current.entries
  })
  ipcMain.on('message-navigation:select', (event, messageId: string) => {
    const owner = current
    if (!owner || owner.window.isDestroyed() || event.sender !== owner.window.webContents
      || !owner.entries.some((entry) => entry.id === messageId)) return
    const parent = getMainWindow()
    if (parent && !parent.isDestroyed()) {
      const target: MessageNavigationTarget = { projectId: owner.projectId, conversationId: owner.conversationId, messageId }
      parent.webContents.send('message-navigation:selected', target)
      if (parent.isMinimized()) parent.restore()
      parent.focus()
    }
    owner.window.destroy()
  })
}
