import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultContextManagementConfig, type AgentContextMessage } from '../src/shared/types'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

const electronState = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userData,
  },
}))

import {
  appendConversationMessages,
  getConversationStorageRevision,
  readConversationIndex,
  readConversationMessage,
  readConversationMessages,
  readConversationStorageOverview,
  readConversationWorkingSet,
  updateConversationLayer,
  updateConversationProtection,
  writeConversationMessages,
} from '../src/main/conversation-store'

describe('conversation context store', () => {
  beforeEach(async () => {
    electronState.userData = await createTemporaryDirectory('codey-context-store-')
  })

  afterEach(async () => {
    await removeTemporaryDirectory(electronState.userData)
  })

  it('reads UTF-8 JSONL messages by indexed byte offset and appends only new ids', async () => {
    const initial: AgentContextMessage[] = [
      { id: 'one', createdAt: '2026-01-01T00:00:00.000Z', role: 'user', content: '你好，world' },
      { id: 'two', createdAt: '2026-01-01T00:00:01.000Z', role: 'assistant', content: '第二条消息' },
    ]

    await writeConversationMessages('project', 'conversation', initial)
    await appendConversationMessages('project', 'conversation', [
      initial[1],
      { id: 'three', createdAt: '2026-01-01T00:00:02.000Z', role: 'user', content: 'third' },
    ])

    expect(await readConversationMessage('project', 'conversation', 'two'))
      .toEqual(expect.objectContaining(initial[1]))
    expect((await readConversationMessages('project', 'conversation')).map((message) => message.id))
      .toEqual(['one', 'two', 'three'])
    const storage = await readConversationStorageOverview('project', 'conversation')
    expect(storage).toEqual(expect.objectContaining({
      recordCount: 3,
      indexStatus: 'consistent',
      indexedBytes: storage.messages.sizeBytes,
    }))
    expect(storage.messages.path).toMatch(/messages\.jsonl$/)
    expect(storage.index.path).toMatch(/index\.json$/)
  })

  it('changes the lightweight storage revision when Cold data is persisted', async () => {
    const before = await getConversationStorageRevision('project', 'conversation')

    await writeConversationMessages('project', 'conversation', [
      { id: 'message', role: 'user', content: 'Hello' },
    ])

    expect(await getConversationStorageRevision('project', 'conversation')).not.toBe(before)
  })

  it('reports an empty Cold index before conversation history is persisted', async () => {
    const storage = await readConversationStorageOverview('project', 'conversation')

    expect(storage).toEqual(expect.objectContaining({
      recordCount: 0,
      indexedBytes: 0,
      indexStatus: 'empty',
      lastPersistedAt: null,
    }))
  })

  it('reports a mismatch when index pointers no longer match the JSONL source', async () => {
    await writeConversationMessages('project', 'conversation', [
      { id: 'message', role: 'user', content: 'Hello' },
    ])
    const indexPath = `${electronState.userData}/context-debug/project-conversation/index.json`
    const index = await readConversationIndex('project', 'conversation')
    index[0].logicalPointer = index[0].logicalPointer.replace('#0:', '#1:')
    await writeFile(indexPath, JSON.stringify(index), 'utf8')

    expect((await readConversationStorageOverview('project', 'conversation')).indexStatus)
      .toBe('mismatch')
  })
  it('persists protection and layer overrides without rewriting the JSONL truth source', async () => {
    const message: AgentContextMessage = {
      id: 'message',
      createdAt: '2026-01-01T00:00:00.000Z',
      role: 'assistant',
      content: 'Keep this decision.',
    }
    await writeConversationMessages('project', 'conversation', [message])
    const pointer = (await readConversationIndex('project', 'conversation'))[0].logicalPointer
    const messagesPath = `${electronState.userData}/context-debug/project-conversation/messages.jsonl`
    const before = await readFile(messagesPath, 'utf8')

    await updateConversationProtection('project', 'conversation', 'message', 'full')
    await updateConversationLayer('project', 'conversation', new Set(['message']), 'warm')

    expect(await readFile(messagesPath, 'utf8')).toBe(before)
    expect((await readConversationIndex('project', 'conversation'))[0].logicalPointer).toBe(pointer)
    expect(await readConversationMessage('project', 'conversation', 'message'))
      .toEqual(expect.objectContaining({
        protection: 'full',
        manualProtected: true,
        manualContextLayer: 'warm',
      }))
  })

  it('loads protected, manually warm and recent messages while leaving unrelated Cold data unread', async () => {
    const messages: AgentContextMessage[] = [
      { id: 'old-user', createdAt: '2026-01-01T00:00:00.000Z', role: 'user', content: 'Unrelated old request' },
      { id: 'protected', createdAt: '2026-01-01T00:00:01.000Z', role: 'assistant', content: 'Pinned decision', protection: 'full' },
      { id: 'warm-user', createdAt: '2026-01-01T00:00:02.000Z', role: 'user', content: 'Manual warm request', manualContextLayer: 'warm' },
      { id: 'cold-reply', createdAt: '2026-01-01T00:00:03.000Z', role: 'assistant', content: 'Unrelated Cold reply' },
      { id: 'recent-user', createdAt: '2026-01-01T00:00:04.000Z', role: 'user', content: 'Latest request' },
      { id: 'recent-reply', createdAt: '2026-01-01T00:00:05.000Z', role: 'assistant', content: 'Latest response' },
    ]
    await writeConversationMessages('project', 'conversation', messages)

    const workingSet = await readConversationWorkingSet(
      'project',
      'conversation',
      {
        ...defaultContextManagementConfig,
        recentKeepRounds: 1,
        warmTokenBudget: 0,
        coldRecallTokenBudget: 0,
      },
      'No matching query',
    )

    expect(workingSet.map((message) => message.id))
      .toEqual(['protected', 'warm-user', 'recent-user', 'recent-reply'])
    expect(workingSet.find((message) => message.id === 'warm-user'))
      .toEqual(expect.objectContaining({ contextSource: 'warm', manualContextLayer: 'warm' }))
  })
})
