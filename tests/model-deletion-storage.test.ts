import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'
import { auditReview, modelDeletionConfig, modelDeletionProject } from './model-deletion-fixtures'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.userData }, safeStorage: { isEncryptionAvailable: () => false } }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
import { readConfig, saveConfig } from '../src/main/config'
import { getProjects, saveModelConfiguration, renameConversation } from '../src/main/workspace'
import { recoverModelReferenceUpdate, writeModelReferenceUpdate } from '../src/main/model-reference-update'
import { deleteModelEntities } from '../src/shared/model-deletion'

async function snapshot(directory = state.userData): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(result, await snapshot(path))
    else result[relative(state.userData, path)] = (await readFile(path)).toString('base64')
  }
  return result
}

async function setup() {
  const config = await saveConfig({ ...modelDeletionConfig(), commandReviewGlobal: auditReview('a-large') })
  await writeFile(join(state.userData, 'workspace.json'), JSON.stringify([modelDeletionProject()]))
  await getProjects() // Migrate legacy data into real paged shards before taking snapshots.
  return config
}

const replacements = { 'a-large': 'b-small', single: 'mixed' }

describe('persisted model deletion', () => {
  beforeEach(async () => { state.userData = await createTemporaryDirectory('codey-model-deletion-') })
  afterEach(async () => { vi.mocked(rename).mockReset(); await removeTemporaryDirectory(state.userData) })

  it('saves global and archived references together, preserving records and reloading without old selections', async () => {
    const before = await setup()
    const files = await snapshot()
    const after = deleteModelEntities(before, { kind: 'provider', id: 'a' })
    await saveModelConfiguration(after, replacements)
    const projects = await getProjects()
    expect(projects[0].defaultModelConfigId).toBeNull()
    expect(projects[0].conversations[0].modelConfigId).toBeNull()
    expect(projects[0].conversations[0].lastUsedModelId).toBeUndefined()
    expect(projects[0].commandExecutionDefault?.review?.reviewers.auditModelConfigId).toBe('mixed')
    expect(projects[0].conversations[0].commandExecution?.review?.reviewers.auditModelConfigId).toBe('b-small')
    const nextFiles = await snapshot()
    for (const [path, content] of Object.entries(files)) {
      if (!path.endsWith('model-config.json') && !path.endsWith('project.json') && !path.endsWith(Buffer.from('conversation').toString('base64url') + '.json')) {
        expect(nextFiles[path], path).toBe(content)
      }
    }
    const directory = state.userData
    const empty = await createTemporaryDirectory('codey-model-reload-')
    try {
      state.userData = empty
      await getProjects()
      state.userData = directory
      const reloaded = await getProjects()
      expect(reloaded[0].conversations[0].messages).toEqual(projects[0].conversations[0].messages)
      expect(reloaded[0].conversations[0].messages[0].modelConfig?.id).toBe('a-large')
      expect(reloaded[0].conversations[0].perModelContextConfigs).not.toHaveProperty('a-large')
      expect((await readConfig()).activeModelConfigId).toBe('b-small')
    } finally { state.userData = directory; await removeTemporaryDirectory(empty) }
  })

  it('rejects missing audit replacement and last-model removal without mutating files or live state', async () => {
    const config = await setup()
    const files = await snapshot()
    const live = structuredClone(await getProjects())
    const after = deleteModelEntities(config, { kind: 'provider', id: 'a' })
    await expect(saveModelConfiguration(after, { 'a-large': 'b-small' })).rejects.toThrow('MODEL_REPLACEMENT_REQUIRED')
    await expect(saveModelConfiguration({ ...after, models: [], modelGroups: [] })).rejects.toThrow('MODEL_LAST_REQUIRED')
    expect(await snapshot()).toEqual(files)
    expect(await getProjects()).toEqual(live)
  })

  it('rolls back earlier shard writes if the config replacement fails, then permits a clean retry', async () => {
    const config = await setup()
    const files = await snapshot()
    const live = structuredClone(await getProjects())
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let failed = false
    vi.mocked(rename).mockImplementation(async (source, destination) => {
      if (!failed && String(destination) === join(state.userData, 'model-config.json')) {
        failed = true
        throw new Error('simulated config write failure')
      }
      return actual.rename(source, destination)
    })
    const after = deleteModelEntities(config, { kind: 'provider', id: 'a' })
    await expect(saveModelConfiguration(after, replacements)).rejects.toThrow('simulated config write failure')
    expect(failed).toBe(true)
    expect(await snapshot()).toEqual(files)
    expect(await getProjects()).toEqual(live)
    await saveModelConfiguration(after, replacements)
    expect((await readConfig()).activeModelConfigId).toBe('b-small')
    expect((await getProjects())[0].defaultModelConfigId).toBeNull()
  })

  it('serializes metadata changes queued before and after a configuration save', async () => {
    const config = await setup()
    const first = renameConversation('project', 'conversation', 'Before deletion')
    const save = saveModelConfiguration(deleteModelEntities(config, { kind: 'provider', id: 'a' }), replacements)
    const last = renameConversation('project', 'conversation', 'After deletion')
    await Promise.all([first, save, last])
    const conversation = (await getProjects())[0].conversations[0]
    expect(conversation.title).toBe('After deletion')
    expect(conversation.modelConfigId).toBeNull()
    expect(conversation.commandExecution?.review?.reviewers.auditModelConfigId).toBe('b-small')
  })
})

