import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachment } from '../src/shared/image-attachments'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

const electronState = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userData,
  },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

import { addMessage, addModelRequestEvent, createConversation, createProject, getProjects, getProjectsLive, updateConversationHotLongTermContent } from '../src/main/workspace'

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else files.push(path)
  }
  return files
}

function image(): ImageAttachment {
  return { id: 'image-1', name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' }
}

describe('sharded workspace storage', () => {
  beforeEach(async () => {
    electronState.userData = await createTemporaryDirectory('codey-workspace-')
  })

  afterEach(async () => {
    await removeTemporaryDirectory(electronState.userData)
  })

  it('migrates a legacy monolithic workspace during the first serialized write', async () => {
    const attachment = image()
    await writeFile(join(electronState.userData, 'workspace.json'), JSON.stringify([{
      id: 'legacy-project',
      name: 'Legacy',
      folders: ['D:/legacy'],
      conversations: [{
        id: 'legacy-conversation',
        title: 'Legacy conversation',
        messages: [{ id: 'legacy-message', role: 'user', content: 'Legacy image', images: [attachment] }],
      }],
    }]), 'utf8')

    const created = await createProject('New project')
    const projects = await getProjects()
    expect(projects.map((project) => project.id)).toEqual(['legacy-project', created.id])
    expect(projects[0].conversations[0].messages[0].images?.[0]).toEqual(attachment)
    expect(projects[0].conversations[0].hotLongTermContent).toBe('')

    const manifestText = await readFile(join(electronState.userData, 'workspace.json'), 'utf8')
    expect(JSON.parse(manifestText)).toEqual({ version: 2, projectIds: ['legacy-project', created.id] })
    const jsonFiles = (await filesUnder(join(electronState.userData, 'workspace-data')))
      .filter((path) => path.endsWith('.json'))
    const persistedJson = await Promise.all(jsonFiles.map((path) => readFile(path, 'utf8')))
    expect(persistedJson.join('\n')).not.toContain('data:image/png;base64')
  })
  it('stores projects and conversations in separate shards', async () => {
    const first = await createProject('First')
    const second = await createProject('Second')

    const manifest = JSON.parse(await readFile(join(electronState.userData, 'workspace.json'), 'utf8'))
    expect(manifest).toEqual({ version: 2, projectIds: [first.id, second.id] })
    expect(await readFile(join(electronState.userData, 'workspace-data', 'projects', Buffer.from(first.id).toString('base64url'), 'project.json'), 'utf8'))
      .toContain('conversationIds')
    expect((await getProjects()).map((project) => project.name)).toEqual(['First', 'Second'])
  })

  async function reloadFromDisk(directory: string): Promise<void> {
    const resetDirectory = await createTemporaryDirectory('codey-workspace-reload-')
    electronState.userData = resetDirectory
    await getProjectsLive()
    await removeTemporaryDirectory(resetDirectory)
    electronState.userData = directory
  }

  it('persists and clears Long-term content without sharing it across conversations', async () => {
    const project = await createProject('Long-term')
    const firstId = project.conversations[0]!.id
    await createConversation(project.id)
    const secondId = project.conversations[1]!.id
    await updateConversationHotLongTermContent(project.id, firstId, 'Confirmed preference')
    await reloadFromDisk(electronState.userData)
    let conversations = (await getProjects())[0]!.conversations
    expect(conversations.find((item) => item.id === firstId)?.hotLongTermContent).toBe('Confirmed preference')
    expect(conversations.find((item) => item.id === secondId)?.hotLongTermContent).toBe('')

    await updateConversationHotLongTermContent(project.id, firstId, '')
    await reloadFromDisk(electronState.userData)
    conversations = (await getProjects())[0]!.conversations
    expect(conversations.find((item) => item.id === firstId)?.hotLongTermContent).toBe('')
  })

  it('retains old Long-term content on disk and in memory when saving fails', async () => {
    const project = await createProject('Atomic Long-term')
    const conversation = project.conversations[0]!
    await updateConversationHotLongTermContent(project.id, conversation.id, 'Original')
    vi.mocked(rename).mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(updateConversationHotLongTermContent(project.id, conversation.id, 'Replacement'))
      .rejects.toThrow('disk unavailable')
    expect(conversation.hotLongTermContent).toBe('Original')
    await reloadFromDisk(electronState.userData)
    expect((await getProjects())[0]!.conversations[0]!.hotLongTermContent).toBe('Original')
    await updateConversationHotLongTermContent(project.id, conversation.id, 'Retry')
    expect((await getProjects())[0]!.conversations[0]!.hotLongTermContent).toBe('Retry')
  })

  it('serializes Long-term replacements alongside history writes without losing either', async () => {
    const project = await createProject('Concurrent Long-term')
    const conversationId = project.conversations[0]!.id
    await Promise.all([
      updateConversationHotLongTermContent(project.id, conversationId, 'First'),
      addMessage(project.id, conversationId, 'user', 'Keep history'),
      updateConversationHotLongTermContent(project.id, conversationId, 'Last'),
    ])
    await reloadFromDisk(electronState.userData)
    const stored = (await getProjects())[0]!.conversations[0]!
    expect(stored.hotLongTermContent).toBe('Last')
    expect(stored.messages).toEqual([expect.objectContaining({ content: 'Keep history' })])
  })

  it('preserves model request events across a reload without adding them to model history', async () => {
    const project = await createProject('Recovery')
    const conversationId = project.conversations[0]!.id
    const event = { kind: 'failure' as const, model: 'primary', reason: 'SSE stream ended before [DONE]', attempt: 1 }
    await addModelRequestEvent(project.id, conversationId, event)
    await reloadFromDisk(electronState.userData)
    const stored = (await getProjects())[0]!.conversations[0]!
    expect(stored.messages.at(-1)?.modelRequest).toEqual(event)
    expect(stored.agentMessages).toEqual([])
  })

  it('salvages valid projects and quarantines a damaged conversation after restart', async () => {
    const first = await createProject('First')
    const second = await createProject('Second')
    const secondConversation = second.conversations[0]
    await addMessage(first.id, first.conversations[0].id, 'user', 'keep me', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'keep-message')

    const secondConversationPath = join(
      electronState.userData,
      'workspace-data',
      'projects',
      Buffer.from(second.id).toString('base64url'),
      'conversations',
      `${Buffer.from(secondConversation.id).toString('base64url')}.json`,
    )
    await writeFile(secondConversationPath, '{"messages":[', 'utf8')
    await reloadFromDisk(electronState.userData)

    const recovered = await getProjects()
    expect(recovered.map((project) => project.id)).toEqual([first.id, second.id])
    expect(recovered.find((project) => project.id === first.id)?.conversations[0].messages).toEqual([
      expect.objectContaining({ id: 'keep-message', content: 'keep me' }),
    ])
    expect(recovered.find((project) => project.id === second.id)?.conversations).toHaveLength(1)
    expect(recovered.find((project) => project.id === second.id)?.conversations[0].messages).toEqual([])

    const projectMetadataPath = join(
      electronState.userData,
      'workspace-data',
      'projects',
      Buffer.from(second.id).toString('base64url'),
      'project.json',
    )
    const metadata = JSON.parse(await readFile(projectMetadataPath, 'utf8')) as { conversationIds: string[] }
    expect(metadata.conversationIds).toHaveLength(1)
    expect(metadata.conversationIds[0]).not.toBe(secondConversation.id)
    const files = await filesUnder(electronState.userData)
    expect(files.some((path) => path.startsWith(`${secondConversationPath}.corrupt-`))).toBe(true)
  })

  it('rebuilds a damaged manifest from valid project shards', async () => {
    const first = await createProject('First')
    const second = await createProject('Second')
    const workspacePath = join(electronState.userData, 'workspace.json')
    await writeFile(workspacePath, '{"version":2,"projectIds":', 'utf8')
    await reloadFromDisk(electronState.userData)

    const recovered = await getProjects()
    expect(new Set(recovered.map((project) => project.id))).toEqual(new Set([first.id, second.id]))
    expect(JSON.parse(await readFile(workspacePath, 'utf8'))).toEqual({
      version: 2,
      projectIds: expect.arrayContaining([first.id, second.id]),
    })
    const files = await filesUnder(electronState.userData)
    expect(files.some((path) => path.startsWith(`${workspacePath}.corrupt-`))).toBe(true)
  })
  it('writes image bytes separately and never persists a data URL', async () => {
    const project = await createProject('Images')
    const conversation = project.conversations[0]
    await addMessage(project.id, conversation.id, 'user', 'Look', undefined, undefined, undefined, undefined, undefined, [image()], undefined, 'message-1')

    const root = join(electronState.userData, 'workspace-data')
    const files = await filesUnder(root)
    const json = await Promise.all(files.filter((path) => path.endsWith('.json')).map((path) => readFile(path, 'utf8')))
    expect(json.join('\n')).not.toContain('data:image/png;base64')
    expect(files.some((path) => path.endsWith('aW1hZ2UtMQ.png') && path.includes(join('workspace-data', 'images')))).toBe(true)
    const loaded = (await getProjects())[0].conversations[0].messages[0]
    expect(loaded.images?.[0]).toEqual(image())
  })

  it('serializes concurrent writes without losing projects or messages', async () => {
    const project = await createProject('Concurrent')
    const conversation = project.conversations[0]
    await Promise.all(Array.from({ length: 12 }, (_, index) => addMessage(
      project.id,
      conversation.id,
      'user',
      `Message ${index}`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      `message-${index}`,
    )))

    const loaded = (await getProjects())[0]
    expect(loaded.conversations[0].messages).toHaveLength(12)
    expect(new Set(loaded.conversations[0].messages.map((message) => message.id)).size).toBe(12)
  })
})
