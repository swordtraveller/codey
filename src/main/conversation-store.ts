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
  ContextSummaryArtifact,
} from '../shared/types'
import { countContextTokens, SUMMARY_LABEL } from './context'
import { hydrateImageAttachments, persistImageAttachments, type StoredImageReference } from './image-store'

type MessageOverride = Pick<AgentContextMessage, 'manualContextLayer' | 'pinnedToHot' | 'contextRegion'> & {
  manualProtected?: boolean
  protection?: 'none' | 'partial' | 'full'
}
type StoredOverrides = Record<string, MessageOverride>
type PersistedContextMessage = Omit<AgentContextMessage, 'images'> & { images?: AgentContextMessage['images'] | StoredImageReference[] }
type LegacyPin = { pinnedToHot?: boolean; protection?: 'none' | 'partial' | 'full'; manualProtected?: boolean }
type IndexCacheEntry = { signature: string; items: ColdIndexItem[] }

const INDEX_CACHE_LIMIT = 20
const indexCache = new Map<string, IndexCacheEntry>()

function storageRoot(): string {
  return join(app.getPath('userData'), 'context-debug')
}

function key(projectId: string, conversationId: string): string {
  return `${projectId}-${conversationId}`.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function paths(projectId: string, conversationId: string) {
  const folder = join(storageRoot(), key(projectId, conversationId))
  return {
    folder,
    messages: join(folder, 'messages.jsonl'),
    index: join(folder, 'index.json'),
    overrides: join(folder, 'overrides.json'),
    summaries: join(folder, 'summaries.jsonl'),
    summaryIndex: join(folder, 'summary-index.json'),
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

function invalidate(projectId: string, conversationId: string): void {
  const target = paths(projectId, conversationId)
  indexCache.delete(target.index)
  indexCache.delete(target.summaryIndex)
}

async function fileOverview(path: string): Promise<ColdStorageFile> {
  try {
    const info = await stat(path)
    return { path, exists: true, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, exists: false, sizeBytes: 0, modifiedAt: null }
    }
    throw error
  }
}

function preview(content: string | null): string {
  return (content ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
}

function searchTerms(content: string | null): string[] {
  const value = (content ?? '').toLowerCase()
  const words: string[] = value.match(/[a-z0-9_-]{2,}/g) ?? []
  for (const sequence of value.match(/\p{Script=Han}+/gu) ?? []) {
    if (sequence.length === 1) words.push(sequence)
    for (let index = 0; index < sequence.length - 1; index += 1) words.push(sequence.slice(index, index + 2))
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

async function writeOverrides(projectId: string, conversationId: string, overrides: StoredOverrides): Promise<void> {
  const target = paths(projectId, conversationId)
  await mkdir(target.folder, { recursive: true })
  await writeFile(target.overrides, JSON.stringify(overrides), 'utf8')
}

function migratePin(value: LegacyPin): boolean {
  return value.pinnedToHot === true
}

function applyOverride(message: AgentContextMessage, override?: MessageOverride): AgentContextMessage {
  const merged = override ? { ...message, ...override } : message
  return {
    ...merged,
    pinnedToHot: migratePin(merged),
    representation: merged.representation ?? 'original',
    truthRefs: merged.truthRefs?.length ? merged.truthRefs : merged.id ? [merged.id] : [],
  }
}

function captureOverride(message: AgentContextMessage, current?: MessageOverride): MessageOverride {
  const pinnedToHot = message.pinnedToHot === true
  return {
    ...current,
    pinnedToHot,
    manualContextLayer: pinnedToHot ? undefined : message.manualContextLayer ?? current?.manualContextLayer,
    contextRegion: message.contextRegion === 'long-term' || current?.contextRegion === 'long-term' ? 'long-term' : undefined,
    manualProtected: undefined,
    protection: undefined,
  }
}

function truthMessage(value: AgentContextMessage, id: string, createdAt: string): AgentContextMessage {
  const {
    pinnedToHot: _pinnedToHot,
    representation: _representation,
    truthRefs: _truthRefs,
    contextLayer: _contextLayer,
    contextRegion: _contextRegion,
    contextSource: _contextSource,
    recalledAtRoundId: _recalledAtRoundId,
    lastAccessedAt: _lastAccessedAt,
    manualContextLayer: _manualContextLayer,
    manualProtected: _manualProtected,
    protection: _protection,
    ...truth
  } = value
  return { ...truth, id, createdAt }
}

async function storedContextMessage(
  projectId: string,
  conversationId: string,
  message: AgentContextMessage,
): Promise<PersistedContextMessage> {
  return {
    ...message,
    images: await persistImageAttachments(projectId, conversationId, message.images),
  }
}

function truthIndexItem(message: AgentContextMessage, offset: number, length: number): ColdIndexItem {
  const id = message.id ?? randomUUID()
  return {
    id,
    kind: 'truth',
    role: message.role,
    tokenCount: countContextTokens(message),
    createdAt: message.createdAt ?? new Date(0).toISOString(),
    preview: preview(message.content),
    logicalPointer: `messages.jsonl#${offset}:${length}`,
    terms: searchTerms(message.content),
    truthRefs: [id],
    contextRegion: message.contextRegion,
    manualContextLayer: message.manualContextLayer,
    pinnedToHot: migratePin(message),
  }
}

function summaryIndexItem(summary: ContextSummaryArtifact, offset: number, length: number): ColdIndexItem {
  return {
    id: summary.id,
    kind: 'summary',
    role: summary.role,
    tokenCount: summary.compressedTokens,
    createdAt: summary.createdAt,
    preview: preview(summary.content),
    logicalPointer: `summaries.jsonl#${offset}:${length}`,
    terms: searchTerms(summary.content),
    truthRefs: summary.sourceMessageIds,
    compressionMethod: summary.compressionMethod,
    originalTokens: summary.originalTokens,
    compressedTokens: summary.compressedTokens,
  }
}

async function readIndexFile(path: string): Promise<ColdIndexItem[]> {
  const signature = await fileSignature(path)
  const cached = indexCache.get(path)
  if (cached?.signature === signature) {
    cacheIndex(path, cached)
    return cached.items
  }
  try {
    const kind = path.endsWith('summary-index.json') ? 'summary' : 'truth'
    const items = (JSON.parse(await readFile(path, 'utf8')) as ColdIndexItem[]).map((item) => ({
      ...item,
      kind: item.kind ?? kind,
      terms: item.terms ?? searchTerms(item.preview),
      truthRefs: item.truthRefs?.length ? item.truthRefs : kind === 'truth' ? [item.id] : [],
    }))
    cacheIndex(path, { signature, items })
    return items
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cacheIndex(path, { signature: 'missing', items: [] })
      return []
    }
    throw error
  }
}

export async function writeConversationMessages(projectId: string, conversationId: string, messages: AgentContextMessage[]): Promise<void> {
  const target = paths(projectId, conversationId)
  const overrides = await readOverrides(projectId, conversationId)
  await mkdir(target.folder, { recursive: true })
  const lines: string[] = []
  const index: ColdIndexItem[] = []
  let offset = 0
  for (const value of messages.filter((message) => message.representation !== 'summary')) {
    const id = value.id ?? randomUUID()
    // The truth log stores original messages only. Derived layer metadata stays in overrides/indexes.
    const truth = truthMessage(value, id, value.createdAt ?? new Date(0).toISOString())
    const storedTruth = await storedContextMessage(projectId, conversationId, truth)
    const override = captureOverride(value, overrides[id])
    overrides[id] = override
    const normalized = applyOverride(truth, override)
    const line = `${JSON.stringify(storedTruth)}\n`
    const length = Buffer.byteLength(line, 'utf8')
    lines.push(line)
    index.push(truthIndexItem(normalized, offset, length))
    offset += length
  }
  await writeFile(target.messages, lines.join(''), 'utf8')
  await writeFile(target.index, JSON.stringify(index), 'utf8')
  await writeOverrides(projectId, conversationId, overrides)
  invalidate(projectId, conversationId)
}

export async function ensureConversationMessages(projectId: string, conversationId: string, messages: AgentContextMessage[]): Promise<void> {
  if ((await readConversationIndex(projectId, conversationId)).length === 0 && messages.length > 0) {
    await writeConversationMessages(projectId, conversationId, messages)
  }
}

export async function appendConversationMessages(projectId: string, conversationId: string, messages: AgentContextMessage[]): Promise<void> {
  const target = paths(projectId, conversationId)
  const index = await readConversationIndex(projectId, conversationId)
  const known = new Set(index.map((item) => item.id))
  const additions = messages.filter((message) => {
    if (message.representation === 'summary' || (message.id && known.has(message.id))) return false
    if (message.id) known.add(message.id)
    return true
  })
  if (additions.length === 0) return
  const overrides = await readOverrides(projectId, conversationId)
  await mkdir(target.folder, { recursive: true })
  let offset = (await fileOverview(target.messages)).sizeBytes
  const lines: string[] = []
  for (const value of additions) {
    const id = value.id ?? randomUUID()
    const truth = truthMessage(value, id, value.createdAt ?? new Date().toISOString())
    const storedTruth = await storedContextMessage(projectId, conversationId, truth)
    const override = captureOverride(value, overrides[id])
    overrides[id] = override
    const normalized = applyOverride(truth, override)
    const line = `${JSON.stringify(storedTruth)}\n`
    const length = Buffer.byteLength(line, 'utf8')
    lines.push(line)
    index.push(truthIndexItem(normalized, offset, length))
    offset += length
  }
  await appendFile(target.messages, lines.join(''), 'utf8')
  await writeFile(target.index, JSON.stringify(index), 'utf8')
  await writeOverrides(projectId, conversationId, overrides)
  invalidate(projectId, conversationId)
}

export async function appendConversationSummaries(projectId: string, conversationId: string, summaries: ContextSummaryArtifact[]): Promise<void> {
  if (summaries.length === 0) return
  const target = paths(projectId, conversationId)
  const index = await readConversationSummaryIndex(projectId, conversationId)
  const known = new Set(index.map((item) => item.id))
  const additions = summaries.filter((summary) => {
    if (known.has(summary.id)) return false
    known.add(summary.id)
    return true
  })
  if (additions.some((summary) => !summary.content.startsWith(SUMMARY_LABEL) || summary.sourceMessageIds.length === 0)) {
    throw new Error('Cold summaries must be labeled and reference at least one truth record')
  }
  if (additions.length === 0) return
  await mkdir(target.folder, { recursive: true })
  let offset = (await fileOverview(target.summaries)).sizeBytes
  const lines: string[] = []
  for (const summary of additions) {
    const line = `${JSON.stringify(summary)}\n`
    const length = Buffer.byteLength(line, 'utf8')
    lines.push(line)
    index.push(summaryIndexItem(summary, offset, length))
    offset += length
  }
  await appendFile(target.summaries, lines.join(''), 'utf8')
  await writeFile(target.summaryIndex, JSON.stringify(index), 'utf8')
  invalidate(projectId, conversationId)
}

export function readConversationIndex(projectId: string, conversationId: string): Promise<ColdIndexItem[]> {
  return readIndexFile(paths(projectId, conversationId).index)
}

export function readConversationSummaryIndex(projectId: string, conversationId: string): Promise<ColdIndexItem[]> {
  return readIndexFile(paths(projectId, conversationId).summaryIndex)
}

export async function getConversationStorageRevision(projectId: string, conversationId: string): Promise<string> {
  const target = paths(projectId, conversationId)
  return (await Promise.all([target.messages, target.index, target.overrides, target.summaries, target.summaryIndex].map(fileSignature))).join('|')
}

function inspectIndex(items: ColdIndexItem[], fileName: string): { indexedBytes: number; pointersValid: boolean } {
  let indexedBytes = 0
  for (const item of items) {
    const match = item.logicalPointer.match(new RegExp(`${fileName.replace('.', '\\.') }#(\\d+):(\\d+)$`))
    if (!match || Number(match[1]) !== indexedBytes || Number(match[2]) <= 0) return { indexedBytes, pointersValid: false }
    indexedBytes += Number(match[2])
  }
  return { indexedBytes, pointersValid: true }
}

export async function readConversationStorageOverview(projectId: string, conversationId: string, items?: ColdIndexItem[]): Promise<ColdStorageOverview> {
  const target = paths(projectId, conversationId)
  const truth = items ?? await readConversationIndex(projectId, conversationId)
  const summariesIndex = await readConversationSummaryIndex(projectId, conversationId)
  const [messages, index, overrides, summaries, summaryIndex] = await Promise.all([
    fileOverview(target.messages), fileOverview(target.index), fileOverview(target.overrides), fileOverview(target.summaries), fileOverview(target.summaryIndex),
  ])
  const inspected = inspectIndex(truth, 'messages.jsonl')
  const empty = truth.length === 0 && (!messages.exists || messages.sizeBytes === 0)
  const indexStatus = empty ? 'empty' : messages.exists && index.exists && inspected.pointersValid && inspected.indexedBytes === messages.sizeBytes ? 'consistent' : 'mismatch'
  const modifiedTimes = [messages, index, overrides, summaries, summaryIndex].flatMap((file) => file.modifiedAt ? [file.modifiedAt] : [])
  return {
    folderPath: target.folder,
    messages,
    index,
    overrides,
    summaries,
    summaryIndex,
    recordCount: truth.length,
    summaryCount: summariesIndex.length,
    indexedBytes: inspected.indexedBytes,
    indexStatus,
    lastPersistedAt: modifiedTimes.sort().at(-1) ?? null,
  }
}

async function readAt<T>(filePath: string, item: ColdIndexItem): Promise<T> {
  const match = item.logicalPointer.match(/#(\d+):(\d+)$/)
  if (!match) throw new Error('Invalid Cold record pointer')
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(Number(match[2]))
    await handle.read(buffer, 0, buffer.length, Number(match[1]))
    return JSON.parse(buffer.toString('utf8')) as T
  } finally {
    await handle.close()
  }
}

export async function readConversationMessage(projectId: string, conversationId: string, messageId: string): Promise<AgentContextMessage> {
  const item = (await readConversationIndex(projectId, conversationId)).find((candidate) => candidate.id === messageId)
  if (!item) throw new Error('Cold truth message not found')
  const override = (await readOverrides(projectId, conversationId))[messageId]
  const message = await readAt<PersistedContextMessage>(paths(projectId, conversationId).messages, item)
  return applyOverride({ ...message, images: await hydrateImageAttachments(message.images) }, override)
}

export async function readConversationSummary(projectId: string, conversationId: string, summaryId: string): Promise<ContextSummaryArtifact> {
  const item = (await readConversationSummaryIndex(projectId, conversationId)).find((candidate) => candidate.id === summaryId)
  if (!item) throw new Error('Cold summary not found')
  return readAt<ContextSummaryArtifact>(paths(projectId, conversationId).summaries, item)
}

export async function readConversationMessages(
  projectId: string,
  conversationId: string,
  additionalMessages: AgentContextMessage[] = [],
): Promise<AgentContextMessage[]> {
  const items = await readConversationIndex(projectId, conversationId)
  const messages: AgentContextMessage[] = []
  for (const item of items) messages.push(await readConversationMessage(projectId, conversationId, item.id))
  const known = new Set(messages.map((message) => message.id))
  for (const message of additionalMessages) {
    if (!message.id || known.has(message.id)) continue
    messages.push(message)
  }
  return messages
}

function splitRounds(items: ColdIndexItem[]): ColdIndexItem[][] {
  const rounds: ColdIndexItem[][] = []
  for (const item of items) {
    if (item.role === 'user' || rounds.length === 0) rounds.push([item])
    else rounds.at(-1)?.push(item)
  }
  return rounds
}

function queryTerms(query: string): string[] {
  return searchTerms(query).slice(0, 30)
}

function score(item: ColdIndexItem, terms: string[]): number {
  return terms.reduce((sum, term) => sum + (item.terms.some((value) => value.includes(term)) || item.preview.toLowerCase().includes(term) ? 1 : 0), 0)
}

function exactIntent(query: string): boolean {
  return /(?:exact|verbatim|original|raw|log|trace|stack|parameter|argument|version|date|time|number|code|原文|完整|日志|报错|参数|版本|日期|数字|代码)/i.test(query)
}

export async function searchConversationContext(projectId: string, conversationId: string, query: string, limit = 20): Promise<ColdIndexItem[]> {
  const terms = queryTerms(query)
  if (terms.length === 0) return []
  const [truth, summaries] = await Promise.all([readConversationIndex(projectId, conversationId), readConversationSummaryIndex(projectId, conversationId)])
  const preferred = exactIntent(query) ? [...truth, ...summaries] : [...summaries, ...truth]
  const kindRank = exactIntent(query) ? { truth: 1, summary: 0 } : { truth: 0, summary: 1 }
  return preferred.map((item) => ({ item, score: score(item, terms) })).filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || kindRank[right.item.kind] - kindRank[left.item.kind] || right.item.createdAt.localeCompare(left.item.createdAt))
    .slice(0, Math.max(1, Math.min(50, limit))).map(({ item }) => item)
}

export async function readContextRecords(projectId: string, conversationId: string, ids: string[]): Promise<AgentContextMessage[]> {
  const truth = new Set((await readConversationIndex(projectId, conversationId)).map((item) => item.id))
  const summaries = new Set((await readConversationSummaryIndex(projectId, conversationId)).map((item) => item.id))
  const result: AgentContextMessage[] = []
  for (const id of ids.slice(0, 20)) {
    if (truth.has(id)) {
      const message = await readConversationMessage(projectId, conversationId, id)
      result.push({ ...message, representation: 'original', truthRefs: [id], contextLayer: 'hot', contextRegion: 'newborn', contextSource: 'cold-truth-recall', lastAccessedAt: new Date().toISOString(), enteredHotAt: new Date().toISOString(), reuseCount: (message.reuseCount ?? 0) + 1 })
    } else if (summaries.has(id)) {
      const summary = await readConversationSummary(projectId, conversationId, id)
      result.push({ id: summary.id, createdAt: summary.createdAt, role: summary.role, content: summary.content, representation: 'summary', truthRefs: summary.sourceMessageIds, contextLayer: 'hot', contextRegion: 'newborn', contextSource: 'cold-summary-recall', lastAccessedAt: new Date().toISOString(), enteredHotAt: new Date().toISOString(), reuseCount: 1 })
    }
  }
  return result
}

export async function readConversationWorkingSet(
  projectId: string,
  conversationId: string,
  config: ContextManagementConfig,
  query: string,
  rememberedWarm: AgentContextMessage[] = [],
  promotedHot: AgentContextMessage[] = [],
  rememberedHot: AgentContextMessage[] = [],
  latestUserMessageId?: string,
  latestUserMessage?: AgentContextMessage,
): Promise<AgentContextMessage[]> {
  const index = await readConversationIndex(projectId, conversationId)
  const indexById = new Map(index.map((item) => [item.id, item]))
  const now = new Date().toISOString()
  const hotById = new Map<string, AgentContextMessage>()
  const warmById = new Map<string, AgentContextMessage>()
  const load = async (id: string): Promise<AgentContextMessage | undefined> => {
    if (!indexById.has(id)) return undefined
    return readConversationMessage(projectId, conversationId, id)
  }

  const asHot = (message: AgentContextMessage, fresh = false): AgentContextMessage => ({
    ...message,
    contextLayer: 'hot',
    contextRegion: message.contextRegion ?? 'newborn',
    contextSource: message.contextSource ?? 'live',
    representation: message.representation ?? 'original',
    truthRefs: message.truthRefs?.length ? message.truthRefs : message.id ? [message.id] : [],
    enteredHotAt: fresh ? now : message.enteredHotAt ?? message.createdAt ?? now,
    reuseCount: Math.max(0, message.reuseCount ?? 0),
  })
  const asWarm = (message: AgentContextMessage): AgentContextMessage => ({
    ...message,
    contextLayer: 'warm',
    contextRegion: message.contextRegion ?? 'newborn',
    contextSource: message.contextSource === 'cold-summary-recall' ? 'cold-summary-recall' : 'hot-demotion',
    representation: message.representation ?? 'original',
    truthRefs: message.truthRefs?.length ? message.truthRefs : message.id ? [message.id] : [],
  })

  for (const message of rememberedHot) if (message.id && message.contextLayer !== 'warm') hotById.set(message.id, asHot(message))
  for (const message of rememberedWarm) if (message.id && message.representation !== 'summary') warmById.set(message.id, asWarm(message))
  for (const message of promotedHot) {
    if (!message.id) continue
    hotById.set(message.id, asHot({
      ...message,
      pinnedToHot: false,
      manualContextLayer: undefined,
      contextSource: message.contextSource ?? 'warm-recall',
      lastAccessedAt: now,
      reuseCount: (message.reuseCount ?? 0) + 1,
    }, true))
    warmById.delete(message.id)
  }

  for (const item of index.filter((candidate) => candidate.manualContextLayer === 'warm')) {
    if (hotById.has(item.id) || warmById.has(item.id)) continue
    const message = await load(item.id)
    if (message) warmById.set(item.id, asWarm(message))
  }
  for (const item of index.filter((candidate) => migratePin(candidate) || candidate.contextRegion === 'long-term')) {
    if (hotById.has(item.id)) continue
    const message = await load(item.id)
    if (message) hotById.set(item.id, asHot(message))
    warmById.delete(item.id)
  }

  if (latestUserMessageId && !hotById.has(latestUserMessageId)) {
    const message = latestUserMessage?.id === latestUserMessageId
      ? latestUserMessage
      : await load(latestUserMessageId)
    if (message) hotById.set(latestUserMessageId, asHot(message, true))
    warmById.delete(latestUserMessageId)
  }

  if (rememberedHot.length === 0 && rememberedWarm.length === 0) {
    const targetTokens = Math.max(1, Math.floor(config.hotTokenBudget * 0.8))
    let selectedTokens = [...hotById.values()].reduce((sum, message) => sum + countContextTokens(message), 0)
    const rounds = splitRounds(index.filter((item) => item.manualContextLayer !== 'warm'))
    for (let roundIndex = rounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
      const round = rounds[roundIndex]
      const missing = round.filter((item) => !hotById.has(item.id))
      const roundTokens = missing.reduce((sum, item) => sum + item.tokenCount, 0)
      if (missing.length === 0) continue
      if (selectedTokens > 0 && selectedTokens + roundTokens > targetTokens) break
      for (const item of missing) {
        const message = await load(item.id)
        if (message) hotById.set(item.id, asHot(message))
      }
      selectedTokens += roundTokens
    }
  }

  const residentIds = new Set([...hotById.keys(), ...warmById.keys()])
  const terms = queryTerms(query)
  const warmMatches = [...warmById.values()].map((message) => ({
    message,
    score: terms.reduce((sum, term) => sum + (searchTerms(message.content).some((value) => value.includes(term)) || (message.content ?? '').toLowerCase().includes(term) ? 1 : 0), 0),
  })).filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score || (right.message.createdAt ?? '').localeCompare(left.message.createdAt ?? ''))

  let recalledTokens = 0
  const recalled: AgentContextMessage[] = []
  const recalledTruthRefs = new Set<string>()
  for (const { message } of warmMatches) {
    const tokenCount = countContextTokens(message)
    if (recalledTokens + tokenCount > config.coldRecallTokenBudget) continue
    recalled.push(asHot({
      ...message,
      contextSource: 'warm-recall',
      lastAccessedAt: now,
      reuseCount: (message.reuseCount ?? 0) + 1,
    }, true))
    warmById.delete(message.id ?? '')
    for (const truthRef of message.truthRefs ?? []) recalledTruthRefs.add(truthRef)
    recalledTokens += tokenCount
  }

  const matches = await searchConversationContext(projectId, conversationId, query, 20)
  for (const match of matches) {
    if (residentIds.has(match.id) || warmById.has(match.id) || match.truthRefs.some((id) => recalledTruthRefs.has(id)) || recalledTokens + match.tokenCount > config.coldRecallTokenBudget) continue
    const [message] = await readContextRecords(projectId, conversationId, [match.id])
    if (!message) continue
    recalled.push(message)
    for (const truthRef of message.truthRefs ?? []) recalledTruthRefs.add(truthRef)
    recalledTokens += match.tokenCount
  }

  return [
    ...[...hotById.values()].sort((left, right) => (left.createdAt ?? '').localeCompare(right.createdAt ?? '')),
    ...[...warmById.values()].sort((left, right) => (left.createdAt ?? '').localeCompare(right.createdAt ?? '')),
    ...recalled,
  ]
}
export async function updateConversationPin(projectId: string, conversationId: string, messageId: string, pinnedToHot: boolean): Promise<void> {
  const items = await readConversationIndex(projectId, conversationId)
  const item = items.find((candidate) => candidate.id === messageId)
  if (!item) throw new Error('Message not found')
  const overrides = await readOverrides(projectId, conversationId)
  overrides[messageId] = { ...overrides[messageId], pinnedToHot, manualContextLayer: pinnedToHot ? undefined : overrides[messageId]?.manualContextLayer, manualProtected: undefined, protection: undefined }
  item.pinnedToHot = pinnedToHot
  if (pinnedToHot) item.manualContextLayer = undefined
  await writeOverrides(projectId, conversationId, overrides)
  await writeFile(paths(projectId, conversationId).index, JSON.stringify(items), 'utf8')
  invalidate(projectId, conversationId)
}
export async function updateConversationLayer(projectId: string, conversationId: string, messageIds: Set<string>, layer: 'warm'): Promise<void> {
  const items = await readConversationIndex(projectId, conversationId)
  const found = items.filter((item) => messageIds.has(item.id))
  if (found.length !== messageIds.size) throw new Error('Message not found')
  const overrides = await readOverrides(projectId, conversationId)
  for (const item of found) {
    overrides[item.id] = { ...overrides[item.id], manualContextLayer: layer, pinnedToHot: false }
    item.manualContextLayer = layer
    item.pinnedToHot = false
  }
  await writeOverrides(projectId, conversationId, overrides)
  await writeFile(paths(projectId, conversationId).index, JSON.stringify(items), 'utf8')
  invalidate(projectId, conversationId)
}