describe('interrupted model-reference transactions', () => {
  beforeEach(async () => { state.userData = await createTemporaryDirectory('codey-model-recovery-') })
  afterEach(async () => { vi.mocked(rename).mockReset(); await removeTemporaryDirectory(state.userData) })

  it.each(['apply', 'rollback'] as const)('recovers an interrupted %s transaction idempotently', async phase => {
    const path = join(state.userData, 'model-config.json')
    await writeFile(path, 'partial')
    await writeFile(join(state.userData, 'model-reference-update.json'), JSON.stringify({
      version: 1, phase, entries: [{ path, before: 'old', content: 'new' }],
    }))
    await recoverModelReferenceUpdate()
    await recoverModelReferenceUpdate()
    expect(await readFile(path, 'utf8')).toBe(phase === 'apply' ? 'new' : 'old')
    await expect(readFile(join(state.userData, 'model-reference-update.json'))).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('keeps rollback intent when restoration also fails so startup can retry', async () => {
    const path = join(state.userData, 'model-config.json')
    await writeFile(path, 'old')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(rename).mockImplementation(async (source, destination) => {
      if (String(destination) === path) throw new Error('temporarily locked')
      return actual.rename(source, destination)
    })
    await expect(writeModelReferenceUpdate([{ path, content: 'new' }])).rejects.toThrow('temporarily locked')
    expect(JSON.parse(await readFile(join(state.userData, 'model-reference-update.json'), 'utf8')).phase).toBe('rollback')
    vi.mocked(rename).mockImplementation(actual.rename)
    await recoverModelReferenceUpdate()
    expect(await readFile(path, 'utf8')).toBe('old')
  })

  it('validates every recovery path before applying any entry', async () => {
    const path = join(state.userData, 'model-config.json')
    const other = join(state.userData, 'unrelated.txt')
    await writeFile(path, 'old')
    await writeFile(other, 'keep')
    await writeFile(join(state.userData, 'model-reference-update.json'), JSON.stringify({ version: 1, phase: 'apply', entries: [
      { path, before: 'old', content: 'new' }, { path: other, before: 'keep', content: 'overwrite' },
    ] }))
    await expect(recoverModelReferenceUpdate()).rejects.toThrow('Invalid model-reference update path')
    expect(await readFile(path, 'utf8')).toBe('old')
    expect(await readFile(other, 'utf8')).toBe('keep')
  })
  it('persists explicit empty defaults and enabled audits across save/read and archived metadata', async () => {
    const before = await setup()
    const result = await saveModelConfiguration(deleteModelEntities(before, { kind: 'provider', id: 'a' }), { 'a-large': null, single: null })
    expect(result.activeModelConfigId).toBeNull()
    expect(result.commandReviewGlobal.reviewers).toMatchObject({ auditModel: true, auditModelConfigId: null })
    const reloaded = await readConfig()
    expect(reloaded.activeModelConfigId).toBeNull()
    expect(reloaded.commandReviewGlobal.reviewers).toMatchObject({ auditModel: true, auditModelConfigId: null })
    const projects = await getProjects()
    expect(projects[0].defaultModelConfigId).toBeNull()
    expect(projects[0].commandExecutionDefault?.review?.reviewers).toMatchObject({ auditModel: true, auditModelConfigId: null })
    expect(projects[0].conversations[0].commandExecution?.review?.reviewers).toMatchObject({ auditModel: true, auditModelConfigId: null })
    await expect(saveModelConfiguration(result)).resolves.toMatchObject({ activeModelConfigId: null })
  })

})
