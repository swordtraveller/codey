import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskRunJournal } from './task-run-journal'
import { applyTodoAction, createTodoToolProvider } from './todo-tool'
import { parseTodoSnapshot } from '../shared/todo'
import type { ToolCall } from './tools'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const temporaryJournal = async (): Promise<{ journal: TaskRunJournal; path: string }> => {
  const directory = await mkdtemp(join(tmpdir(), 'codey-task-run-'))
  directories.push(directory)
  const path = join(directory, 'run.jsonl')
  return { path, journal: await TaskRunJournal.open(path) }
}
const call = (id: string, args: unknown): ToolCall => ({ id, type: 'function', function: { name: 'todo', arguments: JSON.stringify(args) } })

// IDs and time are injected so the reducer can be tested without disk, clocks, or randomness.
describe('Todo reducer', () => {
  it('adds stable IDs, changes status, and keeps historical snapshots independent', () => {
    const created = applyTodoAction([], { action: 'add', name: ' Inspect code ' }, () => 'abc', () => '2026-01-01')
    expect(created).toMatchObject({ success: true, changes: [{ kind: 'added' }], items: [{ id: 'todo_abc', name: 'Inspect code', status: 'pending' }] })
    const finished = applyTodoAction(created.items, { action: 'set', updates: { todo_abc: { status: 'finished' } } }, undefined, () => '2026-01-02')
    expect(finished.items[0].status).toBe('finished')
    expect(created.items[0].status).toBe('pending')
    const deleted = applyTodoAction(finished.items, { action: 'del', id: 'todo_abc' })
    expect(deleted.items).toEqual([])
    expect(deleted.changes).toEqual([{ kind: 'deleted', item: finished.items[0] }])
  })

  it('rejects malformed and partially invalid batches without mutating the input', () => {
    const first = applyTodoAction([], { action: 'add', name: 'A' }, () => 'a')
    const copy = structuredClone(first.items)
    expect(() => applyTodoAction(first.items, { action: 'set', updates: { todo_a: { status: 'finished' }, missing: { status: 'pending' } } })).toThrow('missing')
    expect(first.items).toEqual(copy)
    expect(() => applyTodoAction(first.items, { action: 'set', updates: { todo_a: { finished: true } } })).toThrow()
    expect(() => applyTodoAction(first.items, { action: 'del', id: 'other' })).toThrow()
    expect(() => applyTodoAction(first.items, { action: 'add', name: '  ' })).toThrow()
    expect(() => applyTodoAction(first.items, { action: 'get', extra: 1 })).toThrow()
  })
})

describe('TaskRun journal and Todo provider', () => {
  it('persists snapshots and ordered events across reopening and continuation; a fresh task starts empty', async () => {
    const { journal, path } = await temporaryJournal()
    await journal.append('run1', { type: 'run-started', taskId: 'task1', userMessageId: 'u1' })
    const provider = createTodoToolProvider(journal, 'run1', 'task1')
    const add = parseTodoSnapshot(await provider.execute(call('c1', { action: 'add', name: 'Test' })))!
    expect(add.items).toHaveLength(1)
    const itemId = add.items[0].id
    const failed = parseTodoSnapshot(await provider.execute(call('c2', { action: 'set', updates: { unknown: { status: 'finished' } } })))!
    expect(failed).toMatchObject({ success: false, action: 'set', changes: [] })
    expect(failed.items[0].status).toBe('pending')
    await journal.append('run1', { type: 'run-finished', status: 'normal' })
    const reopened = await TaskRunJournal.open(path)
    const parent = reopened.findRunByUserMessage('u1')
    expect(parent).toMatchObject({ runId: 'run1', taskId: 'task1' })
    await reopened.append('run2', { type: 'run-started', taskId: 'task1', userMessageId: 'u2', continuedFromRunId: parent?.runId })
    const resumed = createTodoToolProvider(reopened, 'run2', 'task1')
    const get = parseTodoSnapshot(await resumed.execute(call('c3', { action: 'get' })))!
    expect(get.items[0].id).toBe(itemId)
    const finished = parseTodoSnapshot(await resumed.execute(call('c4', { action: 'set', updates: { [itemId]: { status: 'finished' } } })))!
    expect(finished.items[0].status).toBe('finished')
    expect(add.items[0].status).toBe('pending')
    const fresh = createTodoToolProvider(reopened, 'run3', 'task3')
    expect(parseTodoSnapshot(await fresh.execute(call('c5', { action: 'get' })))?.items).toEqual([])
    const events = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(events.filter((event) => event.type === 'todo-snapshot')).toHaveLength(5)
    expect((await TaskRunJournal.open(path)).latestTodoItems('task1')[0].status).toBe('finished')
  })

  it('serializes concurrent writes', async () => {
    const { journal, path } = await temporaryJournal()
    await Promise.all(Array.from({ length: 20 }, (_, index) => journal.append('run', { type: 'model-call', callId: String(index), phase: 'started', model: 'test', requestIndex: index })))
    expect((await TaskRunJournal.open(path)).all()).toHaveLength(20)
    expect(journal.all().map((event) => event.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
  })
})


describe('Journal damage protection', () => {
  it('refuses invalid records without changing the original bytes', async () => {
    const { path } = await temporaryJournal()
    for (const contents of ['{"version":1,"sequence":1}', '{"version":', '{"version":2,"sequence":1}']) {
      await writeFile(path, contents)
      await expect(TaskRunJournal.open(path)).rejects.toThrow('Invalid TaskRun journal')
      expect(await readFile(path, 'utf8')).toBe(contents)
    }
  })

  it('preserves a valid last record that has no trailing newline', async () => {
    const { journal, path } = await temporaryJournal()
    await journal.append('run', { type: 'run-started', userMessageId: 'user', taskId: 'task' })
    await writeFile(path, (await readFile(path, 'utf8')).trimEnd())
    const reopened = await TaskRunJournal.open(path)
    await reopened.append('run', { type: 'run-finished', status: 'normal' })
    expect((await TaskRunJournal.open(path)).all()).toHaveLength(2)
  })
})
