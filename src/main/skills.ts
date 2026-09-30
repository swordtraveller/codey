import { createHash, randomUUID } from 'node:crypto'
import { app } from 'electron'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import type {
  InstalledSkill,
  Project,
  ResourceSelectionOverride,
  SkillImportCandidate,
  SkillImportPreview,
  SkillTool,
  SkillToolRuntime,
} from '../shared/types'
import { runSandboxProcess } from './sandbox'

const maximumPackageFiles = 300
const maximumPackageBytes = 10 * 1024 * 1024
const maximumSingleFileBytes = 2 * 1024 * 1024
const previewLifetimeMs = 30 * 60 * 1000
const maximumGitHubUrlLength = 2_048
const maximumSelectionIds = 1_000
const maximumResourceIdLength = 2_048

export type GitHubSkillSource = {
  owner: string
  repo: string
  ref: string | null
  path: string
  canonicalUrl: string
}

type PreviewRecord = {
  createdAt: number
  preview: SkillImportPreview
  source: GitHubSkillSource & { commitSha: string }
  files: Map<string, Buffer>
  instructions: string
}

type RegistryFile = { version: 1; skills: InstalledSkill[] }
type GitHubTreeEntry = { path?: string; mode?: string; type?: string; sha?: string; size?: number }

const previews = new Map<string, PreviewRecord>()
let skillMutationTail: Promise<void> = Promise.resolve()

function serializeSkillMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = skillMutationTail.then(operation, operation)
  skillMutationTail = result.then(() => undefined, () => undefined)
  return result
}

function skillsRoot(): string {
  return join(app.getPath('userData'), 'skills')
}
function packagesRoot(): string {
  return join(skillsRoot(), 'packages')
}
function registryPath(): string {
  return join(skillsRoot(), 'registry.json')
}

function cleanRelativePath(value: string): string {
  const normalized = posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized || normalized === '.') return ''
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('Skill path escapes the package root')
  }
  return normalized
}

export function parseGitHubSkillUrl(input: string): GitHubSkillSource {
  if (typeof input !== 'string' || input.length > maximumGitHubUrlLength) throw new Error('Enter a valid GitHub URL')
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('Enter a valid GitHub URL') }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Only public https://github.com links are supported')
  }
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (parts.length < 2) throw new Error('The GitHub URL must identify a repository')
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid GitHub repository path')
  if (parts.length > 2 && parts[2] !== 'tree') throw new Error('Use a repository URL or a GitHub /tree/ URL')
  const tail = parts[2] === 'tree' ? parts.slice(3) : []
  return {
    owner,
    repo,
    ref: tail.length > 0 ? tail.join('/') : null,
    path: '',
    canonicalUrl: `https://github.com/${owner}/${repo}`,
  }
}

export function githubSkillTrackingUrl(source: GitHubSkillSource): string {
  if (!source.ref) return source.canonicalUrl
  const treeTail = source.ref.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return `${source.canonicalUrl}/tree/${treeTail}`
}

export function stableSkillId(owner: string, repo: string, sourcePath: string): string {
  const canonical = `${owner.toLowerCase()}/${repo.toLowerCase()}:${cleanRelativePath(sourcePath).toLowerCase()}`
  return `github:${canonical}`
}

export function sanitizeResourceSelection(value: unknown): ResourceSelectionOverride {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Partial<ResourceSelectionOverride>
    : undefined
  const enabledSource = Array.isArray(record?.enabledIds) ? record.enabledIds : []
  const disabledSource = Array.isArray(record?.disabledIds) ? record.disabledIds : []
  const enabledIds = [...new Set(enabledSource.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()))]
  const enabled = new Set(enabledIds)
  const disabledIds = [...new Set(disabledSource.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()))]
    .filter((id) => !enabled.has(id))
  return { enabledIds, disabledIds }
}

export function validateResourceSelection(value: unknown): ResourceSelectionOverride {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Skill selection is invalid')
  const record = value as Partial<ResourceSelectionOverride>
  if (!Array.isArray(record.enabledIds) || !Array.isArray(record.disabledIds)) throw new Error('Skill selection is invalid')
  const ids = [...record.enabledIds, ...record.disabledIds]
  if (ids.length > maximumSelectionIds
    || !ids.every((id) => typeof id === 'string' && id.trim() !== '' && id.length <= maximumResourceIdLength)) {
    throw new Error('Skill selection is invalid')
  }
  return sanitizeResourceSelection(record)
}

