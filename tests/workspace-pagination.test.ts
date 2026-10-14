import { open, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

const electronState = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electronState.userData } }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) }
})
import { BridgeHandoverService } from '../src/main/bridge'
import { addMessage, createProject, getConversationNavigation, getConversationMessagePage, getProject, getProjectsForRenderer, saveConversationContext, setConversationReadState, updateConversationTurn, updateConversationHotLongTermContent } from '../src/main/workspace'

const headerPath = (projectId: string, conversationId: string): string => join(electronState.userData, 'workspace-data', 'projects', Buffer.from(projectId).toString('base64url'), 'conversations', `${Buffer.from(conversationId).toString('base64url')}.json`)
async function reload(): Promise<void> {
  const directory = electronState.userData
  const reset = await createTemporaryDirectory('codey-pagination-reset-')
  electronState.userData = reset
  await getProjectsForRenderer()
  electronState.userData = directory
  await removeTemporaryDirectory(reset)
  vi.mocked(open).mockClear()
}
async function seed(turns = 12) {
  const project = await createProject('Paged')
  const conversationId = project.conversations[0].id
  for (let index = 0; index < turns; index++) {
    await addMessage(project.id, conversationId, 'user', `问题 ${index}`, undefined, undefined, undefined, undefined, undefined, undefined, undefined, `u${index}`)
    await addMessage(project.id, conversationId, 'assistant', `回答 🍎 ${index}`, undefined, undefined, undefined, undefined, undefined, undefined, undefined, `a${index}`)
  }
  await saveConversationContext(project.id, conversationId, [{ role: 'user', content: 'Full model context' }], undefined)
  return { projectId: project.id, conversationId }
}

