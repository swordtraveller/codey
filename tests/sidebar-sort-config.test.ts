import { beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => ({ content: '{}' }))
vi.mock('electron', () => ({ app: { getPath: () => '.' }, safeStorage: { isEncryptionAvailable: () => false } }))
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => disk.content),
  writeFile: vi.fn(async (_path: string, content: string) => { disk.content = content }),
}))
import { readConfig, saveConfig, saveSidebarSort } from '../src/main/config'
import { defaultAppConfig } from '../src/shared/types'

beforeEach(() => { disk.content = '{}' })

describe('sidebar sorting persistence', () => {
  it('defaults old configurations to activity/newest for both lists', async () => {
    expect((await readConfig()).sidebarSort).toEqual(defaultAppConfig.sidebarSort)
  })
  it('saves independently of model configuration and restores both preferences on reload', async () => {
    const sidebarSort = { projects: { by: 'name', direction: 'asc' }, conversations: { by: 'created', direction: 'desc' } } as const
    expect(await saveSidebarSort(sidebarSort)).toEqual(sidebarSort)
    expect((await readConfig()).sidebarSort).toEqual(sidebarSort)
    await saveSidebarSort({ ...sidebarSort, conversations: { by: 'activity', direction: 'asc' } })
    expect((await readConfig()).sidebarSort).toEqual({ projects: sidebarSort.projects, conversations: { by: 'activity', direction: 'asc' } })
  })
  it('preserves unrelated application preferences and credentials', async () => {
    const saved = await saveConfig({ ...defaultAppConfig, language: 'en', developerMode: true,
      providers: [{ id: 'provider', name: 'Provider', baseUrl: 'https://example.com/v1', apiKey: 'test-placeholder' }] })
    const sidebarSort = await saveSidebarSort({ projects: { by: 'created', direction: 'asc' } })
    expect(await readConfig()).toEqual({ ...saved, sidebarSort })
  })
  it('normalizes malformed persisted and incoming preferences', async () => {
    disk.content = JSON.stringify({ sidebarSort: { projects: { by: 'manual', direction: 'up' }, conversations: { by: 'name' } } })
    expect((await readConfig()).sidebarSort).toEqual({ projects: { by: 'activity', direction: 'desc' }, conversations: { by: 'name', direction: 'asc' } })
    expect(await saveSidebarSort(null)).toEqual(defaultAppConfig.sidebarSort)
  })
})
