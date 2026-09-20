import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { app, net } from 'electron'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import type {
  KnowledgeBase,
  KnowledgeBaseModelProgress,
  KnowledgeBaseSearchResult,
  EmbeddingProviderConfig,
  LocalEmbeddingProviderConfig,
  ResourceSelectionOverride,
} from '../shared/types'
import { defaultLocalEmbeddingModelId } from '../shared/types'
import { sanitizeResourceSelection } from './skills'

export const defaultLocalEmbeddingModel = defaultLocalEmbeddingModelId
const registryVersion = 1
const supportedExtensions = new Set(['.txt', '.md'])
const maxFiles = 5_000
const maxFileBytes = 2 * 1024 * 1024
const maxTotalBytes = 64 * 1024 * 1024
const maxChunks = 25_000
const defaultSearchLimit = 8
const maximumSearchLimit = 30
const searchTimeoutMs = 15_000

type KnowledgeBaseRegistry = { version: 1; knowledgeBases: KnowledgeBase[] }
export type ParsedKnowledgeDocument = {
  sourcePath: string
  relativePath: string
  text: string
  page?: number
  slide?: number
  sheet?: string
  section?: string
  extractionMethod?: 'native' | 'ocr'
}
export type RagChunk = {
  relativePath: string
  lineStart: number
  lineEnd: number
  content: string
  vector: number[]
}
type RagIndex = {
  version: 1
  knowledgeBaseId: string
  modelId: string
  createdAt: string
  chunks: RagChunk[]
}

export interface EmbeddingProvider {
  readonly id: string
  prepare(onProgress?: (progress: KnowledgeBaseModelProgress) => void): Promise<void>
  embed(texts: string[]): Promise<number[][]>
}

export interface LocalDocumentParser {
  supports(filePath: string): boolean
  parse(filePath: string, rootPath: string): Promise<ParsedKnowledgeDocument>
}

class PlainTextParser implements LocalDocumentParser {
  supports(filePath: string): boolean {
    return supportedExtensions.has(extname(filePath).toLowerCase())
  }

  async parse(filePath: string, rootPath: string): Promise<ParsedKnowledgeDocument> {
    return {
      sourcePath: filePath,
      relativePath: relative(rootPath, filePath).split(sep).join('/'),
      text: await readFile(filePath, 'utf8'),
      extractionMethod: 'native',
    }
  }
}

const documentParsers: LocalDocumentParser[] = [new PlainTextParser()]
let writeQueue = Promise.resolve()
const refreshQueues = new Map<string, Promise<void>>()
let knowledgeBaseRootOverride: string | null = null
let embeddingProviderFactory: (config: LocalEmbeddingProviderConfig) => EmbeddingProvider = (config) => new TransformersEmbeddingProvider(config)
const embeddingProviders = new Map<string, EmbeddingProvider>()

function knowledgeBaseRoot(): string {
  return knowledgeBaseRootOverride ?? join(app.getPath('userData'), 'knowledge-bases')
}

export function setKnowledgeBaseRootForTests(rootPath: string | null): void {
  knowledgeBaseRootOverride = rootPath ? resolve(rootPath) : null
  writeQueue = Promise.resolve()
  refreshQueues.clear()
  embeddingProviders.clear()
}

function registryPath(): string {
  return join(knowledgeBaseRoot(), 'registry.json')
}

function indexPath(id: string): string {
  return join(knowledgeBaseRoot(), 'indexes', id, 'index.json')
}

function modelCachePath(): string {
  return join(knowledgeBaseRoot(), 'models')
}

export function resolveUnpackedExecutablePath(filePath: string): string {
  return filePath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task)
  writeQueue = next.then(() => undefined, () => undefined)
  return next
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Knowledge base id is invalid')
  return id
}

function cleanName(name: unknown, fallback: string): string {
  if (typeof name !== 'string') return fallback
  const value = name.trim()
  return value ? value.slice(0, 120) : fallback
}

