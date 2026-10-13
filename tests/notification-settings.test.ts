import { beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => ({ content: '{}' }))
vi.mock('electron', () => ({
  app: { getPath: () => '.' },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => disk.content),
  writeFile: vi.fn(async (_path: string, content: string) => { disk.content = content }),
}))

import { readConfig, saveConfig } from '../src/main/config'
import { defaultAppConfig, defaultNotificationSettings } from '../src/shared/types'

beforeEach(() => { disk.content = '{}' })

describe('notification settings persistence', () => {
  it('uses defaults for old configurations without notification settings', async () => {
    expect((await readConfig()).notificationSettings).toEqual(defaultNotificationSettings)
  })

  it('restores saved switches while defaulting missing or invalid fields', async () => {
    disk.content = JSON.stringify({ notificationSettings: { enabled: false, taskComplete: 'false', modelError: false } })
    expect((await readConfig()).notificationSettings).toEqual({ ...defaultNotificationSettings, enabled: false, modelError: false })
  })

  it('persists notification switches alongside the application configuration', async () => {
    const notificationSettings = { ...defaultNotificationSettings, taskFailed: false, onlyWhenUnfocused: false }
    await saveConfig({
      ...defaultAppConfig,
      providers: [{ id: 'provider', name: 'Provider', baseUrl: 'https://example.com/v1', apiKey: 'test-placeholder' }],
      notificationSettings,
    })
    expect(JSON.parse(disk.content).notificationSettings).toEqual(notificationSettings)
    expect((await readConfig()).notificationSettings).toEqual(notificationSettings)
  })
})
