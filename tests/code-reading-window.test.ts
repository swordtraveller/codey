import { beforeEach, expect, it, vi } from 'vitest'
const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    static windows: Window[] = []
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() }
    destroyed = false
    constructor(public options: unknown) { super(); Window.windows.push(this) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  return { BrowserWindow: Window, ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => ipc.handlers.set(name, handler) } }
})
import { BrowserWindow } from 'electron'
import { registerCodeReadingWindow } from '../src/main/code-reading-window'

const windows = (): BrowserWindow[] => (BrowserWindow as unknown as { windows: BrowserWindow[] }).windows
beforeEach(() => { ipc.handlers.clear(); windows().length = 0 })

it('opens a read-only child and gives snapshot data only to that child', async () => {
  const parent = new BrowserWindow()
  const loadRenderer = vi.fn()
  const getSnapshot = vi.fn(async () => ({ sourceLink: 'codey://coderead/text?root=r&path=a.ts', reference: { rootId: 'r', path: 'a.ts' }, capturedAt: 'now', language: 'typescript', content: 'const x = 1' }))
  registerCodeReadingWindow({ getMainWindow: () => parent, getSnapshot, loadRenderer, icon: '' })
  const open = ipc.handlers.get('code-reading:open')!
  await expect(open({ sender: {} }, {})).rejects.toThrow('owner')
  await open({ sender: parent.webContents }, { projectId: 'p', conversationId: 'c', messageId: 'm', sourceLink: 'codey://coderead/text?root=r&path=a.ts' })
  const child = windows()[1]
  expect(loadRenderer).toHaveBeenCalledWith(child, { view: 'coderead' })
  const data = ipc.handlers.get('code-reading:data')!
  expect(() => data({ sender: parent.webContents })).toThrow('window')
  expect(data({ sender: child.webContents })).toMatchObject({ content: 'const x = 1' })
  expect((child.webContents as any).setWindowOpenHandler).toHaveBeenCalled()
  parent.destroy()
  expect(child.isDestroyed()).toBe(true)
})