function normalizeEmbeddingProvider(value: EmbeddingProviderConfig | null | undefined): LocalEmbeddingProviderConfig {
  if (value?.kind === 'remote') throw new Error('Remote embedding providers are not available in this version')
  return {
    kind: 'local',
    modelId: cleanName(value?.modelId, defaultLocalEmbeddingModel),
  }
}

function requireLocalEmbeddingProvider(value: EmbeddingProviderConfig | null): LocalEmbeddingProviderConfig {
  if (!value) throw new Error('RAG knowledge base requires an embedding provider')
  if (value.kind !== 'local') throw new Error('Remote embedding providers are not available in this version')
  return normalizeEmbeddingProvider(value)
}

function normalizeKnowledgeBase(value: unknown): KnowledgeBase | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<KnowledgeBase>
  if (typeof record.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(record.id)) return null
  if (record.source?.kind !== 'local-directory' || typeof record.source.path !== 'string' || !isAbsolute(record.source.path)) return null
  const mode = record.mode === 'rag' ? 'rag' : 'rg'
  const embeddingProvider = mode === 'rag'
    ? record.embeddingProvider?.kind === 'local'
      ? { kind: 'local' as const, modelId: cleanName(record.embeddingProvider.modelId, defaultLocalEmbeddingModel) }
      : { kind: 'local' as const, modelId: defaultLocalEmbeddingModel }
    : null
  const now = new Date().toISOString()
  return {
    id: record.id,
    name: cleanName(record.name, basename(record.source.path)),
    source: { kind: 'local-directory', path: resolve(record.source.path) },
    mode,
    embeddingProvider,
    status: record.status === 'indexing' || record.status === 'error' || record.status === 'model-required' ? record.status : 'ready',
    fileCount: Number.isSafeInteger(record.fileCount) && Number(record.fileCount) >= 0 ? Number(record.fileCount) : 0,
    totalBytes: Number.isSafeInteger(record.totalBytes) && Number(record.totalBytes) >= 0 ? Number(record.totalBytes) : 0,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now,
    indexedAt: typeof record.indexedAt === 'string' ? record.indexedAt : null,
    ...(typeof record.error === 'string' && record.error ? { error: record.error } : {}),
  }
}

