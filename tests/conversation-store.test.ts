import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SUMMARY_LABEL } from '../src/main/context'
import { defaultContextManagementConfig, type AgentContextMessage, type ContextSummaryArtifact } from '../src/shared/types'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

const electronState = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userData,
  },
}))

import {
  appendConversationMessages,
  appendConversationSummaries,
  getConversationStorageRevision,
  readContextRecords,
  readConversationIndex,
  readConversationMessage,
  readConversationMessages,
  readConversationStorageOverview,
  readConversationSummaryIndex,
  readConversationWorkingSet,
  updateConversationLayer,
  updateConversationPin,
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
      summaryCount: 0,
      indexStatus: 'consistent',
      indexedBytes: storage.messages.sizeBytes,
    }))
    expect(storage.messages.path).toMatch(/messages\.jsonl$/)
    expect(storage.index.path).toMatch(/index\.json$/)
  })

  it('includes an unpersisted latest user message in both context modes', async () => {
    const persisted: AgentContextMessage = {
      id: 'old-user',
      createdAt: '2026-01-01T00:00:00.000Z',
      role: 'user',
      content: 'Previous request',
    }
    const latest: AgentContextMessage = {
      id: 'latest-user',
      createdAt: '2026-01-01T00:00:01.000Z',
      role: 'user',
      content: 'Current request',
    }
    await writeConversationMessages('project', 'conversation', [persisted])

    expect((await readConversationMessages('project', 'conversation', [latest])).map((message) => message.id))
      .toEqual(['old-user', 'latest-user'])
    expect(await readConversationWorkingSet(
      'project',
      'conversation',
      defaultContextManagementConfig,
      latest.content ?? '',
      [],
      [],
      [],
      latest.id,
      latest,
    )).toContainEqual(expect.objectContaining({
      id: 'latest-user',
      role: 'user',
      contextLayer: 'hot',
      contextRegion: 'newborn',
    }))
  })

  it('externalizes images from the truth log and hydrates them when read', async () => {
    const message: AgentContextMessage = {
      id: 'image-message',
      createdAt: '2026-01-01T00:00:00.000Z',
      role: 'user',
      content: 'Screenshot',
      images: [{ id: 'image-1', name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' }],
    }
    await writeConversationMessages('project', 'conversation', [message])

    const truth = await readFile(`${electronState.userData}/context-debug/project-conversation/messages.jsonl`, 'utf8')
    expect(truth).not.toContain('data:image/png;base64')
    expect(truth).toMatch(/"path":"images\/cHJvamVjdA\/Y29udmVyc2F0aW9u\/aW1hZ2UtMQ\.png"/)
    expect(await readConversationMessage('project', 'conversation', 'image-message'))
      .toEqual(expect.objectContaining({ images: message.images }))
  })
  it('places an appended current user message in the live Hot working set', async () => {
    await writeConversationMessages('project', 'conversation', [
      { id: 'previous-user', createdAt: '2026-01-01T00:00:00.000Z', role: 'user', content: 'Previous request' },
      { id: 'previous-assistant', createdAt: '2026-01-01T00:00:01.000Z', role: 'assistant', content: 'Previous reply' },
    ])
    await appendConversationMessages('project', 'conversation', [
      { id: 'current-user', createdAt: '2026-01-01T00:00:02.000Z', role: 'user', content: 'Current request' },
    ])

    const workingSet = await readConversationWorkingSet(
      'project',
      'conversation',
      { ...defaultContextManagementConfig, recentKeepRounds: 1 },
      'Current request',
    )

    expect(workingSet.find((message) => message.id === 'current-user')).toEqual(expect.objectContaining({
      role: 'user',
      content: 'Current request',
      contextLayer: 'hot',
      contextRegion: 'newborn',
      contextSource: 'live',
      truthRefs: ['current-user'],
    }))
  })

  it('stores labeled summaries separately without modifying the truth log', async () => {
    const message: AgentContextMessage = {
      id: 'truth-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      role: 'assistant',
      content: 'The exact historical fact.',
    }
    const summary: ContextSummaryArtifact = {
      id: 'summary-1',
      role: 'assistant',
      content: `${SUMMARY_LABEL}\nThis content may omit details and is not authoritative.\nTruth references: truth-1\n\nHistorical fact summary.`,
      sourceMessageIds: ['truth-1'],
      sourcePointers: ['messages.jsonl#id=truth-1'],
      timeRange: { from: message.createdAt!, to: message.createdAt! },
      compressionMethod: 'rewrite',
      originalTokens: 20,
      compressedTokens: 10,
      generation: 1,
      createdAt: '2026-01-01T00:01:00.000Z',
    }

    await writeConversationMessages('project', 'conversation', [message])
    const messagesPath = `${electronState.userData}/context-debug/project-conversation/messages.jsonl`
    const truthBefore = await readFile(messagesPath, 'utf8')
    await appendConversationSummaries('project', 'conversation', [summary, summary])

    expect(await readFile(messagesPath, 'utf8')).toBe(truthBefore)
    expect(await readFile(`${electronState.userData}/context-debug/project-conversation/summaries.jsonl`, 'utf8')).toContain(SUMMARY_LABEL)
    expect(await readConversationSummaryIndex('project', 'conversation')).toEqual([
      expect.objectContaining({ id: 'summary-1', kind: 'summary', truthRefs: ['truth-1'] }),
    ])
    expect(await readContextRecords('project', 'conversation', ['summary-1', 'truth-1'])).toEqual([
      expect.objectContaining({ id: 'summary-1', representation: 'summary', truthRefs: ['truth-1'], content: expect.stringContaining(SUMMARY_LABEL) }),
      expect.objectContaining({ id: 'truth-1', representation: 'original', truthRefs: ['truth-1'], content: 'The exact historical fact.' }),
    ])
    expect(await readConversationStorageOverview('project', 'conversation')).toEqual(expect.objectContaining({
      recordCount: 1,
      summaryCount: 1,
    }))
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
      summaryCount: 0,
      indexedBytes: 0,
      indexStatus: 'empty',
      lastPersistedAt: null,
    }))
  })

  it('does not treat legacy full protection as an explicit Hot pin', async () => {
    await writeConversationMessages('project', 'conversation', [
      { id: 'old-user', role: 'user', content: 'Old request' },
      { id: 'legacy-protected', role: 'assistant', content: 'Legacy protected message' },
      { id: 'latest-user', role: 'user', content: 'Latest request' },
    ])
    const indexPath = `${electronState.userData}/context-debug/project-conversation/index.json`
    const [item] = await readConversationIndex('project', 'conversation')
    await writeFile(indexPath, JSON.stringify([{ ...item, pinnedToHot: undefined, protection: 'full' }]), 'utf8')

    expect((await readConversationIndex('project', 'conversation'))[0].pinnedToHot).toBeUndefined()
    expect(await readConversationWorkingSet(
      'project',
      'conversation',
      { ...defaultContextManagementConfig, recentKeepRounds: 1, coldRecallTokenBudget: 0 },
      'No match',
    )).not.toContainEqual(expect.objectContaining({ id: 'legacy-protected', pinnedToHot: true }))
  })
  it('normalizes legacy Cold index entries without truth metadata', async () => {
    await writeConversationMessages('project', 'conversation', [
      { id: 'legacy', role: 'user', content: 'Legacy searchable message' },
    ])
    const indexPath = `${electronState.userData}/context-debug/project-conversation/index.json`
    const [item] = await readConversationIndex('project', 'conversation')
    const { kind: _kind, truthRefs: _truthRefs, ...legacy } = item
    await writeFile(indexPath, JSON.stringify([legacy]), 'utf8')

    expect(await readConversationIndex('project', 'conversation')).toEqual([
      expect.objectContaining({ id: 'legacy', kind: 'truth', truthRefs: ['legacy'] }),
    ])
    expect((await readConversationWorkingSet(
      'project',
      'conversation',
      { ...defaultContextManagementConfig, recentKeepRounds: 0 },
      'Legacy searchable message',
    )).some((message) => message.id === 'legacy')).toBe(true)
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

  it('persists Hot pins and Warm overrides without rewriting the truth log', async () => {
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

    await updateConversationPin('project', 'conversation', 'message', true)
    expect(await readConversationMessage('project', 'conversation', 'message'))
      .toEqual(expect.objectContaining({ pinnedToHot: true }))

    await updateConversationLayer('project', 'conversation', new Set(['message']), 'warm')

    expect(await readFile(messagesPath, 'utf8')).toBe(before)
    expect((await readConversationIndex('project', 'conversation'))[0].logicalPointer).toBe(pointer)
    expect(await readConversationMessage('project', 'conversation', 'message'))
      .toEqual(expect.objectContaining({
        pinnedToHot: false,
        manualContextLayer: 'warm',
      }))
  })

  it('keeps manually promoted Warm messages in Hot without pinning them', async () => {
    const messages: AgentContextMessage[] = [
      { id: 'warm-user', createdAt: '2026-01-01T00:00:00.000Z', role: 'user', content: 'Promoted context', manualContextLayer: 'warm' },
      { id: 'recent-user', createdAt: '2026-01-01T00:00:01.000Z', role: 'user', content: 'Latest request' },
    ]
    await writeConversationMessages('project', 'conversation', messages)

    const workingSet = await readConversationWorkingSet(
      'project',
      'conversation',
      { ...defaultContextManagementConfig, recentKeepRounds: 1, coldRecallTokenBudget: 0 },
      'No matching query',
      [],
      [{ ...messages[0], pinnedToHot: false, manualContextLayer: undefined, contextLayer: 'hot', contextSource: 'warm-recall' }],
    )

    expect(workingSet.filter((message) => message.id === 'warm-user')).toEqual([
      expect.objectContaining({ contextLayer: 'hot', contextSource: 'warm-recall', pinnedToHot: false, manualContextLayer: undefined }),
    ])
  })

  it('preserves persisted Hot entry metadata across working-set rebuilds', async () => {
    const messages: AgentContextMessage[] = [
      { id: 'old-user', createdAt: '2026-01-01T00:00:00.000Z', role: 'user', content: 'Old request' },
      { id: 'latest-user', createdAt: '2026-08-26T00:00:00.000Z', role: 'user', content: 'Latest request' },
    ]
    await writeConversationMessages('project', 'conversation', messages)
    const rememberedHot: AgentContextMessage[] = [{
      ...messages[0],
      contextLayer: 'hot',
      enteredHotAt: '2026-08-20T00:00:00.000Z',
      lastAccessedAt: '2026-08-21T00:00:00.000Z',
      reuseCount: 3,
    }]

    const workingSet = await readConversationWorkingSet(
      'project',
      'conversation',
      { ...defaultContextManagementConfig, coldRecallTokenBudget: 0 },
      '',
      [],
      [],
      rememberedHot,
      'latest-user',
    )

    expect(workingSet.find((message) => message.id === 'old-user')).toEqual(expect.objectContaining({
      enteredHotAt: '2026-08-20T00:00:00.000Z',
      lastAccessedAt: '2026-08-21T00:00:00.000Z',
      reuseCount: 3,
    }))
    expect(workingSet.find((message) => message.id === 'latest-user')).toEqual(expect.objectContaining({ contextLayer: 'hot' }))
  })
  it('initializes a budgeted Hot working set while leaving unrelated Cold data unread', async () => {
    const messages: AgentContextMessage[] = [
      { id: 'old-user', createdAt: '2026-01-01T00:00:00.000Z', role: 'user', content: 'Unrelated old request '.repeat(2_000) },
      { id: 'pinned', createdAt: '2026-01-01T00:00:01.000Z', role: 'assistant', content: 'Pinned decision', pinnedToHot: true },
      { id: 'warm-user', createdAt: '2026-01-01T00:00:02.000Z', role: 'user', content: 'Manual warm request', manualContextLayer: 'warm' },
      { id: 'cold-reply', createdAt: '2026-01-01T00:00:03.000Z', role: 'assistant', content: 'Unrelated Cold reply '.repeat(2_000) },
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
        hotTokenBudget: 1_000,
        warmTokenBudget: 0,
        coldRecallTokenBudget: 0,
      },
      'No matching query',
    )

    expect(workingSet.map((message) => message.id))
      .toEqual(['pinned', 'recent-user', 'recent-reply', 'warm-user'])
    expect(workingSet.find((message) => message.id === 'warm-user'))
      .toEqual(expect.objectContaining({ contextLayer: 'warm', contextSource: 'hot-demotion', manualContextLayer: 'warm' }))
  })
})
