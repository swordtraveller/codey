import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ projects: vi.fn(), path: vi.fn(), warn: vi.fn() }))
vi.mock('./workspace', () => ({ getProjectsForRenderer: mocks.projects, taskRunJournalPath: mocks.path }))
vi.mock('./logger', () => ({ log: { warn: mocks.warn } }))
import { getPerformanceAnalytics } from './analytics'
import { TaskRunJournal } from './task-run-journal'

let directory: string
beforeEach(async () => {
  vi.clearAllMocks()
  directory = await mkdtemp(join(tmpdir(), 'codey-analytics-'))
  mocks.projects.mockResolvedValue([{ id: 'project', conversations: [{ id: 'valid' }, { id: 'broken' }, { id: 'missing' }] }])
  mocks.path.mockImplementation((_project, conversation) => join(directory, `${conversation}.jsonl`))
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('performance analytics journal reader', () => {
  it('loads persisted model timings and reports damaged journals without mutating history', async () => {
    const path = join(directory, 'valid.jsonl')
    const journal = await TaskRunJournal.open(path)
    await journal.append('run', { type: 'model-call', phase: 'finished', callId: 'call', requestIndex: 1,
      model: 'example-model', modelName: 'example-model', modelLabel: 'My model', providerId: 'p', provider: 'Provider',
      modelId: 'm', durationMs: 250, firstTokenMs: 30 })
    await journal.append('run', { type: 'tool-call', toolCallId: 'tool', name: 'todo', phase: 'finished' })
    await writeFile(join(directory, 'broken.jsonl'), '{broken', 'utf8')
    const before = await readFile(path, 'utf8')
    const result = await getPerformanceAnalytics({ dimension: 'modelName' })
    expect(result).toMatchObject({ totalCalls: 1, skippedJournals: 1, skippedCalls: 0 })
    expect(result.rows[0]).toMatchObject({ modelName: 'example-model', averageDurationMs: 250 })
    expect(mocks.warn).toHaveBeenCalledOnce()
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await readFile(join(directory, 'broken.jsonl'), 'utf8')).toBe('{broken')
  })
  it('returns empty data for a new workspace', async () => {
    mocks.projects.mockResolvedValue([])
    expect(await getPerformanceAnalytics()).toMatchObject({ totalCalls: 0, skippedJournals: 0, rows: [] })
  })
  it('rejects invalid IPC filters before reading history', async () => {
    await expect(getPerformanceAnalytics({ dimension: 'bad' as never })).rejects.toThrow('dimension')
    expect(mocks.projects).not.toHaveBeenCalled()
  })
})