export function resolveSkillSelection(globalIds: string[], project: ResourceSelectionOverride, conversation: ResourceSelectionOverride): string[] {
  const projectSelection = sanitizeResourceSelection(project)
  const conversationSelection = sanitizeResourceSelection(conversation)
  const effective = new Set(globalIds.filter((id) => typeof id === 'string' && id.trim() !== ''))
  for (const id of projectSelection.enabledIds) effective.add(id)
  for (const id of projectSelection.disabledIds) effective.delete(id)
  for (const id of conversationSelection.enabledIds) effective.add(id)
  for (const id of conversationSelection.disabledIds) effective.delete(id)
  return [...effective]
}

class GitHubRequestError extends Error {
  constructor(readonly status: number, message: string, readonly apiMessage = '') {
    super(message)
    this.name = 'GitHubRequestError'
  }
}

async function githubJson(path: string): Promise<any> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Codey-Skill-Importer' },
  })
  if (!response.ok) {
    let apiMessage = ''
    try {
      const body = await response.json() as { message?: unknown }
      if (typeof body?.message === 'string') apiMessage = body.message
    } catch {
      // GitHub error bodies are helpful for classification but are not guaranteed to be JSON.
    }
    const missingCommit = response.status === 422 && /^No commit found for SHA:/i.test(apiMessage)
    const message = response.status === 404 || missingCommit
      ? 'GitHub repository, ref, or path was not found (public repositories only)'
      : response.status === 403
        ? 'GitHub rate limit reached; try again later'
        : `GitHub request failed (${response.status})`
    throw new GitHubRequestError(response.status, message, apiMessage)
  }
  return response.json()
}

function isMissingCommitRef(error: unknown): error is GitHubRequestError {
  return error instanceof GitHubRequestError
    && (error.status === 404
      || (error.status === 422 && /^No commit found for SHA:/i.test(error.apiMessage)))
}

function githubCommitSha(value: unknown): string {
  const sha = typeof value === 'string' ? value.toLowerCase() : ''
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('GitHub returned an invalid commit SHA')
  return sha
}

async function resolveSource(source: GitHubSkillSource): Promise<GitHubSkillSource & { commitSha: string }> {
  if (!source.ref) {
    const repository = await githubJson(`/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`)
    const defaultBranch = String(repository.default_branch || '')
    if (!defaultBranch) throw new Error('GitHub repository has no default branch')
    const commit = await githubJson(`/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/commits/${encodeURIComponent(defaultBranch)}`)
    return { ...source, ref: defaultBranch, commitSha: githubCommitSha(commit.sha), path: '' }
  }

  const segments = source.ref.split('/').filter(Boolean)
  for (let length = segments.length; length >= 1; length -= 1) {
    const candidateRef = segments.slice(0, length).join('/')
    try {
      const commit = await githubJson(`/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/commits/${encodeURIComponent(candidateRef)}`)
      return {
        ...source,
        ref: candidateRef,
        commitSha: githubCommitSha(commit.sha),
        path: cleanRelativePath(segments.slice(length).join('/')),
      }
    } catch (error) {
      if (!isMissingCommitRef(error) || length === 1) throw error
    }
  }
  throw new Error('Unable to resolve the GitHub ref')
}

