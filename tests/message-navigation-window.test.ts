import { beforeEach, expect, it, vi } from 'vitest'
const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), listeners: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    static windows: Window[] = []
    webContents = { send: vi.fn() }
    destroyed = false
    constructor(public options: unknown) { super(); Window.windows.push(this) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
    isMinimized() { return false }
    restore() {}
    focus() {}
  }
  return { BrowserWindow: Window, ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) => ipc.handlers.set(name, handler),
    on: (name: string, handler: (...args: any[]) => any) => ipc.listeners.set(name, handler),
  } }
})
import { BrowserWindow } from 'electron'
import { registerMessageNavigation } from '../src/main/message-navigation-window'
const windows = (): BrowserWindow[] => (BrowserWindow as unknown as { windows: BrowserWindow[] }).windows
beforeEach(() => { ipc.handlers.clear(); ipc.listeners.clear(); windows().length = 0 })

it('opens a child, validates the sender/selection, and destroys it immediately after selection', async () => {
  const parent = new BrowserWindow()
  const loadRenderer = vi.fn()
  registerMessageNavigation({ getMainWindow: () => parent, icon: '', loadRenderer,
    getEntries: async () => [{ id: 'u1', preview: 'first' }] })
  const open = ipc.handlers.get('message-navigation:open')!
  await expect(open({ sender: {} }, 'p', 'c')).rejects.toThrow('owner')
  await open({ sender: parent.webContents }, 'p', 'c')
  const child = windows()[1]
  expect(loadRenderer).toHaveBeenCalledWith(child, { view: 'message-navigation' })
  const entries = ipc.handlers.get('message-navigation:entries')!
  expect(() => entries({ sender: parent.webContents })).toThrow('window')
  expect(entries({ sender: child.webContents })).toEqual([{ id: 'u1', preview: 'first' }])
  const select = ipc.listeners.get('message-navigation:select')!
  select({ sender: parent.webContents }, 'u1')
  select({ sender: child.webContents }, 'missing')
  expect(child.isDestroyed()).toBe(false)
  select({ sender: child.webContents }, 'u1')
  expect(parent.webContents.send).toHaveBeenCalledWith('message-navigation:selected', { projectId: 'p', conversationId: 'c', messageId: 'u1' })
  expect(child.isDestroyed()).toBe(true)
  expect(parent.listenerCount('closed')).toBe(0)
  expect(() => entries({ sender: child.webContents })).toThrow('window')
})

it('replaces the previous window and removes child listeners when the parent closes', async () => {
  const parent = new BrowserWindow()
  registerMessageNavigation({ getMainWindow: () => parent, icon: '', loadRenderer: vi.fn(), getEntries: async () => [] })
  const open = ipc.handlers.get('message-navigation:open')!
  await open({ sender: parent.webContents }, 'p', 'one')
  const old = windows()[1]
  await open({ sender: parent.webContents }, 'p', 'two')
  expect(old.isDestroyed()).toBe(true)
  const child = windows()[2]
  parent.destroy()
  expect(child.isDestroyed()).toBe(true)
  expect(parent.listenerCount('closed')).toBe(0)
})
