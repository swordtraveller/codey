import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { findCodeReadReferences, formatCodeReadReference, parseCodeReadReference, type CodeReadReference, type CodeReadViewerData } from '../shared/code-reading'
import type { Project } from '../shared/types'
import { safeResolveExistingPath } from './sandbox'
import { log } from './logger'

const maxSnapshotBytes = 1_000_000
const unavailableNames = new Set(['.git', '__pycache__', 'agent_venv', '.agent_tmp', '.venv', 'venv', 'node_modules'])

type SnapshotRecord = {
  messageId: string
  sourceLink: string
  snapshotId?: string
  error?: string
}
type SnapshotIndex = { version: 1; records: SnapshotRecord[] }
type StoredSnapshot = {
  version: 1
  id: string
  projectId: string
  conversationId: string
  messageId: string
  sourceLink: string
  reference: CodeReadReference
  capturedAt: string
  language: string
  content: string
}

function encoded(value: string): string { return Buffer.from(value, 'utf8').toString('base64url') || 'empty' }
function storageDirectory(projectId: string, conversationId: string): string {
  return join(app.getPath('userData'), 'workspace-data', 'projects', encoded(projectId), 'conversations', encoded(conversationId), 'code-read-snapshots')
}
function indexPath(projectId: string, conversationId: string): string { return join(storageDirectory(projectId, conversationId), 'index.json') }
function snapshotPath(projectId: string, conversationId: string, snapshotId: string): string {
  return join(storageDirectory(projectId, conversationId), `${snapshotId}.json`)
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), 'utf8')
  await rename(temporary, path)
}
async function readIndex(projectId: string, conversationId: string): Promise<SnapshotIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath(projectId, conversationId), 'utf8')) as SnapshotIndex
    if (parsed?.version === 1 && Array.isArray(parsed.records)) return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('code.read.index.invalid', { projectId, conversationId, error })
  }
  return { version: 1, records: [] }
}
function assertReadableCodePath(path: string): void {
  const segments = path.split('/')
  if (segments.some((segment) => unavailableNames.has(segment.toLowerCase()))) throw new Error('Path is not available to the coding agent')
}
function languageFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  const languages: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', json: 'json', css: 'css', html: 'html', htm: 'html',
    py: 'python', sh: 'shell', bash: 'shell', ps1: 'powershell', md: 'markdown', yml: 'yaml', yaml: 'yaml',
    java: 'java', go: 'go', rs: 'rust', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c', xml: 'xml', sql: 'sql',
  }
  return languages[extension] ?? 'text'
}
async function captureReference(project: Project, projectId: string, conversationId: string, messageId: string, sourceLink: string, reference: CodeReadReference): Promise<SnapshotRecord> {
  try {
    const folder = project.folders.find((item) => item.id === reference.rootId)
    if (!folder) throw new Error('The referenced project folder no longer exists')
    assertReadableCodePath(reference.path)
    const target = await safeResolveExistingPath(folder.path, reference.path)
    const details = await stat(target)
    if (!details.isFile()) throw new Error('The referenced path is not a file')
    if (details.size > maxSnapshotBytes) throw new Error(`The referenced file exceeds the ${maxSnapshotBytes.toLocaleString()} byte snapshot limit`)
    const bytes = await readFile(target)
    if (bytes.includes(0)) throw new Error('The referenced file appears to be binary')
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('The referenced file is not valid UTF-8 text') }
    const id = randomUUID()
    const snapshot: StoredSnapshot = {
      version: 1, id, projectId, conversationId, messageId, sourceLink, reference,
      capturedAt: new Date().toISOString(), language: languageFor(reference.path), content,
    }
    await atomicJson(snapshotPath(projectId, conversationId, id), snapshot)
    return { messageId, sourceLink, snapshotId: id }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to capture the referenced file'
    log.warn('code.read.capture.failed', { projectId, conversationId, messageId, sourceLink, error })
    return { messageId, sourceLink, error: message }
  }
}

/** Captures all completed-response code references before they can be opened in the renderer. */
export async function captureCodeReadSnapshots(project: Project, conversationId: string, messageId: string, content: string): Promise<void> {
  const references = findCodeReadReferences(content)
  if (references.length === 0) return
  const records = await Promise.all(references.map(({ sourceLink, reference }) => captureReference(project, project.id, conversationId, messageId, sourceLink, reference)))
  try {
    const index = await readIndex(project.id, conversationId)
    index.records.push(...records.map((record) => ({ ...record, sourceLink: formatCodeReadReference(parseCodeReadReference(record.sourceLink)!) })))
    await atomicJson(indexPath(project.id, conversationId), index)
  } catch (error) {
    // A code citation must never make an otherwise valid agent response fail to save.
    log.warn('code.read.index.persist.failed', { projectId: project.id, conversationId, messageId, error })
  }
}

export async function getCodeReadSnapshot(project: Project, conversationId: string, messageId: string, sourceLink: string): Promise<CodeReadViewerData> {
  const canonical = parseCodeReadReference(sourceLink)
  if (!canonical) throw new Error('Invalid code-reading link')
  const expectedLink = formatCodeReadReference(canonical)
  const conversation = project.conversations.find((item) => item.id === conversationId)
  const message = conversation?.messages.find((item) => item.id === messageId && item.role === 'assistant')
  if (!message || !findCodeReadReferences(message.content).some((item) => item.sourceLink === expectedLink)) throw new Error('The code-reading link does not belong to this assistant response')
  const index = await readIndex(project.id, conversationId)
  const record = [...index.records].reverse().find((item) => item.messageId === messageId && item.sourceLink === expectedLink)
  if (!record?.snapshotId) throw new Error(record?.error ? `Snapshot unavailable: ${record.error}` : 'Snapshot unavailable for this link')
  let snapshot: StoredSnapshot
  try { snapshot = JSON.parse(await readFile(snapshotPath(project.id, conversationId, record.snapshotId), 'utf8')) as StoredSnapshot } catch { throw new Error('The saved code snapshot is no longer available') }
  if (snapshot.version !== 1 || snapshot.projectId !== project.id || snapshot.conversationId !== conversationId || snapshot.messageId !== messageId || snapshot.sourceLink !== expectedLink) throw new Error('The saved code snapshot is invalid')
  return { sourceLink: snapshot.sourceLink, reference: snapshot.reference, capturedAt: snapshot.capturedAt, language: snapshot.language, content: snapshot.content }
}
