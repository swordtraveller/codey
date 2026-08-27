import { readFile, readdir, writeFile } from 'node:fs/promises'
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

import { addMessage, createProject, getProjects } from '../src/main/workspace'

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

  it('writes image bytes separately and never persists a data URL', async () => {
    const project = await createProject('Images')
    const conversation = project.conversations[0]
    await addMessage(project.id, conversation.id, 'user', 'Look', undefined, undefined, undefined, undefined, undefined, [image()], 'message-1')

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
      `message-${index}`,
    )))

    const loaded = (await getProjects())[0]
    expect(loaded.conversations[0].messages).toHaveLength(12)
    expect(new Set(loaded.conversations[0].messages.map((message) => message.id)).size).toBe(12)
  })
})