async function downloadSource(source: GitHubSkillSource & { commitSha: string }): Promise<Map<string, Buffer>> {
  const tree = await githubJson(`/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/trees/${encodeURIComponent(source.commitSha)}?recursive=1`)
  if (tree.truncated === true) throw new Error('The GitHub repository tree is too large to import safely')
  const prefix = source.path ? `${source.path}/` : ''
  const entries = (Array.isArray(tree.tree) ? tree.tree : []) as GitHubTreeEntry[]
  const scopedEntries = entries.filter((entry) => typeof entry.path === 'string' && (entry.path === source.path || entry.path.startsWith(prefix)))
  if (scopedEntries.some((entry) => entry.mode === '120000' || entry.mode === '160000' || entry.type === 'commit')) {
    throw new Error('Symlinks and submodules are not supported in skill packages')
  }
  const selected = scopedEntries.filter((entry) => entry.type === 'blob')
  if (selected.length === 0) throw new Error('The selected GitHub path contains no files')
  if (selected.length > maximumPackageFiles) throw new Error(`Skill packages may contain at most ${maximumPackageFiles} files`)
  let declaredBytes = 0
  for (const entry of selected) {
    if ((entry.size ?? 0) > maximumSingleFileBytes) throw new Error(`Skill file is larger than ${maximumSingleFileBytes} bytes`)
    declaredBytes += entry.size ?? 0
  }
  if (declaredBytes > maximumPackageBytes) throw new Error(`Skill packages may be at most ${maximumPackageBytes} bytes`)

  const files = new Map<string, Buffer>()
  let total = 0
  for (const entry of selected) {
    const fullPath = cleanRelativePath(entry.path!)
    const relativePath = source.path ? cleanRelativePath(fullPath.slice(prefix.length)) : fullPath
    if (!relativePath || !entry.sha) continue
    const blob = await githubJson(`/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/blobs/${encodeURIComponent(entry.sha)}`)
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error(`Unable to decode ${relativePath}`)
    const content = Buffer.from(blob.content.replace(/\s/g, ''), 'base64')
    total += content.byteLength
    if (content.byteLength > maximumSingleFileBytes || total > maximumPackageBytes) throw new Error('Skill package exceeds the import size limit')
    files.set(relativePath, content)
  }
  return files
}

function titleFromInstructions(instructions: string, source: GitHubSkillSource): string {
  const heading = instructions.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return heading || basename(source.path || source.repo)
}
function descriptionFromInstructions(instructions: string): string {
  return instructions
    .replace(/^---[\s\S]*?---\s*/m, '')
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s*/gm, '').trim())
    .find((part) => part && !part.startsWith('#'))?.slice(0, 500) ?? ''
}
function candidateFromPath(entry: string): SkillImportCandidate | null {
  if (!entry.startsWith('scripts/') || entry.slice('scripts/'.length).includes('/')) return null
  const extension = extname(entry).toLowerCase()
  const runtime: SkillToolRuntime | null = ['.js', '.mjs', '.cjs'].includes(extension) ? 'node' : extension === '.py' ? 'python' : null
  if (!runtime) return null
  const rawName = basename(entry, extension)
  const name = rawName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'run'
  return { id: entry, name, runtime, entry, description: `Run the bundled ${entry} script with explicit string arguments.` }
}

export async function previewGitHubSkill(url: string): Promise<SkillImportPreview> {
  for (const [id, record] of previews) if (Date.now() - record.createdAt > previewLifetimeMs) previews.delete(id)
  const parsed = parseGitHubSkillUrl(url)
  const source = await resolveSource(parsed)
  const files = await downloadSource(source)
  const skillFile = files.get('SKILL.md')
  if (!skillFile) throw new Error('SKILL.md is required at the selected skill root')
  const instructions = skillFile.toString('utf8').trim()
  if (!instructions) throw new Error('SKILL.md must not be empty')
  const previewId = randomUUID()
  const totalBytes = [...files.values()].reduce((sum, content) => sum + content.byteLength, 0)
  const preview: SkillImportPreview = {
    previewId,
    skillId: stableSkillId(source.owner, source.repo, source.path),
    name: titleFromInstructions(instructions, source),
    description: descriptionFromInstructions(instructions),
    sourceUrl: githubSkillTrackingUrl(parsed),
    sourceCommitSha: source.commitSha,
    sourcePath: source.path,
    fileCount: files.size,
    totalBytes,
    candidates: [...files.keys()].map(candidateFromPath).filter((value): value is SkillImportCandidate => value !== null),
  }
  previews.set(previewId, { createdAt: Date.now(), preview, source, files, instructions })
  return preview
}

