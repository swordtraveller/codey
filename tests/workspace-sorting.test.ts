import { open, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'
import { projectActivityAt } from '../src/shared/list-sorting'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) }
})
import { addMessage, addMessageImmediately, addModelRequestEvent, createConversation, createProject,
  getConversationMessagePage, getProject, getProjectsForRenderer, renameConversation, renameProject,
  setConversationArchived, setConversationModelConfig, setConversationReadState, updateConversationTurn } from '../src/main/workspace'

const day = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString()
const now = (n: number) => vi.setSystemTime(new Date(day(n)))
const key = (id: string) => Buffer.from(id).toString('base64url')
const projectPath = (id: string) => join(state.userData, 'workspace-data', 'projects', key(id), 'project.json')
const headerPath = (id: string, conversationId: string) => join(state.userData, 'workspace-data', 'projects', key(id), 'conversations', key(conversationId) + '.json')
async function reload() {
  const directory = state.userData
  const reset = await createTemporaryDirectory('codey-sort-reset-')
  state.userData = reset
  await getProjectsForRenderer()
  state.userData = directory
  await removeTemporaryDirectory(reset)
  vi.mocked(open).mockClear()
}
async function seed() {
  const project = await createProject('Project')
  return { id: project.id, conversationId: project.conversations[0].id }
}
async function summary() { return (await getProjectsForRenderer())[0].conversations[0] }

beforeEach(async () => {
  state.userData = await createTemporaryDirectory('codey-sort-')
  vi.useFakeTimers({ toFake: ['Date'] })
  now(1)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.mocked(rename).mockClear()
  await removeTemporaryDirectory(state.userData)
})

