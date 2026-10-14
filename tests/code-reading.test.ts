import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'
import { findCodeReadReferences, formatCodeReadReference, parseCodeReadReference } from '../src/shared/code-reading'

const electronState = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electronState.userData } }))

import { captureCodeReadSnapshots, getCodeReadSnapshot } from '../src/main/code-reading'
import type { Project } from '../src/shared/types'

describe('code-reading references', () => {
  it('parses and canonicalizes a multi-folder source reference', () => {
    const link = 'codey://coderead/text?path=src%2F%E6%A8%A1%E5%9D%97.ts&root=folder%20one#L6-L12'
    expect(parseCodeReadReference(link)).toEqual({ rootId: 'folder one', path: 'src/模块.ts', startLine: 6, endLine: 12 })
    expect(formatCodeReadReference(parseCodeReadReference(link)!)).toBe('codey://coderead/text?root=folder%20one&path=src%2F%E6%A8%A1%E5%9D%97.ts#L6-L12')
  })

  it.each([
    'codey://coderead/text?root=root&path=../secret.ts',
    'codey://coderead/text?root=root&path=C%3A%2Fsecret.ts',
    'codey://coderead/text?root=root&path=src%5Csecret.ts',
    'codey://coderead/text?root=root&path=src%2Fa.ts#L8-L2',
    'codey://coderead/text?root=root&path=src%2Fa.ts#L0',
    'codey://coderead/text?root=root&path=src%2Fa.ts&other=value',
    'https://coderead/text?root=root&path=src%2Fa.ts',
  ])('rejects unsafe or malformed link %s', (link) => {
    expect(parseCodeReadReference(link)).toBeNull()
  })

  it('deduplicates only valid links found in an assistant response', () => {
    const link = 'codey://coderead/text?root=root&path=src%2Fa.ts#L1-L3'
    expect(findCodeReadReferences(`[first](${link}) and [again](${link}) and codey://coderead/text?root=root&path=../x`))
      .toEqual([{ sourceLink: link, reference: { rootId: 'root', path: 'src/a.ts', startLine: 1, endLine: 3 } }])
  })
})

describe('code-reading snapshots', () => {
  let directory = ''
  beforeEach(async () => {
    directory = await createTemporaryDirectory('codey-code-read-')
    electronState.userData = join(directory, 'data')
    await mkdir(join(directory, 'project', 'src'), { recursive: true })
    await writeFile(join(directory, 'project', 'src', 'entry.ts'), 'export const version = 1\n', 'utf8')
  })
  afterEach(async () => { await removeTemporaryDirectory(directory) })

  it.each(['markdown', 'architecture'])('persists an immutable %s snapshot scoped to the assistant message', async (format) => {
    const link = 'codey://coderead/text?root=source&path=src%2Fentry.ts#L1'
    const content = format === 'architecture'
      ? '```architecture\n' + JSON.stringify({ nodes: [{ id: 'entry', label: 'Entry', source: { root: 'source', path: 'src/entry.ts', startLine: 1 } }], edges: [] }) + '\n```'
      : `[entry](${link})`
    const project = {
      id: 'project', name: 'Project', archived: false, defaultModelConfigId: null,
      contextConfigOverride: null, commandExecutionDefault: null, agentLimitsDefault: null,
      skillSelection: { include: [], exclude: [] }, knowledgeBaseSelection: { include: [], exclude: [] },
      folders: [{ id: 'source', path: join(directory, 'project') }], pythonEnvironmentFolderId: null,
      conversations: [{ id: 'conversation', title: '', archived: false, modelConfigId: null, contextConfigOverride: null,
        skillSelection: { include: [], exclude: [] }, knowledgeBaseSelection: { include: [], exclude: [] }, agentLimits: null,
        commandExecution: null, messages: [{ id: 'assistant-1', role: 'assistant', content, createdAt: '' }], agentMessages: [] }],
    } as unknown as Project
    await captureCodeReadSnapshots(project, 'conversation', 'assistant-1', content)
    await writeFile(join(directory, 'project', 'src', 'entry.ts'), 'export const version = 2\n', 'utf8')
    await expect(getCodeReadSnapshot(project, 'conversation', 'assistant-1', link)).resolves.toMatchObject({
      content: 'export const version = 1\n', reference: { path: 'src/entry.ts', startLine: 1 }, language: 'typescript',
    })
    await expect(getCodeReadSnapshot(project, 'conversation', 'other-message', link)).rejects.toThrow('does not belong')
    const snapshotRoot = join(electronState.userData, 'workspace-data', 'projects', Buffer.from('project').toString('base64url'), 'conversations', Buffer.from('conversation').toString('base64url'), 'code-read-snapshots')
    const index = JSON.parse(await readFile(join(snapshotRoot, 'index.json'), 'utf8'))
    expect(index.records).toHaveLength(1)
  })
})
