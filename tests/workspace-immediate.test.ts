import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

const electronState = vi.hoisted(() => ({ userData: '' }))
const persistence = vi.hoisted(() => ({
  release: undefined as (() => void) | undefined,
  started: undefined as (() => void) | undefined,
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userData,
    isPackaged: false,
    getPathForFile: () => '',
  },
}))

vi.mock('../src/main/image-store', () => ({
  hydrateImageAttachments: vi.fn(async (images: unknown) => images),
  imageReferences: vi.fn((_projectId: string, _conversationId: string, images: unknown) => images),
  persistImageAttachments: vi.fn(async () => {
    persistence.started?.()
    await new Promise<void>((resolve) => { persistence.release = resolve })
    return undefined
  }),
}))

import { addMessageImmediately, createProject, getProjects, getProjectsLive } from '../src/main/workspace'

describe('immediate workspace message publication', () => {
  beforeEach(async () => {
    electronState.userData = await createTemporaryDirectory('codey-workspace-immediate-')
  })

  afterEach(async () => {
    persistence.release?.()
    persistence.release = undefined
    persistence.started = undefined
    await removeTemporaryDirectory(electronState.userData)
  })

  it('publishes the in-memory message before durable persistence settles', async () => {
    const project = await createProject('Immediate')
    const conversation = project.conversations[0]
    let persistenceStarted = false
    persistence.started = () => { persistenceStarted = true }

    const published = await addMessageImmediately(project.id, conversation.id, 'user', 'Send now', undefined, undefined, undefined, undefined, undefined, undefined, 'message-1')

    expect(persistenceStarted).toBe(false)
    expect(published.conversations[0].messages.at(-1)).toEqual(expect.objectContaining({ id: 'message-1', content: 'Send now' }))
    expect((await getProjectsLive())[0].conversations[0].messages.at(-1)).toEqual(expect.objectContaining({ id: 'message-1' }))

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(persistenceStarted).toBe(true)
    persistence.release?.()
    await getProjects()
    expect(JSON.parse(await readFile(join(electronState.userData, 'workspace-data', 'projects', Buffer.from(project.id).toString('base64url'), 'conversations', `${Buffer.from(conversation.id).toString('base64url')}.json`), 'utf8')).messages.at(-1).id).toBe('message-1')
  })
})