export function normalizeKnowledgeBaseRegistry(value: unknown): KnowledgeBase[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const values = Array.isArray((value as Partial<KnowledgeBaseRegistry>).knowledgeBases)
    ? (value as Partial<KnowledgeBaseRegistry>).knowledgeBases ?? []
    : []
  const result: KnowledgeBase[] = []
  const seen = new Set<string>()
  for (const entry of values) {
    const normalized = normalizeKnowledgeBase(entry)
    if (!normalized || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    result.push(normalized)
  }
  return result
}

async function readRegistry(): Promise<KnowledgeBase[]> {
  try {
    return normalizeKnowledgeBaseRegistry(JSON.parse(await readFile(registryPath(), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('Unable to read knowledge base registry')
  }
}

async function writeRegistry(knowledgeBases: KnowledgeBase[]): Promise<void> {
  await mkdir(knowledgeBaseRoot(), { recursive: true })
  const target = registryPath()
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify({ version: registryVersion, knowledgeBases }, null, 2)}\n`, 'utf8')
  await rename(temporary, target)
}

async function requireDirectory(directoryPath: string): Promise<string> {
  const absolute = resolve(directoryPath)
  const info = await stat(absolute)
  if (!info.isDirectory()) throw new Error('Knowledge base source must be a directory')
  return absolute
}

async function scanSupportedFiles(rootPath: string): Promise<{ files: string[]; totalBytes: number }> {
  const files: string[] = []
  let totalBytes = 0
  const pending = [rootPath]
  while (pending.length > 0) {
    const directory = pending.pop()!
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(fullPath)
        continue
      }
      if (!entry.isFile() || !supportedExtensions.has(extname(entry.name).toLowerCase())) continue
      const fileStat = await stat(fullPath)
      if (fileStat.size > maxFileBytes) continue
      if (files.length >= maxFiles) throw new Error(`Knowledge base exceeds the ${maxFiles} supported-file limit`)
      if (totalBytes + fileStat.size > maxTotalBytes) throw new Error('Knowledge base exceeds the 64 MB text limit')
      files.push(fullPath)
      totalBytes += fileStat.size
    }
  }
  files.sort((left, right) => left.localeCompare(right))
  return { files, totalBytes }
}

export async function loadSupportedDocuments(rootPath: string): Promise<{ documents: ParsedKnowledgeDocument[]; totalBytes: number }> {
  const root = await requireDirectory(rootPath)
  const { files, totalBytes } = await scanSupportedFiles(root)
  const documents: ParsedKnowledgeDocument[] = []
  for (const filePath of files) {
    const parser = documentParsers.find((candidate) => candidate.supports(filePath))
    if (!parser) continue
    try {
      documents.push(await parser.parse(filePath, root))
    } catch {
      // A malformed or concurrently removed file does not invalidate the remaining knowledge base.
    }
  }
  return { documents, totalBytes }
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1
  return line
}

export function chunkDocument(document: ParsedKnowledgeDocument, targetChars = 2_200, overlapChars = 250): Omit<RagChunk, 'vector'>[] {
  const text = document.text.replace(/\r\n?/g, '\n')
  const firstContentOffset = text.search(/\S/)
  if (firstContentOffset < 0) return []
  const trailingWhitespaceLength = text.match(/\s*$/)?.[0].length ?? 0
  const contentEnd = text.length - trailingWhitespaceLength
  const chunks: Omit<RagChunk, 'vector'>[] = []
  let start = firstContentOffset
  while (start < contentEnd) {
    let end = Math.min(contentEnd, start + targetChars)
    if (end < contentEnd) {
      const boundary = Math.max(text.lastIndexOf('\n\n', end), text.lastIndexOf('\n#', end), text.lastIndexOf('\n', end))
      if (boundary > start + Math.floor(targetChars * 0.55)) end = boundary
    }
    const content = text.slice(start, end).trim()
    if (content) {
      const contentOffset = start + Math.max(0, text.slice(start, end).indexOf(content))
      chunks.push({
        relativePath: document.relativePath,
        lineStart: lineNumberAt(text, contentOffset),
        lineEnd: lineNumberAt(text, contentOffset + content.length),
        content,
      })
    }
    if (end >= contentEnd) break
    start = Math.max(start + 1, end - overlapChars)
  }
  return chunks
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return -1
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : -1
}

export function rankRagChunks(chunks: RagChunk[], queryVector: number[], limit = defaultSearchLimit): RagChunk[] {
  return chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(chunk.vector, queryVector) }))
    .filter((entry) => Number.isFinite(entry.score) && entry.score > -1)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => ({ ...entry.chunk, vector: entry.chunk.vector }))
}

type TransformersEnvironment = {
  cacheDir?: string | null
  remoteHost?: string
  fetch?: (...args: any[]) => Promise<any>
}

type TransformersModuleLike = {
  env?: TransformersEnvironment
}

export function normalizeHuggingFaceEndpoint(value: string): string {
  const endpoint = value.trim()
  if (!endpoint) return 'https://huggingface.co/'
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error('Hugging Face endpoint must be a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Hugging Face endpoint must use HTTP or HTTPS')
  }
  return `${parsed.toString().replace(/\/+$/, '')}/`
}

export function configureTransformersEnvironment(transformers: TransformersModuleLike): void {
  if (!transformers.env) return
  // Transformers.js defaults to a package-relative cache. That location is
  // read-only after packaging, so keep downloaded models in Electron userData.
  transformers.env.cacheDir = modelCachePath()

  const endpoint = process.env.CODEY_HUGGINGFACE_ENDPOINT?.trim()
  if (endpoint) transformers.env.remoteHost = normalizeHuggingFaceEndpoint(endpoint)

  // Electron's network stack honors the app/OS proxy and certificate settings.
  // Node/undici fetch does not, which can surface only as an opaque `fetch failed`.
  const electronFetch = (net as unknown as { fetch?: (...args: any[]) => Promise<any> } | undefined)?.fetch
  if (typeof electronFetch === 'function') transformers.env.fetch = electronFetch.bind(net)
}

function describeEmbeddingModelError(error: unknown, modelId: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  const cause = error && typeof error === 'object' && 'cause' in error
    ? (error as { cause?: unknown }).cause
    : undefined
  const causeCode = cause && typeof cause === 'object' && 'code' in cause
    ? String((cause as { code?: unknown }).code)
    : ''
  const configuredEndpoint = process.env.CODEY_HUGGINGFACE_ENDPOINT?.trim()
  const endpoint = configuredEndpoint
    ? normalizeHuggingFaceEndpoint(configuredEndpoint)
    : 'https://huggingface.co/'
  if (message === 'fetch failed' || causeCode === 'UND_ERR_CONNECT_TIMEOUT') {
    return new Error(
      `Unable to download embedding model "${modelId}" from ${endpoint}. `
      + 'Check your internet connection or proxy settings, then retry. '
      + 'If Hugging Face is unavailable on your network, set CODEY_HUGGINGFACE_ENDPOINT to a reachable compatible mirror. '
      + `(${message}${causeCode ? `: ${causeCode}` : ''})`,
      { cause: error },
    )
  }
  return new Error(`Unable to load embedding model "${modelId}": ${message}`, { cause: error })
}
class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly id: string
  private extractor: any
  private preparePromise: Promise<void> | null = null

  constructor(private readonly config: LocalEmbeddingProviderConfig) {
    this.id = `local:${config.modelId}`
  }

  async prepare(onProgress?: (progress: KnowledgeBaseModelProgress) => void): Promise<void> {
    if (this.extractor) return
    if (!this.preparePromise) {
      this.preparePromise = (async () => {
        await mkdir(modelCachePath(), { recursive: true })
        onProgress?.({ modelId: this.config.modelId, status: 'downloading' })
        const transformers = await import('@huggingface/transformers')
        configureTransformersEnvironment(transformers)
        try {
          this.extractor = await transformers.pipeline('feature-extraction', this.config.modelId, {
            dtype: 'q8',
            progress_callback: (event: Record<string, unknown>) => {
              const raw = typeof event.progress === 'number' ? event.progress : undefined
              onProgress?.({
                modelId: this.config.modelId,
                status: 'downloading',
                progress: raw === undefined ? undefined : Math.max(0, Math.min(100, raw)),
                file: typeof event.file === 'string' ? event.file : undefined,
              })
            },
          } as any)
        } catch (error) {
          throw describeEmbeddingModelError(error, this.config.modelId)
        }
        onProgress?.({ modelId: this.config.modelId, status: 'ready', progress: 100 })
      })().catch((error) => {
        this.preparePromise = null
        throw error
      })
    }
    await this.preparePromise
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.prepare()
    if (texts.length === 0) return []
    const output = await this.extractor(texts, { pooling: 'mean', normalize: true })
    const values = output.tolist() as number[][] | number[]
    return typeof values[0] === 'number' ? [values as number[]] : values as number[][]
  }
}

function getEmbeddingProvider(config: LocalEmbeddingProviderConfig): EmbeddingProvider {
  const key = `${config.kind}:${config.modelId}`
  const existing = embeddingProviders.get(key)
  if (existing) return existing
  const provider = embeddingProviderFactory(config)
  embeddingProviders.set(key, provider)
  return provider
}

export function setEmbeddingProviderFactoryForTests(factory: ((config: LocalEmbeddingProviderConfig) => EmbeddingProvider) | null): void {
  embeddingProviderFactory = factory ?? ((config) => new TransformersEmbeddingProvider(config))
  embeddingProviders.clear()
}

async function buildRagIndex(knowledgeBase: KnowledgeBase, documents: ParsedKnowledgeDocument[], onProgress?: (progress: KnowledgeBaseModelProgress) => void): Promise<RagIndex> {
  const config = requireLocalEmbeddingProvider(knowledgeBase.embeddingProvider)
  const provider = getEmbeddingProvider(config)
  await provider.prepare((progress) => onProgress?.({ ...progress, knowledgeBaseId: knowledgeBase.id }))
  const chunks = documents.flatMap((document) => chunkDocument(document))
  if (chunks.length > maxChunks) throw new Error(`Knowledge base exceeds the ${maxChunks} chunk limit`)
  const indexed: RagChunk[] = []
  for (let offset = 0; offset < chunks.length; offset += 16) {
    const batch = chunks.slice(offset, offset + 16)
    const vectors = await provider.embed(batch.map((chunk) => chunk.content))
    if (vectors.length !== batch.length) throw new Error('Embedding provider returned an invalid result')
    indexed.push(...batch.map((chunk, index) => ({ ...chunk, vector: vectors[index] })))
  }
  return {
    version: 1,
    knowledgeBaseId: knowledgeBase.id,
    modelId: config.modelId,
    createdAt: new Date().toISOString(),
    chunks: indexed,
  }
}

async function writeRagIndex(index: RagIndex): Promise<void> {
  const target = indexPath(safeId(index.knowledgeBaseId))
  await mkdir(join(knowledgeBaseRoot(), 'indexes', index.knowledgeBaseId), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(index), 'utf8')
  await rename(temporary, target)
}

async function readRagIndex(knowledgeBase: KnowledgeBase): Promise<RagIndex> {
  try {
    const value = JSON.parse(await readFile(indexPath(safeId(knowledgeBase.id)), 'utf8')) as Partial<RagIndex>
    if (value.version !== 1 || value.knowledgeBaseId !== knowledgeBase.id || value.modelId !== knowledgeBase.embeddingProvider?.modelId || !Array.isArray(value.chunks)) {
      throw new Error('RAG index is stale')
    }
    return value as RagIndex
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('RAG index is missing; refresh the knowledge base')
    if (error instanceof Error && error.message === 'RAG index is stale') throw error
    throw new Error('Unable to read RAG index')
  }
}

export async function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  await writeQueue
  return readRegistry()
}

export async function getKnowledgeBasesByIds(ids: string[]): Promise<KnowledgeBase[]> {
  const wanted = new Set(ids)
  return (await listKnowledgeBases()).filter((item) => wanted.has(item.id))
}

export function resolveKnowledgeBaseSelection(globalIds: string[], project: ResourceSelectionOverride, conversation: ResourceSelectionOverride): string[] {
  const projectSelection = sanitizeResourceSelection(project)
  const conversationSelection = sanitizeResourceSelection(conversation)
  const effective = new Set(globalIds.filter((id) => typeof id === 'string' && id.trim() !== ''))
  for (const id of projectSelection.enabledIds) effective.add(id)
  for (const id of projectSelection.disabledIds) effective.delete(id)
  for (const id of conversationSelection.enabledIds) effective.add(id)
  for (const id of conversationSelection.disabledIds) effective.delete(id)
  return [...effective]
}

export async function createKnowledgeBase(input: {
  name?: string
  directoryPath: string
  mode: 'rg' | 'rag'
  embeddingProvider?: EmbeddingProviderConfig | null
}, onProgress?: (progress: KnowledgeBaseModelProgress) => void): Promise<KnowledgeBase> {
  const directoryPath = await requireDirectory(input.directoryPath)
  const mode = input.mode === 'rag' ? 'rag' : 'rg'
  const now = new Date().toISOString()
  const knowledgeBase: KnowledgeBase = {
    id: randomUUID(),
    name: cleanName(input.name, basename(directoryPath)),
    source: { kind: 'local-directory', path: directoryPath },
    mode,
    embeddingProvider: mode === 'rag'
      ? requireLocalEmbeddingProvider(input.embeddingProvider ?? null)
      : null,
    status: mode === 'rag' ? 'model-required' : 'ready',
    fileCount: 0,
    totalBytes: 0,
    createdAt: now,
    updatedAt: now,
    indexedAt: null,
  }
  await serializeWrite(async () => writeRegistry([...(await readRegistry()), knowledgeBase]))
  return refreshKnowledgeBase(knowledgeBase.id, onProgress)
}

export async function updateKnowledgeBase(id: string, patch: {
  name?: string
  mode?: 'rg' | 'rag'
  embeddingProvider?: EmbeddingProviderConfig | null
}, onProgress?: (progress: KnowledgeBaseModelProgress) => void): Promise<KnowledgeBase> {
  safeId(id)
  let changedMode = false
  const updated = await serializeWrite(async () => {
    const entries = await readRegistry()
    const index = entries.findIndex((entry) => entry.id === id)
    if (index < 0) throw new Error('Knowledge base not found')
    const current = entries[index]
    const mode = patch.mode === undefined ? current.mode : patch.mode
    const embeddingProvider = mode === 'rag'
      ? requireLocalEmbeddingProvider(patch.embeddingProvider ?? current.embeddingProvider)
      : null
    changedMode = mode !== current.mode || (embeddingProvider?.modelId ?? null) !== (current.embeddingProvider?.modelId ?? null)
    entries[index] = {
      ...current,
      name: patch.name === undefined ? current.name : cleanName(patch.name, current.name),
      mode,
      embeddingProvider,
      status: changedMode ? (mode === 'rag' ? 'model-required' : 'ready') : current.status,
      indexedAt: changedMode ? null : current.indexedAt,
      updatedAt: new Date().toISOString(),
      error: changedMode ? undefined : current.error,
    }
    await writeRegistry(entries)
    return entries[index]
  })
  if (changedMode) return refreshKnowledgeBase(id, onProgress)
  return updated
}

async function performRefreshKnowledgeBase(id: string, onProgress?: (progress: KnowledgeBaseModelProgress) => void): Promise<KnowledgeBase> {
  safeId(id)
  const entries = await readRegistry()
  const current = entries.find((entry) => entry.id === id)
  if (!current) throw new Error('Knowledge base not found')
  await serializeWrite(async () => {
    const latest = await readRegistry()
    const index = latest.findIndex((entry) => entry.id === id)
    if (index < 0) return
    latest[index] = { ...latest[index], status: 'indexing', error: undefined, updatedAt: new Date().toISOString() }
    await writeRegistry(latest)
  })
  try {
    const { documents, totalBytes } = await loadSupportedDocuments(current.source.path)
    if (current.mode === 'rag') await writeRagIndex(await buildRagIndex(current, documents, onProgress))
    const indexedAt = new Date().toISOString()
    return serializeWrite(async () => {
      const latest = await readRegistry()
      const index = latest.findIndex((entry) => entry.id === id)
      if (index < 0) throw new Error('Knowledge base not found')
      latest[index] = {
        ...latest[index],
        status: 'ready',
        fileCount: documents.length,
        totalBytes,
        indexedAt,
        updatedAt: indexedAt,
        error: undefined,
      }
      await writeRegistry(latest)
      return latest[index]
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await serializeWrite(async () => {
      const latest = await readRegistry()
      const index = latest.findIndex((entry) => entry.id === id)
      if (index >= 0) {
        latest[index] = { ...latest[index], status: 'error', error: message, updatedAt: new Date().toISOString() }
        await writeRegistry(latest)
      }
    })
    onProgress?.({ knowledgeBaseId: id, modelId: current.embeddingProvider?.modelId ?? '', status: 'error', error: message })
    throw error
  }
}

export function refreshKnowledgeBase(id: string, onProgress?: (progress: KnowledgeBaseModelProgress) => void): Promise<KnowledgeBase> {
  safeId(id)
  const previous = refreshQueues.get(id) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(() => performRefreshKnowledgeBase(id, onProgress))
  const tracked = result.then(() => undefined, () => undefined)
  refreshQueues.set(id, tracked)
  void tracked.finally(() => {
    if (refreshQueues.get(id) === tracked) refreshQueues.delete(id)
  })
  return result
}

export async function removeKnowledgeBase(id: string): Promise<void> {
  safeId(id)
  await serializeWrite(async () => {
    const entries = await readRegistry()
    const filtered = entries.filter((entry) => entry.id !== id)
    if (filtered.length === entries.length) return
    await writeRegistry(filtered)
    const indexesRoot = resolve(knowledgeBaseRoot(), 'indexes')
    const target = resolve(indexesRoot, id)
    if (target !== indexesRoot && target.startsWith(`${indexesRoot}${sep}`)) await rm(target, { recursive: true, force: true })
  })
}

function normalizedLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(maximumSearchLimit, Number.isFinite(limit) ? Math.floor(limit!) : defaultSearchLimit))
}

async function searchWithRipgrep(knowledgeBase: KnowledgeBase, query: string, limit: number, signal?: AbortSignal): Promise<KnowledgeBaseSearchResult[]> {
  return new Promise((resolvePromise, reject) => {
    const args = ['--json', '--line-number', '--no-heading', '--color', 'never', '--fixed-strings', '--glob', '*.txt', '--glob', '*.TXT', '--glob', '*.md', '--glob', '*.MD', '--max-count', String(limit), '--', query, knowledgeBase.source.path]
    const child = spawn(resolveUnpackedExecutablePath(rgPath), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const results: KnowledgeBaseSearchResult[] = []
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolvePromise(results.slice(0, limit))
    }
    const abort = (): void => {
      child.kill()
      finish(new Error('Knowledge base search was stopped'))
    }
    const parseLines = (): void => {
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim() || results.length >= limit) continue
        try {
          const event = JSON.parse(line) as { type?: string; data?: any }
          if (event.type !== 'match') continue
          const pathText = event.data?.path?.text
          const content = event.data?.lines?.text
          const lineNumber = event.data?.line_number
          if (typeof pathText !== 'string' || typeof content !== 'string') continue
          results.push({
            knowledgeBaseId: knowledgeBase.id,
            knowledgeBaseName: knowledgeBase.name,
            sourcePath: pathText,
            relativePath: relative(knowledgeBase.source.path, pathText).split(sep).join('/'),
            lineStart: typeof lineNumber === 'number' ? lineNumber : undefined,
            lineEnd: typeof lineNumber === 'number' ? lineNumber : undefined,
            content: content.trimEnd(),
          })
        } catch {
          // Ignore malformed diagnostic lines and continue parsing valid matches.
        }
      }
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('Knowledge base search timed out'))
    }, searchTimeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      parseLines()
      if (results.length >= limit) child.kill()
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      parseLines()
      if (code === 0 || code === 1 || results.length >= limit) finish()
      else finish(new Error(stderr.trim() || `ripgrep exited with code ${code}`))
    })
  })
}

async function searchWithRag(knowledgeBase: KnowledgeBase, query: string, limit: number, signal?: AbortSignal): Promise<KnowledgeBaseSearchResult[]> {
  if (signal?.aborted) throw new Error('Knowledge base search was stopped')
  const index = await readRagIndex(knowledgeBase)
  if (signal?.aborted) throw new Error('Knowledge base search was stopped')
  const provider = getEmbeddingProvider(requireLocalEmbeddingProvider(knowledgeBase.embeddingProvider))
  const [queryVector] = await provider.embed([query])
  if (signal?.aborted) throw new Error('Knowledge base search was stopped')
  if (!Array.isArray(queryVector)) throw new Error('Embedding provider returned an invalid result')
  return index.chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(chunk.vector, queryVector) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ chunk, score }) => ({
      knowledgeBaseId: knowledgeBase.id,
      knowledgeBaseName: knowledgeBase.name,
      sourcePath: join(knowledgeBase.source.path, ...chunk.relativePath.split('/')),
      relativePath: chunk.relativePath,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      content: chunk.content,
      score,
    }))
}

export async function searchKnowledgeBases(knowledgeBases: KnowledgeBase[], query: string, limit?: number, signal?: AbortSignal): Promise<KnowledgeBaseSearchResult[]> {
  const normalizedQuery = query.trim()
  if (!normalizedQuery || normalizedQuery.length > 1_000) throw new Error('Enter a knowledge base query between 1 and 1000 characters')
  const resultLimit = normalizedLimit(limit)
  const results: KnowledgeBaseSearchResult[] = []
  for (const knowledgeBase of knowledgeBases) {
    if (signal?.aborted) throw new Error('Knowledge base search was stopped')
    if (knowledgeBase.status !== 'ready') throw new Error(`Knowledge base "${knowledgeBase.name}" is not ready`)
    const remaining = resultLimit - results.length
    if (remaining <= 0) break
    const matches = knowledgeBase.mode === 'rg'
      ? await searchWithRipgrep(knowledgeBase, normalizedQuery, remaining, signal)
      : await searchWithRag(knowledgeBase, normalizedQuery, remaining, signal)
    results.push(...matches)
  }
  return results
}

export function createKnowledgeBaseTools(knowledgeBases: KnowledgeBase[]): object[] {
  if (knowledgeBases.length === 0) return []
  return [{
    type: 'function',
    function: {
      name: 'search_knowledge_bases',
      description: 'Search only the local knowledge bases explicitly enabled by the user for this request. The configured rg or RAG mode is used exactly; modes are never switched automatically.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'The text or semantic query.' },
          knowledge_base_ids: {
            type: 'array',
            items: { type: 'string', enum: knowledgeBases.map((item) => item.id) },
            description: 'Optional subset of enabled knowledge base ids.',
          },
          limit: { type: 'integer', minimum: 1, maximum: maximumSearchLimit },
        },
        required: ['query'],
      },
    },
  }]
}

export function knowledgeBaseInstructions(knowledgeBases: KnowledgeBase[]): string {
  if (knowledgeBases.length === 0) return ''
  const list = knowledgeBases.map((item) => `- ${item.name} (${item.id}, mode: ${item.mode})`).join('\n')
  return `The user explicitly enabled these local knowledge bases for this request:\n${list}\nUse search_knowledge_bases when their contents are relevant. You cannot enable, disable, create, remove, or change a knowledge base or its search mode.`
}

export async function runKnowledgeBaseTool(knowledgeBases: KnowledgeBase[], toolCall: { function: { name: string; arguments: string } }, signal?: AbortSignal): Promise<string | undefined> {
  if (toolCall.function.name !== 'search_knowledge_bases') return undefined
  let args: { query?: unknown; knowledge_base_ids?: unknown; limit?: unknown }
  try {
    args = JSON.parse(toolCall.function.arguments || '{}')
  } catch {
    throw new Error('Knowledge base tool arguments must be valid JSON')
  }
  if (typeof args.query !== 'string') throw new Error('Knowledge base query is required')
  const requestedIds = Array.isArray(args.knowledge_base_ids)
    ? args.knowledge_base_ids.filter((id): id is string => typeof id === 'string')
    : knowledgeBases.map((item) => item.id)
  const allowed = new Set(knowledgeBases.map((item) => item.id))
  if (requestedIds.some((id) => !allowed.has(id))) throw new Error('Knowledge base is not enabled for this request')
  const selected = knowledgeBases.filter((item) => requestedIds.includes(item.id))
  const results = await searchKnowledgeBases(selected, args.query, typeof args.limit === 'number' ? args.limit : undefined, signal)
  return JSON.stringify({ results })
}
