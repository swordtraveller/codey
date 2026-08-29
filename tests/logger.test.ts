import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

const electronState = vi.hoisted(() => ({ logs: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.logs,
    isPackaged: false,
  },
}))

import { log } from '../src/main/logger'

describe('main logger', () => {
  let logsDirectory = ''

  beforeEach(async () => {
    logsDirectory = await createTemporaryDirectory('codey-logs-')
    electronState.logs = logsDirectory
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    await log.flush()
    vi.restoreAllMocks()
    await removeTemporaryDirectory(logsDirectory)
  })

  it('caps individual log values before appending them', async () => {
    const secret = 's'.repeat(20 * 1024)

    log.warn('large-value', secret)
    await log.flush()

    const contents = await readFile(join(logsDirectory, 'main.log'), 'utf8')
    expect(contents).toContain('large-value')
    expect(contents).toContain('[truncated 4096 chars]')
    expect(contents.length).toBeLessThan(17 * 1024)
    expect(contents).not.toContain(secret)
  })

  it('rotates oversized logs while retaining the three newest archives', async () => {
    const logPath = join(logsDirectory, 'main.log')
    await mkdir(logsDirectory, { recursive: true })
    await writeFile(logPath, 'P'.repeat(2 * 1024 * 1024), 'utf8')
    await writeFile(`${logPath}.1`, 'first archive', 'utf8')
    await writeFile(`${logPath}.2`, 'second archive', 'utf8')
    await writeFile(`${logPath}.3`, 'discarded archive', 'utf8')

    log.warn('after-rotation', { ok: true })
    await log.flush()

    await expect(readFile(logPath, 'utf8')).resolves.toContain('after-rotation')
    await expect(readFile(`${logPath}.1`, 'utf8')).resolves.toBe('P'.repeat(2 * 1024 * 1024))
    await expect(readFile(`${logPath}.2`, 'utf8')).resolves.toBe('first archive')
    await expect(readFile(`${logPath}.3`, 'utf8')).resolves.toBe('second archive')
  })
})
