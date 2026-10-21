import { constants } from 'node:fs'
import { copyFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { contextRecordPath, isMessageStoreIndex, readMessageRecords } from './workspace-message-store'

type RecoveryOptions = {
  dryRun?: boolean
  onSkip?: (file: string, error: unknown) => void
}

/** Validate every referenced record before reconnecting an isolated v3 header. */
async function validateHeader(path: string, recordsPath: string, encodedId: string): Promise<string> {
  const header = JSON.parse(await readFile(path, 'utf8'))
  if (!header || header.storageVersion !== 3 || typeof header.id !== 'string'
    || Buffer.from(header.id).toString('base64url') !== encodedId || typeof header.title !== 'string'
    || !isMessageStoreIndex(header.messageIndex) || !header.history
    || header.history.messageCount !== header.messageIndex.messages.length) {
    throw new Error('Invalid recovery header')
  }
  const index = header.messageIndex
  const messages = await readMessageRecords<{ id: string; role: string }>(recordsPath, index.messages)
  if (messages.some((message, i) => !message || message.id !== index.messages[i].id || message.role !== index.messages[i].role)) {
    throw new Error('Recovery message index mismatch')
  }
  const [context] = await readMessageRecords<unknown>(contextRecordPath(recordsPath, index.context), [index.context])
  if (!Array.isArray(context)) throw new Error('Invalid recovery model context')
  return header.id
}

/** Keep the quarantined source and never replace an existing live conversation. */
export async function recoverQuarantinedConversations(
  directory: string, listedIds: readonly string[], options: RecoveryOptions = {},
): Promise<string[]> {
  let names: string[]
  try { names = await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const candidates = names.flatMap((name) => {
    const match = /^([A-Za-z0-9_-]+)\.json\.corrupt-(\d+)-[a-f0-9-]+$/.exec(name)
    return match ? [{ name, encodedId: match[1], timestamp: Number(match[2]) }] : []
  }).sort((a, b) => b.timestamp - a.timestamp)
  const known = new Set(listedIds.map((id) => Buffer.from(id).toString('base64url')))
  const existing = new Set(names)
  const recovered: string[] = []
  for (const candidate of candidates) {
    if (known.has(candidate.encodedId)) continue
    const liveName = candidate.encodedId + '.json'
    const target = join(directory, liveName)
    const source = join(directory, candidate.name)
    let id: string
    try {
      // Also handles interruption after publishing a header but before updating metadata.
      id = await validateHeader(existing.has(liveName) ? target : source, target + '.records', candidate.encodedId)
    } catch (error) {
      options.onSkip?.(candidate.name, error)
      continue
    }
    if (!existing.has(liveName) && !options.dryRun) {
      // A racing writer must not be overwritten; retry loading on the next startup.
      await copyFile(source, target, constants.COPYFILE_EXCL)
    }
    recovered.push(id)
    known.add(candidate.encodedId)
  }
  return recovered
}