function safePackageFolder(skillId: string): string {
  return createHash('sha256').update(skillId).digest('hex').slice(0, 32)
}
function packageDigest(files: Map<string, Buffer>): string {
  const hash = createHash('sha256')
  for (const path of [...files.keys()].sort()) {
    hash.update(path); hash.update('\0'); hash.update(files.get(path)!); hash.update('\0')
  }
  return hash.digest('hex')
}
function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeSkillTool(value: unknown, seenIds: Set<string>, seenEntries: Set<string>): SkillTool | null {
  const record = objectRecord(value)
  if (!record
    || !nonEmptyString(record.id)
    || !nonEmptyString(record.name)
    || typeof record.description !== 'string'
    || (record.runtime !== 'node' && record.runtime !== 'python')
    || !nonEmptyString(record.entry)
    || !Number.isInteger(record.timeoutMs)
    || (record.timeoutMs as number) < 1_000
    || (record.timeoutMs as number) > 15 * 60_000) return null

  let entry: string
  try { entry = cleanRelativePath(record.entry) } catch { return null }
  if (!entry.startsWith('scripts/') || entry.slice('scripts/'.length).includes('/')) return null
  const extension = extname(entry).toLowerCase()
  const expectedRuntime: SkillToolRuntime | null = ['.js', '.mjs', '.cjs'].includes(extension)
    ? 'node'
    : extension === '.py' ? 'python' : null
  if (!expectedRuntime || expectedRuntime !== record.runtime) return null

  const id = record.id.trim()
  if (seenIds.has(id) || seenEntries.has(entry)) return null
  seenIds.add(id)
  seenEntries.add(entry)
  return {
    id,
    name: record.name.trim(),
    description: record.description,
    runtime: record.runtime,
    entry,
    timeoutMs: record.timeoutMs as number,
  }
}

function normalizeInstalledSkill(value: unknown): InstalledSkill | null {
  const record = objectRecord(value)
  if (!record
    || !nonEmptyString(record.id)
    || !nonEmptyString(record.name)
    || typeof record.description !== 'string'
    || !nonEmptyString(record.sourceUrl)
    || !nonEmptyString(record.sourceOwner)
    || !nonEmptyString(record.sourceRepo)
    || typeof record.sourcePath !== 'string'
    || typeof record.sourceCommitSha !== 'string'
    || !/^[a-f0-9]{40}$/i.test(record.sourceCommitSha)
    || typeof record.packageSha256 !== 'string'
    || !/^[a-f0-9]{64}$/i.test(record.packageSha256)
    || !nonEmptyString(record.installedAt)
    || !Number.isFinite(Date.parse(record.installedAt))
    || !nonEmptyString(record.instructions)
    || !Array.isArray(record.tools)) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(record.sourceOwner) || !/^[A-Za-z0-9_.-]+$/.test(record.sourceRepo)) return null

  let sourcePath: string
  try { sourcePath = cleanRelativePath(record.sourcePath) } catch { return null }
  const id = record.id.trim()
  if (id !== stableSkillId(record.sourceOwner, record.sourceRepo, sourcePath)) return null

  const seenToolIds = new Set<string>()
  const seenToolEntries = new Set<string>()
  const tools = record.tools
    .map((tool) => normalizeSkillTool(tool, seenToolIds, seenToolEntries))
    .filter((tool): tool is SkillTool => tool !== null)
  return {
    id,
    name: record.name.trim(),
    description: record.description,
    sourceUrl: record.sourceUrl.trim(),
    sourceOwner: record.sourceOwner,
    sourceRepo: record.sourceRepo,
    sourcePath,
    sourceCommitSha: record.sourceCommitSha.toLowerCase(),
    packageSha256: record.packageSha256.toLowerCase(),
    installedAt: record.installedAt,
    instructions: record.instructions,
    tools,
  }
}

/** Validate persisted entries independently so one corrupt skill cannot break all installed skills. */
export function normalizeInstalledSkills(value: unknown): InstalledSkill[] {
  if (!Array.isArray(value)) return []
  const seenIds = new Set<string>()
  const result: InstalledSkill[] = []
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const skill = normalizeInstalledSkill(value[index])
    if (!skill || seenIds.has(skill.id)) continue
    seenIds.add(skill.id)
    result.push(skill)
  }
  return result.reverse()
}

async function readRegistry(): Promise<InstalledSkill[]> {
  try {
    const value = JSON.parse(await readFile(registryPath(), 'utf8')) as Partial<RegistryFile>
    return normalizeInstalledSkills(value.skills)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('Unable to read the skill registry')
  }
}
async function writeRegistry(skills: InstalledSkill[]): Promise<void> {
  await mkdir(skillsRoot(), { recursive: true })
  const target = registryPath()
  const temporary = `${target}.${randomUUID()}.tmp`
  const backup = `${target}.${randomUUID()}.backup`
  let backupCreated = false
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, skills } satisfies RegistryFile, null, 2), 'utf8')
    let hadTarget = false
    try { hadTarget = (await stat(target)).isFile() } catch {}
    if (hadTarget) {
      await rename(target, backup)
      backupCreated = true
    }
    try {
      await rename(temporary, target)
    } catch (error) {
      if (backupCreated) {
        await rename(backup, target).then(() => { backupCreated = false }).catch(() => undefined)
      }
      throw error
    }
    if (backupCreated) {
      await rm(backup, { force: true }).then(() => { backupCreated = false }).catch(() => undefined)
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function listInstalledSkills(): Promise<InstalledSkill[]> {
  return readRegistry()
}

function validateCandidateIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > maximumPackageFiles) throw new Error('Selected skill tools are invalid')
  if (!value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= maximumResourceIdLength)) {
    throw new Error('Selected skill tools are invalid')
  }
  return [...new Set(value)]
}

