import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import type { CodeReadViewerData } from '../shared/code-reading'

type CodeReadOwner = { projectId: string; conversationId: string; messageId: string; sourceLink: string }
type Options = {
  getMainWindow: () => BrowserWindow | null
  getSnapshot: (owner: CodeReadOwner) => Promise<CodeReadViewerData>
  loadRenderer: (window: BrowserWindow, query: Record<string, string>) => void
  icon: string
}

/** Opens a single read-only code snapshot window. Main-process ownership prevents arbitrary file reads from renderer input. */
export function registerCodeReadingWindow({ getMainWindow, getSnapshot, loadRenderer, icon }: Options): void {
  let current: { window: BrowserWindow; data: CodeReadViewerData } | undefined
  let generation = 0
  ipcMain.handle('code-reading:open', async (event, owner: CodeReadOwner) => {
    const parent = getMainWindow()
    if (!parent || parent.isDestroyed() || event.sender !== parent.webContents) throw new Error('Invalid code-reading owner')
    if (!owner || typeof owner.projectId !== 'string' || typeof owner.conversationId !== 'string'
      || typeof owner.messageId !== 'string' || typeof owner.sourceLink !== 'string') throw new Error('Invalid code-reading link')
    const request = ++generation
    const data = await getSnapshot(owner)
    if (request !== generation || parent.isDestroyed()) return
    if (current && !current.window.isDestroyed()) current.window.destroy()
    const window = new BrowserWindow({
      parent, width: 940, height: 700, minWidth: 560, minHeight: 380,
      title: 'Codey · Code reading', icon, autoHideMenuBar: true, backgroundColor: '#f7f7f5',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, '../preload/index.js') },
    })
    current = { window, data }
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (navigation) => navigation.preventDefault())
    const close = (): void => { if (!window.isDestroyed()) window.destroy() }
    parent.once('closed', close)
    window.once('closed', () => {
      parent.removeListener('closed', close)
      if (current?.window === window) current = undefined
    })
    loadRenderer(window, { view: 'coderead' })
  })
  ipcMain.handle('code-reading:data', (event) => {
    if (!current || current.window.isDestroyed() || event.sender !== current.window.webContents) throw new Error('Invalid code-reading window')
    return current.data
  })
}
