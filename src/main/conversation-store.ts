import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AgentContextMessage,
  ColdIndexItem,
  ColdStorageFile,
  ColdStorageOverview,
  ContextManagementConfig,
  ProtectionLevel,
} from '../shared/types'
import { countContextTokens } from './context'

type StoredIndex = ColdIndexItem[]
type MessageOverride = Pick<AgentContextMessage, 'manualContextLayer' | 'manualProtected' | 'protection'>
type StoredOverrides = Record<string, MessageOverride>
type IndexCacheEntry = { signature: string; items: StoredIndex }

const INDEX_CACHE_LIMIT = 20
const indexCache = new Map<string, IndexCacheEntry>()

function storageRoot(): string {
  return join(app.getPath('userData'), 'context-debug')
}

function key(projectId: string, conversationId: string): string {
  return `${projectId}-${conversationId}`.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function paths(projectId: string, conversationId: string): {
  folder: string
  messages: string
  index: string
  overrides: string
} {
  const folder = join(storageRoot(), key(projectId, conversationId))
  return {
    folder,
    messages: join(folder, 'messages.jsonl'),
    index: join(folder, 'index.json'),
    overrides: join(folder, 'overrides.json'),
  }
}

async function fileSignature(path: string): Promise<string> {
  try {
    const info = await stat(path)
    return `${info.size}:${info.mtimeMs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function cacheIndex(cacheKey: string, entry: IndexCacheEntry): void {
  indexCache.delete(cacheKey)
  indexCache.set(cacheKey, entry)
  if (indexCache.size > INDEX_CACHE_LIMIT) {
    const oldest = indexCache.keys().next().value
    if (oldest) indexCache.delete(oldest)
  }
}

function invalidateIndexCache(projectId: string, conversationId: string): void {
  indexCache.delete(paths(projectId, conversationId).index)
}

async function fileOverview(path: string): Promise<ColdStorageFile> {
  try {
    const info = await stat(path)
    return {
      path,
      exists: true,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, exists: false, sizeBytes: 0, modifiedAt: null }
    }
    throw error
  }
}

function inspectIndex(items: ColdIndexItem[]): { indexedBytes: number; pointersValid: boolean } {
  let indexedBytes = 0
  for (const item of items) {
    const match = item.logicalPointer.match(/#(\d+):(\d+)$/)
    if (!match || Number(match[1]) !== indexedBytes || Number(match[2]) <= 0) {
      return { indexedBytes, pointersValid: false }
    }
    indexedBytes += Number(match[2])
  }
  return { indexedBytes, pointersValid: true }
}

function preview(content: string | null): string {
  return (content ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
}

function searchTerms(content: string | null): string[] {
  const value = (content ?? '').toLowerCase()
  const words: string[] = value.match(/[a-z0-9_-]{2,}/g) ?? []
  for (const sequence of value.match(/\p{Script=Han}+/gu) ?? []) {
    if (sequence.length === 1) words.push(sequence)
    for (let index = 0; index < sequence.length - 1; index += 1) {
      words.push(sequence.slice(index, index + 2))
    }
  }
  return [...new Set(words)].slice(0, 40)
}

async function readOverrides(projectId: string, conversationId: string): Promise<StoredOverrides> {
  try {
    return JSON.parse(await readFile(paths(projectId, conversationId).overrides, 'utf8')) as StoredOverrides
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function writeOverrides(
  projectId: string,
  conversationId: string,
  overrides: StoredOverrides,
): Promise<void> {
  const target = paths(projectId, conversationId)
  await mkdir(target.folder, { recursive: true })
  await writeFile(target.overrides, JSON.stringify(overrides), 'utf8')
}

function applyOverride(message: AgentContextMessage, override?: MessageOverride): AgentContextMessage {
  return override ? { ...message, ...override } : message
}

function indexItem(message: AgentContextMessage, offset: number, length: number): ColdIndexItem {
  const id = message.id ?? randomUUID()
  const createdAt = message.createdAt ?? new Date(0).toISOString()
  return {
    id,
    role: message.role,
    tokenCount: countContextTokens(message),
    createdAt,
    preview: preview(message.content),
    logicalPointer: `messages.jsonl#${offset}:${length}`,
    protection: message.protection ?? (message.manualProtected ? 'full' : 'none'),
    terms: searchTerms(message.content),
    manualContextLayer: message.manualContextLayer,
  }
}

export async function writeConversationMessages(
  projectId: string,
  conversationId: string,
  messages: AgentContextMessage[],
): Promise<void> {
  const target = paths(projectId, conversationId)
  const overrides = await readOverrides(projectId, conversationId)
  await mkdir(target.folder, { recursive: true })
  const lines: string[] = []
  const index: StoredIndex = []
  let offset = 0
  for (const value of messages) {
    const normalized = applyOverride({
      ...value,
      id: value.id ?? randomUUID(),
      createdAt: value.createdAt ?? new Date(0).toISOString(),
    }, value.id ? overrides[value.id] : undefined)
    const line = `${JSON.stringify(normalized)}\n`
    const length = Buffer.byteLength(line, 'utf8')
    lines.push(line)
    index.push(indexItem(normalized, offset, length))
    offset += length
  }
  await writeFile(target.messages, lines.join(''), 'utf8')
  await writeFile(target.index, JSON.stringify(index), 'utf8')
  invalidateIndexCache(projectId, conversationId)
}

export async function ensureConversationMessages(
  projectId: string,
  conversationId: string,
  messages: AgentContextMessage[],
): Promise<void> {
  const index = await readConversationIndex(projectId, conversationId)
  if (index.length === 0 && messages.length > 0) {
    await writeConversationMessages(projectId, conversationId, messages)
  }
}

export async function appendConversationMessages(
  projectId: string,
  conversationId: string,
  messages: AgentContextMessage[],
): Promise<void> {
  const target = paths(projectId, conversationId)
  const index = await readConversationIndex(projectId, conversationId)
  const known = new Set(index.map((item) => item.id))
  const overrides = await readOverrides(projectId, conversationId)
  const additions = messages.filter((message) => !message.id || !known.has(message.id))
  if (additions.length === 0) return

  await mkdir(target.folder, { recursive: true })
  let offset = 0
  try {
    offset = (await stat(target.messages)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const lines: string[] = []
  for (const value of additions) {
    const id = value.id ?? randomUUID()
    const normalized = applyOverride({
      ...value,
      id,
      createdAt: value.createdAt ?? new Date().toISOString(),
    }, overrides[id])
    const line = `${JSON.stringify(normalized)}\n`
    const length = Buffer.byteLength(line, 'utf8')
    lines.push(line)
    index.push(indexItem(normalized, offset, length))
    offset += length
  }
  await appendFile(target.messages, lines.join(''), 'utf8')
  await writeFile(target.index, JSON.stringify(index), 'utf8')
  invalidateIndexCache(projectId, conversationId)
}

export async function readConversationIndex(
  projectId: string,
  conversationId: string,
): Promise<ColdIndexItem[]> {
  const target = paths(projectId, conversationId)
  const cacheKey = target.index
  const signature = await fileSignature(target.index)
  const cached = indexCache.get(cacheKey)
  if (cached?.signature === signature) {
    cacheIndex(cacheKey, cached)
    return cached.items
  }
  try {
    const items = JSON.parse(await readFile(target.index, 'utf8')) as StoredIndex
    cacheIndex(cacheKey, { signature, items })
    return items
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cacheIndex(cacheKey, { signature: 'missing', items: [] })
      return []
    }
    throw error
  }
}

export async function getConversationStorageRevision(
  projectId: string,
  conversationId: string,
): Promise<string> {
  const target = paths(projectId, conversationId)
  const signatures = await Promise.all([
    fileSignature(target.messages),
    fileSignature(target.index),
    fileSignature(target.overrides),
  ])
  return signatures.join('|')
}

export async function readConversationStorageOverview(
  projectId: string,
  conversationId: string,
  items?: ColdIndexItem[],
): Promise<ColdStorageOverview> {
  const target = paths(projectId, conversationId)
  const storedItems = items ?? await readConversationIndex(projectId, conversationId)
  const [messages, index, overrides] = await Promise.all([
    fileOverview(target.messages),
    fileOverview(target.index),
    fileOverview(target.overrides),
  ])
  const { indexedBytes, pointersValid } = inspectIndex(storedItems)
  const empty = storedItems.length === 0 && (!messages.exists || messages.sizeBytes === 0)
  const indexStatus = empty
    ? 'empty'
    : messages.exists && index.exists && pointersValid && indexedBytes === messages.sizeBytes
      ? 'consistent'
      : 'mismatch'
  const modifiedTimes = [messages.modifiedAt, index.modifiedAt, overrides.modifiedAt]
    .filter((value): value is string => Boolean(value))

  return {
    folderPath: target.folder,
    messages,
    index,
    overrides,
    recordCount: storedItems.length,
    indexedBytes,
    indexStatus,
    lastPersistedAt: modifiedTimes.sort().at(-1) ?? null,
  }
}

async function readMessageAt(
  handle: Awaited<ReturnType<typeof open>>,
  item: ColdIndexItem,
  override?: MessageOverride,
): Promise<AgentContextMessage> {
  const match = item.logicalPointer.match(/#(\d+):(\d+)$/)
  if (!match) throw new Error('Invalid Cold message pointer')
  const buffer = Buffer.alloc(Number(match[2]))
  await handle.read(buffer, 0, buffer.length, Number(match[1]))
  return applyOverride(JSON.parse(buffer.toString('utf8')) as AgentContextMessage, override)
}
export async function readConversationMessage(
  projectId: string,
  conversationId: string,
  messageId: string,
): Promise<AgentContextMessage> {
  const items = await readConversationIndex(projectId, conversationId)
  const item = items.find((candidate) => candidate.id === messageId)
  if (!item) throw new Error('Cold message not found')
  const handle = await open(paths(projectId, conversationId).messages, 'r')
  try {
    return readMessageAt(handle, item, (await readOverrides(projectId, conversationId))[messageId])
  } finally {
    await handle.close()
  }
}

export async function readConversationMessages(
  projectId: string,
  conversationId: string,
): Promise<AgentContextMessage[]> {
  const items = await readConversationIndex(projectId, conversationId)
  if (items.length === 0) return []
  const overrides = await readOverrides(projectId, conversationId)
  const handle = await open(paths(projectId, conversationId).messages, 'r')
  try {
    const messages: AgentContextMessage[] = []
    for (const item of items) {
      messages.push(await readMessageAt(handle, item, overrides[item.id]))
    }
    return messages
  } finally {
    await handle.close()
  }
}

function splitRounds(items: ColdIndexItem[]): ColdIndexItem[][] {
  const rounds: ColdIndexItem[][] = []
  for (const item of items) {
    if (item.role === 'user' || rounds.length === 0) rounds.push([item])
    else rounds.at(-1)?.push(item)
  }
  return rounds
}

function roundTokens(round: ColdIndexItem[]): number {
  return round.reduce((sum, item) => sum + item.tokenCount, 0)
}

export async function readConversationWorkingSet(
  projectId: string,
  conversationId: string,
  config: ContextManagementConfig,
  query: string,
): Promise<AgentContextMessage[]> {
  const index = await readConversationIndex(projectId, conversationId)
  const rounds = splitRounds(index)
  const recentStart = Math.max(0, rounds.length - config.recentKeepRounds)
  const recent = rounds.slice(recentStart)
  const older = rounds.slice(0, recentStart)
  const protectedItems = older.flat().filter((item) => item.protection === 'full')
  const manualWarmItems = older.flat().filter(
    (item) => item.manualContextLayer === 'warm' && item.protection !== 'full',
  )
  const reservedIds = new Set([...protectedItems, ...manualWarmItems].map((item) => item.id))
  const available = older
    .map((round) => round.filter((item) => !reservedIds.has(item.id)))
    .filter((round) => round.length > 0)
  const manualWarmTokens = roundTokens(manualWarmItems)
  const recallBudget = Math.min(
    config.coldRecallTokenBudget,
    Math.max(0, config.warmTokenBudget - manualWarmTokens),
  )
  const automaticWarmBudget = Math.max(
    0,
    config.warmTokenBudget - manualWarmTokens - recallBudget,
  )
  const warm: ColdIndexItem[][] = []
  let warmTokens = 0
  for (let position = available.length - 1; position >= 0; position -= 1) {
    const round = available[position]
    const tokens = roundTokens(round)
    if (warmTokens + tokens > automaticWarmBudget) break
    warm.unshift(round)
    warmTokens += tokens
  }

  const warmIds = new Set(warm.flat().map((item) => item.id))
  const terms = searchTerms(query)
  const recalled: ColdIndexItem[][] = []
  let recalledTokens = 0
  const ranked = available
    .filter((round) => round.every((item) => !warmIds.has(item.id)))
    .map((round) => ({
      round,
      score: terms.reduce(
        (sum, term) => sum + (round.some((item) => item.terms.some((value) => value.includes(term))) ? 1 : 0),
        0,
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
  for (const candidate of ranked) {
    const tokens = roundTokens(candidate.round)
    if (recalledTokens + tokens > recallBudget) continue
    recalled.push(candidate.round)
    recalledTokens += tokens
  }

  const warmSelected = new Set([
    ...manualWarmItems,
    ...warm.flat(),
    ...recalled.flat(),
  ].map((item) => item.id))
  const recalledIds = new Set(recalled.flat().map((item) => item.id))
  const order = new Map(index.map((item, position) => [item.id, position]))
  const selected = [...new Map([
    ...protectedItems,
    ...manualWarmItems,
    ...warm.flat(),
    ...recalled.flat(),
    ...recent.flat(),
  ].map((item) => [item.id, item])).values()]
    .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
  if (selected.length === 0) return []
  const overrides = await readOverrides(projectId, conversationId)
  const handle = await open(paths(projectId, conversationId).messages, 'r')
  try {
    const messages: AgentContextMessage[] = []
    for (const item of selected) {
      const message = await readMessageAt(handle, item, overrides[item.id])
      messages.push(warmSelected.has(item.id)
        ? {
            ...message,
            manualContextLayer: item.manualContextLayer,
            contextSource: recalledIds.has(item.id) ? 'cold-recall' : 'warm',
          }
        : message)
    }
    return messages
  } finally {
    await handle.close()
  }
}

export async function updateConversationProtection(
  projectId: string,
  conversationId: string,
  messageId: string,
  protection: ProtectionLevel,
): Promise<void> {
  const items = await readConversationIndex(projectId, conversationId)
  const item = items.find((candidate) => candidate.id === messageId)
  if (!item) throw new Error('Message not found')
  const overrides = await readOverrides(projectId, conversationId)
  overrides[messageId] = {
    ...overrides[messageId],
    protection,
    manualProtected: protection !== 'none',
  }
  item.protection = protection
  await writeOverrides(projectId, conversationId, overrides)
  await writeFile(paths(projectId, conversationId).index, JSON.stringify(items), 'utf8')
  invalidateIndexCache(projectId, conversationId)
}

export async function updateConversationLayer(
  projectId: string,
  conversationId: string,
  messageIds: Set<string>,
  layer: 'warm',
): Promise<void> {
  const items = await readConversationIndex(projectId, conversationId)
  const found = items.filter((item) => messageIds.has(item.id))
  if (found.length !== messageIds.size) throw new Error('Message not found')
  const overrides = await readOverrides(projectId, conversationId)
  for (const item of found) {
    overrides[item.id] = { ...overrides[item.id], manualContextLayer: layer }
    item.manualContextLayer = layer
  }
  await writeOverrides(projectId, conversationId, overrides)
  await writeFile(paths(projectId, conversationId).index, JSON.stringify(items), 'utf8')
  invalidateIndexCache(projectId, conversationId)
}
