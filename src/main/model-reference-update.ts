import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

export type ConfigurationFile = { path: string; content: string }
type Entry = ConfigurationFile & { before: string | null }
type Journal = { version: 1; phase: 'apply' | 'rollback'; entries: Entry[] }
const journalPath = () => join(app.getPath('userData'), 'model-reference-update.json')

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

function checkPath(path: string): void {
  const root = resolve(app.getPath('userData'))
  const rel = relative(root, resolve(path)).replaceAll('\\', '/')
  if (isAbsolute(rel) || rel.startsWith('../') || (rel !== 'model-config.json' && !/^workspace-data\/projects\/[A-Za-z0-9_-]+\/(project\.json|conversations\/[A-Za-z0-9_-]+\.json)$/.test(rel))) {
    throw new Error('Invalid model-reference update path')
  }
}

async function apply(journal: Journal): Promise<void> {
  for (const entry of journal.entries) {
    checkPath(entry.path)
    const content = journal.phase === 'apply' ? entry.content : entry.before
    if (content === null) await unlink(entry.path).catch(error => { if (error.code !== 'ENOENT') throw error })
    else await atomicWrite(entry.path, content)
  }
}

/** Recover before exposing config or workspace to the renderer. No model credentials are added to logs. */
export async function recoverModelReferenceUpdate(): Promise<void> {
  const text = await readOptional(journalPath())
  if (!text) return
  const journal = JSON.parse(text) as Journal
  if (journal.version !== 1 || !['apply', 'rollback'].includes(journal.phase) || !Array.isArray(journal.entries)) throw new Error('Invalid model-reference update journal')
  for (const entry of journal.entries) {
    if (typeof entry.path !== 'string' || typeof entry.content !== 'string' || (entry.before !== null && typeof entry.before !== 'string')) throw new Error('Invalid model-reference update entry')
    checkPath(entry.path)
  }
  await apply(journal)
  await unlink(journalPath())
}

/** Durable intent + atomic per-file replacement; errors roll back, interruptions recover on startup. */
export async function writeModelReferenceUpdate(files: ConfigurationFile[]): Promise<void> {
  await recoverModelReferenceUpdate()
  const entries: Entry[] = []
  for (const file of files) {
    checkPath(file.path)
    const before = await readOptional(file.path)
    if (before !== file.content) entries.push({ ...file, before })
  }
  if (entries.length === 0) return
  const journal: Journal = { version: 1, phase: 'apply', entries }
  await atomicWrite(journalPath(), JSON.stringify(journal))
  try {
    await apply(journal)
    await unlink(journalPath())
  } catch (error) {
    journal.phase = 'rollback'
    // If rollback is interrupted, startup recovery retries it instead of accepting a partial save.
    await atomicWrite(journalPath(), JSON.stringify(journal))
    await apply(journal)
    await unlink(journalPath())
    throw error
  }
}