export function installSkillPreview(previewId: string, selectedCandidateIds: string[]): Promise<InstalledSkill> {
  return serializeSkillMutation(() => installSkillPreviewSerialized(previewId, selectedCandidateIds))
}

async function installSkillPreviewSerialized(previewId: unknown, selectedCandidateIds: unknown): Promise<InstalledSkill> {
  if (typeof previewId !== 'string' || previewId.length > 128) throw new Error('The import preview is invalid')
  const selectedIds = validateCandidateIds(selectedCandidateIds)
  const record = previews.get(previewId)
  if (!record || Date.now() - record.createdAt > previewLifetimeMs) throw new Error('The import preview expired; preview the GitHub link again')
  const candidateIds = new Set(record.preview.candidates.map((candidate) => candidate.id))
  if (selectedIds.some((id) => !candidateIds.has(id))) throw new Error('Selected skill tools are not part of this preview')
  const selected = new Set(selectedIds)
  const tools: SkillTool[] = record.preview.candidates.filter((candidate) => selected.has(candidate.id)).map((candidate) => ({
    id: createHash('sha256').update(`${record.preview.skillId}:${candidate.entry}`).digest('hex').slice(0, 16),
    name: candidate.name,
    description: candidate.description,
    runtime: candidate.runtime,
    entry: candidate.entry,
    timeoutMs: 60_000,
  }))
  const skill: InstalledSkill = {
    id: record.preview.skillId,
    name: record.preview.name,
    description: record.preview.description,
    sourceUrl: record.preview.sourceUrl,
    sourceOwner: record.source.owner,
    sourceRepo: record.source.repo,
    sourcePath: record.source.path,
    sourceCommitSha: record.source.commitSha,
    packageSha256: packageDigest(record.files),
    installedAt: new Date().toISOString(),
    instructions: record.instructions,
    tools,
  }
  const root = packagesRoot()
  const folder = safePackageFolder(skill.id)
  const staging = join(root, `.staging-${folder}-${randomUUID()}`)
  const target = join(root, folder)
  const backup = join(root, `.backup-${folder}-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  let backupCreated = false
  let targetInstalled = false
  try {
    for (const [relativePath, content] of record.files) {
      const destination = resolve(staging, relativePath.split('/').join(sep))
      if (destination !== staging && !destination.startsWith(`${staging}${sep}`)) throw new Error('Skill file escapes the package root')
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, content)
    }
    await writeFile(join(staging, 'skill.json'), JSON.stringify(skill, null, 2), 'utf8')
    let hadTarget = false
    try { hadTarget = (await stat(target)).isDirectory() } catch {}
    if (hadTarget) {
      await rename(target, backup)
      backupCreated = true
    }
    try {
      await rename(staging, target)
      targetInstalled = true
      const registry = await readRegistry()
      await writeRegistry([...registry.filter((entry) => entry.id !== skill.id), skill])
    } catch (error) {
      if (targetInstalled) {
        await rm(target, { recursive: true, force: true }).then(() => { targetInstalled = false }).catch(() => undefined)
      }
      if (backupCreated && !targetInstalled) {
        await rename(backup, target).then(() => { backupCreated = false }).catch(() => undefined)
      }
      throw error
    }
    if (backupCreated) {
      await rm(backup, { recursive: true, force: true }).then(() => { backupCreated = false }).catch(() => undefined)
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    previews.delete(previewId)
  }
  return skill
}

export function removeInstalledSkill(skillId: string): Promise<void> {
  return serializeSkillMutation(() => removeInstalledSkillSerialized(skillId))
}

async function removeInstalledSkillSerialized(skillId: unknown): Promise<void> {
  if (typeof skillId !== 'string' || skillId.trim() === '' || skillId.length > maximumResourceIdLength) {
    throw new Error('Skill id is invalid')
  }
  const registry = await readRegistry()
  const next = registry.filter((skill) => skill.id !== skillId)
  if (next.length === registry.length) return
  await writeRegistry(next)
  // The registry is the source of truth. A locked package may remain as an orphan,
  // but must not make a completed logical removal look like a failure.
  await rm(join(packagesRoot(), safePackageFolder(skillId)), { recursive: true, force: true }).catch(() => undefined)
}

export async function getInstalledSkillsByIds(ids: string[]): Promise<InstalledSkill[]> {
  const wanted = new Set(ids)
  return (await readRegistry()).filter((skill) => wanted.has(skill.id))
}

function skillToolName(skill: InstalledSkill, tool: SkillTool): string {
  const skillHash = createHash('sha256').update(skill.id).digest('hex').slice(0, 10)
  const toolHash = createHash('sha256').update(`${tool.id}\0${tool.entry}`).digest('hex').slice(0, 8)
  const name = tool.name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 35) || 'run'
  return `skill_${skillHash}_${name}_${toolHash}`
}

export function createSkillTools(skills: InstalledSkill[], project: Project): object[] {
  const folderIds = project.folders.map((folder) => folder.id)
  return skills.flatMap((skill) => skill.tools.map((tool) => ({
    type: 'function',
    function: {
      name: skillToolName(skill, tool),
      description: `[User-enabled skill: ${skill.name}] ${tool.description}`,
      parameters: {
        type: 'object',
        properties: {
          folder_id: { type: 'string', enum: folderIds, description: 'Project folder used as the script working directory.' },
          args: { type: 'array', items: { type: 'string', maxLength: 2000 }, maxItems: 50, description: 'Explicit string arguments passed to the script.' },
        },
        required: ['folder_id'],
        additionalProperties: false,
      },
    },
  })))
}

export function skillInstructions(skills: InstalledSkill[]): string {
  if (skills.length === 0) return ''
  return [
    'The user manually enabled the following skills. Follow their instructions. Do not search for, install, activate, deactivate, or claim access to any other skill.',
    ...skills.map((skill) => `\n<skill id="${skill.id}" name="${skill.name}">\n${skill.instructions}\n</skill>`),
  ].join('\n')
}

function minimalEnvironment(runtime: SkillToolRuntime): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR']
  const env: NodeJS.ProcessEnv = {}
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key]
  if (runtime === 'node') env.ELECTRON_RUN_AS_NODE = '1'
  env.CODEY_SKILL_NETWORK = 'not_granted'
  return env
}

export async function runSkillTool(
  skills: InstalledSkill[],
  project: Project,
  toolCall: { function: { name: string; arguments: string } },
  signal?: AbortSignal,
): Promise<string | undefined> {
  let selected: { skill: InstalledSkill; tool: SkillTool } | undefined
  for (const skill of skills) {
    const tool = skill.tools.find((candidate) => skillToolName(skill, candidate) === toolCall.function.name)
    if (tool) { selected = { skill, tool }; break }
  }
  if (!selected) return undefined
  let input: { folder_id?: unknown; args?: unknown }
  try { input = JSON.parse(toolCall.function.arguments || '{}') } catch { throw new Error('Skill tool arguments are invalid JSON') }
  if (typeof input.folder_id !== 'string') throw new Error('folder_id is required')
  const folder = project.folders.find((entry) => entry.id === input.folder_id)
  if (!folder) throw new Error('Project folder not found')
  const args = Array.isArray(input.args) ? input.args : []
  if (args.length > 50 || !args.every((value) => typeof value === 'string' && value.length <= 2000)) throw new Error('Skill tool args are invalid')
  const packageRoot = resolve(packagesRoot(), safePackageFolder(selected.skill.id))
  const scriptPath = resolve(packageRoot, selected.tool.entry.split('/').join(sep))
  const relativeScriptPath = relative(packageRoot, scriptPath)
  if (!relativeScriptPath || relativeScriptPath === '..' || relativeScriptPath.startsWith(`..${sep}`) || isAbsolute(relativeScriptPath)) {
    throw new Error('Skill tool entry escapes its package')
  }
  const command = selected.tool.runtime === 'node' ? process.execPath : (process.platform === 'win32' ? 'python' : 'python3')
  const result = await runSandboxProcess(command, [scriptPath, ...args], folder.path, selected.tool.timeoutMs, minimalEnvironment(selected.tool.runtime), undefined, signal)
  return JSON.stringify({
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    duration_ms: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    isolation: 'limited-process-isolation',
  })
}