describe('disk-backed conversation pagination', () => {
  beforeEach(async () => { electronState.userData = await createTemporaryDirectory('codey-pagination-') })
  afterEach(async () => { await removeTemporaryDirectory(electronState.userData) })

  it('loads only metadata at startup and reads five complete turns per page without loading model context', async () => {
    const { projectId, conversationId } = await seed()
    await reload()
    const projects = await getProjectsForRenderer()
    expect(vi.mocked(open).mock.calls).toHaveLength(0)
    const summary = projects[0].conversations[0]
    expect(summary.messages).toEqual([])
    expect(summary.agentMessages).toEqual([])
    expect(summary.history).toMatchObject({ messageCount: 24, turnCount: 12, unreadCount: 12, lastMessageId: 'a11' })
    const newest = await getConversationMessagePage(projectId, conversationId)
    expect(newest.messages.map((message) => message.id)).toEqual(['u7', 'a7', 'u8', 'a8', 'u9', 'a9', 'u10', 'a10', 'u11', 'a11'])
    expect(newest.messages.at(-1)?.content).toBe('回答 🍎 11')
    expect(newest.before).toBe('u7')
    const older = await getConversationMessagePage(projectId, conversationId, newest.before)
    expect(older.before).toBe('u2')
    const oldest = await getConversationMessagePage(projectId, conversationId, older.before)
    expect(oldest.messages.map((message) => message.id)).toEqual(['u0', 'a0', 'u1', 'a1'])
    expect(oldest.before).toBeNull()
    expect(vi.mocked(open).mock.calls).toHaveLength(3)
    const full = await getProject(projectId, conversationId)
    expect(full.conversations[0].messages).toHaveLength(24)
    expect(full.conversations[0].agentMessages).toEqual([expect.objectContaining({ content: 'Full model context' })])
  })

  it('keeps older cursors stable after new messages and turn status updates', async () => {
    const { projectId, conversationId } = await seed()
    await reload()
    const page = await getConversationMessagePage(projectId, conversationId)
    await addMessage(projectId, conversationId, 'user', 'new question')
    const older = await getConversationMessagePage(projectId, conversationId, page.before)
    expect(older.messages.map((message) => message.id)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5', 'u6', 'a6'])
    await expect(getConversationMessagePage(projectId, conversationId, 'missing')).rejects.toThrow('cursor')
  })

  it('does not read or overwrite unloaded histories when saving settings and read state', async () => {
    const { projectId, conversationId } = await seed()
    await reload()
    await getProjectsForRenderer()
    await setConversationReadState(projectId, conversationId, 'u10', Date.now())
    await updateConversationHotLongTermContent(projectId, conversationId, 'Preferences')
    expect(vi.mocked(open).mock.calls).toHaveLength(0)
    expect((await getProjectsForRenderer())[0].conversations[0].history?.unreadCount).toBe(2)
    await reload()
    const full = await getProject(projectId, conversationId)
    expect(full.conversations[0].messages).toHaveLength(24)
    expect(full.conversations[0].agentMessages).toHaveLength(1)
    expect(full.conversations[0].hotLongTermContent).toBe('Preferences')
  })

  it('does not read an old body when opening the newest page; corrupt requested records fail explicitly', async () => {
    const { projectId, conversationId } = await seed()
    const path = headerPath(projectId, conversationId)
    const header = JSON.parse(await readFile(path, 'utf8'))
    const file = await open(path + '.records', 'r+')
    await file.write(Buffer.from('!'), 0, 1, header.messageIndex.messages[0].offset)
    await file.close()
    await reload()
    const first = await getConversationMessagePage(projectId, conversationId)
    expect(first.messages).toHaveLength(10)
    await expect(getConversationMessagePage(projectId, conversationId, 'u2')).rejects.toThrow('Damaged')
  })

  it('migrates old per-conversation JSON while retaining an original backup', async () => {
    const { projectId, conversationId } = await seed(0)
    const path = headerPath(projectId, conversationId)
    const header = JSON.parse(await readFile(path, 'utf8'))
    const { storageVersion: _version, messageIndex: _index, history: _history, ...metadata } = header
    const old = { ...metadata, messages: [{ id: 'old', role: 'user', content: '旧对话' }], agentMessages: [{ role: 'user', content: '原始上下文' }] }
    await writeFile(path, JSON.stringify(old))
    await reload()
    expect((await getConversationMessagePage(projectId, conversationId)).messages[0].content).toBe('旧对话')
    expect(JSON.parse(await readFile(path + '.legacy', 'utf8'))).toEqual(old)
    expect(JSON.parse(await readFile(path, 'utf8')).storageVersion).toBe(3)
    await reload()
    expect((await getProject(projectId, conversationId)).conversations[0].agentMessages[0].content).toBe('原始上下文')
  })
  it('leaves the original conversation and manifest intact when migration cannot be committed', async () => {
    const { projectId, conversationId } = await seed(0)
    const path = headerPath(projectId, conversationId)
    const header = JSON.parse(await readFile(path, 'utf8'))
    const { storageVersion: _version, messageIndex: _index, history: _history, ...metadata } = header
    const old = { ...metadata, messages: [{ id: 'old', role: 'user', content: 'Do not lose this' }], agentMessages: [] }
    await writeFile(path, JSON.stringify(old))
    await reload()
    vi.mocked(rename).mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(getProjectsForRenderer()).rejects.toThrow('migration failed')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(old)
    expect(JSON.parse(await readFile(join(electronState.userData, 'workspace.json'), 'utf8')).projectIds).toEqual([projectId])
    expect((await getConversationMessagePage(projectId, conversationId)).messages[0].content).toBe('Do not lose this')
  })

  it('replaces context snapshots without appending them to the message journal', async () => {
    const { projectId, conversationId } = await seed(1)
    const path = headerPath(projectId, conversationId)
    const before = await readFile(path + '.records', 'utf8')
    await saveConversationContext(projectId, conversationId, [{ role: 'user', content: 'Replacement context' }], undefined)
    expect(await readFile(path + '.records', 'utf8')).toBe(before)
    const names = await readdir(join(path, '..'))
    expect(names.filter((name) => name.includes('.context-'))).toHaveLength(1)
    await reload()
    expect((await getProject(projectId, conversationId)).conversations[0].agentMessages[0].content).toBe('Replacement context')
  })

  it('does not load the full workspace for Bridge when there are no channels', async () => {
    const readAll = vi.fn(async () => [])
    await new BridgeHandoverService().sync(readAll)
    expect(readAll).not.toHaveBeenCalled()
  })

  it('keeps read cursors monotonic and errors independent without hydrating bodies', async () => {
    const { projectId, conversationId } = await seed(2)
    await updateConversationTurn(projectId, conversationId, 'u1', { startedAt: 1, endedAt: 2, result: 'other', error: 'provider failed' })
    await reload()
    expect((await getProjectsForRenderer())[0].conversations[0].history).toMatchObject({ unreadCount: 2, hasError: true, hasUnreadError: true })
    await setConversationReadState(projectId, conversationId, 'a1', 100)
    await setConversationReadState(projectId, conversationId, 'a0', 200)
    await setConversationReadState(projectId, conversationId, 'invalid', 300)
    await setConversationReadState(projectId, conversationId, null, null)
    const conversation = (await getProjectsForRenderer())[0].conversations[0]
    expect(conversation.lastReadMessageId).toBe('a1')
    expect(conversation.lastReadAt).toBe(100)
    expect(conversation.history).toMatchObject({ unreadCount: 0, hasError: true, hasUnreadError: false })
    expect(vi.mocked(open)).not.toHaveBeenCalled()
    await reload()
    expect((await getProjectsForRenderer())[0].conversations[0].history).toMatchObject({ unreadCount: 0, hasError: true })
    await updateConversationTurn(projectId, conversationId, 'u1', { startedAt: 1, result: 'normal' })
    expect((await getProjectsForRenderer())[0].conversations[0].history?.hasError).toBe(false)
  })

  it('upgrades older pagination indexes once, preserving journals and context', async () => {
    const { projectId, conversationId } = await seed(2)
    await updateConversationTurn(projectId, conversationId, 'u1', { startedAt: 1, result: 'timeout' })
    const path = headerPath(projectId, conversationId)
    const old = JSON.parse(await readFile(path, 'utf8'))
    delete old.messageIndex.readStateVersion
    old.messageIndex.messages = old.messageIndex.messages.map(({ turn, replyContent, ...entry }: Record<string, unknown>) => entry)
    old.history.hasError = false
    await writeFile(path, JSON.stringify(old))
    const records = await readFile(path + '.records')
    await reload()
    expect((await getProjectsForRenderer())[0].conversations[0].history).toMatchObject({ unreadCount: 2, hasError: true })
    expect(await readFile(path + '.records')).toEqual(records)
    expect(JSON.parse(await readFile(path, 'utf8')).messageIndex.readStateVersion).toBe(2)
    await reload()
    await getProjectsForRenderer()
    expect(vi.mocked(open)).not.toHaveBeenCalled()
    expect((await getProject(projectId, conversationId)).conversations[0].agentMessages).toHaveLength(1)
  })

})


describe('conversation navigation', () => {
  beforeEach(async () => { electronState.userData = await createTemporaryDirectory('codey-navigation-') })
  afterEach(async () => { await removeTemporaryDirectory(electronState.userData) })
  it('lists every user message in order, including unloaded history, without loading model context', async () => {
    const { projectId, conversationId } = await seed(12)
    const loaded = await getConversationNavigation(projectId, conversationId)
    await reload()
    const entries = await getConversationNavigation(projectId, conversationId)
    expect(entries).toEqual(loaded)
    expect(entries.map((entry) => entry.id)).toEqual(Array.from({ length: 12 }, (_, i) => `u${i}`))
    expect(entries[0].preview).toBe('问题 0')
    expect((await getProjectsForRenderer())[0].conversations[0].messages).toEqual([])
    expect(vi.mocked(open).mock.calls).toHaveLength(1)
  })
})