describe('workspace sorting metadata', () => {
  it('timestamps new projects and conversations without rewriting project creation', async () => {
    const { id } = await seed()
    expect((await getProjectsForRenderer())[0]).toMatchObject({ createdAt: day(1), conversations: [{ createdAt: day(1), lastActivityAt: day(1) }] })
    now(2)
    await createConversation(id)
    const project = (await getProjectsForRenderer())[0]
    expect(project.createdAt).toBe(day(1))
    expect(project.conversations[1]).toMatchObject({ createdAt: day(2), lastActivityAt: day(2) })
    expect(projectActivityAt(project)).toBe(day(2))
  })
  it('records sends and task completion, not intermediate turn edits; survives restart', async () => {
    const { id, conversationId } = await seed()
    now(2)
    const turn = { result: 'processing' as const, startedAt: Date.now() }
    await addMessage(id, conversationId, 'user', 'Request', undefined, undefined, undefined, undefined, turn, undefined, undefined, 'request')
    expect((await summary()).lastActivityAt).toBe(day(2))
    now(3)
    await updateConversationTurn(id, conversationId, 'request', { ...turn, taskId: 'task' })
    expect((await summary()).lastActivityAt).toBe(day(2))
    now(4)
    const finished = { ...turn, result: 'normal' as const, endedAt: Date.now() }
    await updateConversationTurn(id, conversationId, 'request', finished)
    expect((await summary()).lastActivityAt).toBe(day(4))
    now(5)
    await updateConversationTurn(id, conversationId, 'request', { ...finished, taskId: 'task' })
    expect((await summary()).lastActivityAt).toBe(day(4))
    await reload()
    expect(await summary()).toMatchObject({ createdAt: day(1), lastActivityAt: day(4), messages: [], agentMessages: [] })
    expect(vi.mocked(open)).not.toHaveBeenCalled()
  })
  it('uses actual ingestion time for replies instead of their historical display timestamp', async () => {
    const { id, conversationId } = await seed()
    now(5)
    await addMessage(id, conversationId, 'assistant', 'Reply', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'reply', day(1))
    expect((await summary()).lastActivityAt).toBe(day(5))
    expect((await getConversationMessagePage(id, conversationId)).messages[0].createdAt).toBe(day(1))
  })
  it('does not count opening, renaming, reads, settings or diagnostic notices as activity', async () => {
    const { id, conversationId } = await seed()
    now(8)
    await getProject(id, conversationId)
    await renameProject(id, 'Renamed project')
    await renameConversation(id, conversationId, 'Renamed conversation')
    await setConversationModelConfig(id, conversationId, 'model')
    await setConversationReadState(id, conversationId, null, Date.now())
    await addMessage(id, conversationId, 'assistant', '', undefined, { originalTokens: 10, compressedTokens: 5, compressionRatio: 2, method: 'filter' })
    await addModelRequestEvent(id, conversationId, { kind: 'retry', model: 'model', attempt: 1 })
    await reload()
    expect((await summary()).lastActivityAt).toBe(day(1))
    expect(vi.mocked(open)).not.toHaveBeenCalled()
  })
  it('timestamps the immediate user path and persists it on the conversation write queue', async () => {
    const { id, conversationId } = await seed()
    now(3)
    const project = await addMessageImmediately(id, conversationId, 'user', 'Immediate request')
    expect(project.conversations[0].lastActivityAt).toBe(day(3))
    // A subsequent operation on the same queue waits for the scheduled durable write.
    await setConversationReadState(id, conversationId, null, Date.now())
    await reload()
    expect(await summary()).toMatchObject({ createdAt: day(1), lastActivityAt: day(3) })
  })
  it('migrates paged histories once with bounded body reads, excluding diagnostics', async () => {
    const { id, conversationId } = await seed()
    await addMessage(id, conversationId, 'user', 'Old request', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'old-user', day(2))
    await addMessage(id, conversationId, 'assistant', 'Old reply', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'old-reply', day(4))
    await addModelRequestEvent(id, conversationId, { kind: 'retry', model: 'model' })
    const path = headerPath(id, conversationId)
    const records = await readFile(path + '.records')
    const header = JSON.parse(await readFile(path, 'utf8'))
    delete header.createdAt; delete header.lastActivityAt
    await writeFile(path, JSON.stringify(header))
    const metadata = JSON.parse(await readFile(projectPath(id), 'utf8'))
    delete metadata.createdAt
    await writeFile(projectPath(id), JSON.stringify(metadata))
    now(20)
    await reload()
    expect(await summary()).toMatchObject({ createdAt: day(2), lastActivityAt: day(4), messages: [] })
    expect((await getProjectsForRenderer())[0].createdAt).toBe(day(2))
    expect(vi.mocked(open)).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ createdAt: day(2), lastActivityAt: day(4) })
    expect(JSON.parse(await readFile(projectPath(id), 'utf8')).createdAt).toBe(day(2))
    expect(await readFile(path + '.records')).toEqual(records)
    await setConversationArchived(id, conversationId, true)
    await reload()
    expect((await getProjectsForRenderer())[0].createdAt).toBe(day(2))
    expect(vi.mocked(open)).not.toHaveBeenCalled()
  })
  it('persists unknown legacy dates as null and never re-infers creation from new activity', async () => {
    const { id, conversationId } = await seed()
    const path = headerPath(id, conversationId)
    const header = JSON.parse(await readFile(path, 'utf8'))
    const { storageVersion, messageIndex, history, createdAt, lastActivityAt, ...metadata } = header
    await writeFile(path, JSON.stringify({ ...metadata, messages: [{ id: 'old', role: 'user', content: 'No timestamp' }], agentMessages: [] }))
    const project = JSON.parse(await readFile(projectPath(id), 'utf8'))
    delete project.createdAt
    await writeFile(projectPath(id), JSON.stringify(project))
    now(15)
    await reload()
    expect(await summary()).toMatchObject({ createdAt: null, lastActivityAt: null })
    expect(JSON.parse(await readFile(projectPath(id), 'utf8')).createdAt).toBeNull()
    await addMessage(id, conversationId, 'user', 'New request')
    await reload()
    expect(await summary()).toMatchObject({ createdAt: null, lastActivityAt: day(15) })
    expect((await getProjectsForRenderer())[0].createdAt).toBeNull()
  })
  it('does not quarantine a project when persisting its legacy creation date fails', async () => {
    const { id } = await seed()
    const path = projectPath(id)
    const metadata = JSON.parse(await readFile(path, 'utf8'))
    delete metadata.createdAt
    await writeFile(path, JSON.stringify(metadata))
    const original = await readFile(path, 'utf8')
    await reload()
    vi.mocked(rename).mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(getProjectsForRenderer()).rejects.toThrow('Project date migration failed')
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(JSON.parse(await readFile(join(state.userData, 'workspace.json'), 'utf8')).projectIds).toEqual([id])
    expect((await getProjectsForRenderer())[0]).toMatchObject({ id, createdAt: day(1) })
  })
  it('preserves original paged metadata and history when date migration fails, then retries', async () => {
    const { id, conversationId } = await seed()
    await addMessage(id, conversationId, 'user', 'Original request')
    const path = headerPath(id, conversationId)
    const header = JSON.parse(await readFile(path, 'utf8'))
    delete header.createdAt; delete header.lastActivityAt
    await writeFile(path, JSON.stringify(header))
    const original = await readFile(path, 'utf8')
    const records = await readFile(path + '.records')
    await reload()
    vi.mocked(rename).mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(getProjectsForRenderer()).rejects.toThrow('activity migration failed')
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await readFile(path + '.records')).toEqual(records)
    expect(JSON.parse(await readFile(join(state.userData, 'workspace.json'), 'utf8')).projectIds).toEqual([id])
    expect(await summary()).toMatchObject({ createdAt: day(1), lastActivityAt: day(1) })
  })
})
