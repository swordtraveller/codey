import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export type RecordLocation = { offset: number; length: number; hash: string }
export type MessageLocation = RecordLocation & { id: string; role: 'user' | 'assistant' }
export type MessageStoreIndex = { messages: MessageLocation[]; context: RecordLocation }

/** Append before atomically publishing the index. Interrupted writes leave only unreferenced bytes. */
export async function appendMessageRecords(
  path: string,
  messages: Array<{ id: string; role: 'user' | 'assistant' }>,
  context: unknown[],
  previous?: MessageStoreIndex,
): Promise<MessageStoreIndex> {
  await mkdir(dirname(path), { recursive: true })
  const file = await open(path, 'a+')
  try {
    let offset = (await file.stat()).size
    const append = async (value: unknown, old?: RecordLocation): Promise<RecordLocation> => {
      const bytes = Buffer.from(JSON.stringify(value) + '\n')
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (old?.hash === hash) return old
      const location = { offset, length: bytes.length, hash }
      await file.writeFile(bytes)
      offset += bytes.length
      return location
    }
    const oldMessages = new Map(previous?.messages.map((message) => [message.id, message]))
    const entries: MessageLocation[] = []
    for (const message of messages) entries.push({ ...await append(message, oldMessages.get(message.id)), id: message.id, role: message.role })
    // Model context is replaced independently; do not append a growing full snapshot
    // to the history journal after every turn.
    const contextBytes = Buffer.from(JSON.stringify(context) + '\n')
    const contextHash = createHash('sha256').update(contextBytes).digest('hex')
    const contextLocation = { offset: 0, length: contextBytes.length, hash: contextHash }
    if (previous?.context.hash !== contextHash) {
      const contextPath = contextRecordPath(path, contextLocation)
      const temporaryPath = contextPath + '.' + randomUUID() + '.tmp'
      const contextFile = await open(temporaryPath, 'wx')
      try { await contextFile.writeFile(contextBytes); await contextFile.sync() } finally { await contextFile.close() }
      try { await rename(temporaryPath, contextPath) } catch (error) { await unlink(temporaryPath).catch(() => undefined); throw error }
    }
    await file.sync()
    return { messages: entries, context: contextLocation }
  } finally {
    await file.close()
  }
}

/** Only the requested byte ranges are read and parsed, including UTF-8 multibyte content. */
export async function readMessageRecords<T>(path: string, locations: readonly RecordLocation[]): Promise<T[]> {
  if (!locations.length) return []
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const values: T[] = []
    for (const location of locations) {
      if (!isLocation(location) || location.offset + location.length > size) throw new Error('Incomplete conversation history record')
      const bytes = Buffer.alloc(location.length)
      let read = 0
      while (read < bytes.length) {
        const result = await file.read(bytes, read, bytes.length - read, location.offset + read)
        if (!result.bytesRead) throw new Error('Incomplete conversation history record')
        read += result.bytesRead
      }
      if (createHash('sha256').update(bytes).digest('hex') !== location.hash) throw new Error('Damaged conversation history record')
      values.push(JSON.parse(bytes.toString('utf8')) as T)
    }
    return values
  } finally {
    await file.close()
  }
}

export function contextRecordPath(recordsPath: string, location: RecordLocation): string {
  return recordsPath + '.context-' + location.hash
}

function isLocation(value: unknown): value is RecordLocation {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as RecordLocation
  return Number.isSafeInteger(entry.offset) && entry.offset >= 0 && Number.isSafeInteger(entry.length) && entry.length > 0
    && Number.isSafeInteger(entry.offset + entry.length) && typeof entry.hash === 'string' && /^[a-f0-9]{64}$/.test(entry.hash)
}

export function isMessageStoreIndex(value: unknown): value is MessageStoreIndex {
  if (typeof value !== 'object' || value === null) return false
  const index = value as MessageStoreIndex
  if (!Array.isArray(index.messages) || !isLocation(index.context)) return false
  const ids = new Set<string>()
  return index.messages.every((entry) => {
    if (!isLocation(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || !['user', 'assistant'].includes(entry.role)) return false
    ids.add(entry.id)
    return true
  })
}
