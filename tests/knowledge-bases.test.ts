import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: () => '.',
  },
  net: {
    fetch: undefined,
  },
}))

import {
  chunkDocument,
  cosineSimilarity,
  configureTransformersEnvironment,
  normalizeHuggingFaceEndpoint,
  createKnowledgeBase,
  listKnowledgeBases,
  loadSupportedDocuments,
  normalizeKnowledgeBaseRegistry,
  removeKnowledgeBase,
  resolveUnpackedExecutablePath,
  resolveKnowledgeBaseSelection,
  searchKnowledgeBases,
  setEmbeddingProviderFactoryForTests,
  setKnowledgeBaseRootForTests,
  updateKnowledgeBase,
  type EmbeddingProvider,
} from '../src/main/knowledge-bases'
import { defaultLocalEmbeddingModelId } from '../src/shared/types'
import type { LocalEmbeddingProviderConfig } from '../src/shared/types'

let sandboxPath = ''
let sourcePath = ''

function localProvider(): LocalEmbeddingProviderConfig {
  return { kind: 'local', modelId: defaultLocalEmbeddingModelId }
}

function useFakeEmbeddingProvider(
  embed: (texts: string[]) => Promise<number[][]>,
  prepare: EmbeddingProvider['prepare'] = async () => undefined,
): void {
  setEmbeddingProviderFactoryForTests(() => ({
    id: 'fake-local',
    prepare,
    embed,
  }))
}

beforeEach(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), 'codey-knowledge-bases-'))
  sourcePath = join(sandboxPath, 'source')
  await mkdir(sourcePath, { recursive: true })
  setKnowledgeBaseRootForTests(join(sandboxPath, 'state'))
})

afterEach(async () => {
  setEmbeddingProviderFactoryForTests(null)
  setKnowledgeBaseRootForTests(null)
  await rm(sandboxPath, { recursive: true, force: true })
})

describe('embedding model configuration', () => {
  it('normalizes a custom Hugging Face endpoint', async () => {
    expect(normalizeHuggingFaceEndpoint('https://example.test///')).toBe('https://example.test/')
    expect(normalizeHuggingFaceEndpoint('')).toBe('https://huggingface.co/')
  })

  it('uses the writable knowledge-base model cache for Transformers.js', () => {
    const transformers = { env: {} as { cacheDir?: string; remoteHost?: string; fetch?: (...args: any[]) => Promise<any> } }
    configureTransformersEnvironment(transformers)
    expect(transformers.env.cacheDir).toBe(join(sandboxPath, 'state', 'models'))
  })
})
describe('local knowledge base documents', () => {
  it('loads only TXT and Markdown files while ignoring future formats', async () => {
    await mkdir(join(sourcePath, 'nested'))
    await Promise.all([
      writeFile(join(sourcePath, 'notes.txt'), 'plain text', 'utf8'),
      writeFile(join(sourcePath, 'README.md'), '# Markdown', 'utf8'),
      writeFile(join(sourcePath, 'nested', 'UPPER.TXT'), 'upper case extension', 'utf8'),
      writeFile(join(sourcePath, 'ignored.markdown'), '# Not supported', 'utf8'),
      writeFile(join(sourcePath, 'document.pdf'), 'fake pdf', 'utf8'),
      writeFile(join(sourcePath, 'image.png'), 'fake image', 'utf8'),
      writeFile(join(sourcePath, 'slides.pptx'), 'fake slides', 'utf8'),
      writeFile(join(sourcePath, 'document.docx'), 'fake document', 'utf8'),
    ])

    const { documents, totalBytes } = await loadSupportedDocuments(sourcePath)

    expect(documents.map((document) => document.relativePath).sort()).toEqual([
      'README.md',
      'nested/UPPER.TXT',
      'notes.txt',
    ].sort())
    expect(totalBytes).toBe(Buffer.byteLength('plain text# Markdownupper case extension'))
  })

  it('preserves relative paths and line ranges when chunking', () => {
    const chunks = chunkDocument({
      sourcePath: join(sourcePath, 'guide.md'),
      relativePath: 'guide.md',
      text: 'line one\nline two\nline three\nline four',
    }, 18, 0)

    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toMatchObject({ relativePath: 'guide.md', lineStart: 1, lineEnd: 2 })
    expect(chunks[1]).toMatchObject({ relativePath: 'guide.md', lineStart: 3, lineEnd: 3 })
    expect(chunks[2]).toMatchObject({ relativePath: 'guide.md', lineStart: 4, lineEnd: 4 })
  })

  it('keeps source line numbers when a document starts with blank lines', () => {
    const chunks = chunkDocument({
      sourcePath: join(sourcePath, 'guide.md'),
      relativePath: 'guide.md',
      text: '\r\n\r\n# Heading\r\nDetails',
    }, 200, 0)

    expect(chunks).toEqual([expect.objectContaining({
      relativePath: 'guide.md',
      lineStart: 3,
      lineEnd: 4,
      content: '# Heading\nDetails',
    })])
  })

  it('maps packaged executable paths to app.asar.unpacked', () => {
    expect(resolveUnpackedExecutablePath('C:\\Codey\\resources\\app.asar\\node_modules\\@vscode\\ripgrep\\rg.exe'))
      .toBe('C:\\Codey\\resources\\app.asar.unpacked\\node_modules\\@vscode\\ripgrep\\rg.exe')
    expect(resolveUnpackedExecutablePath('/opt/codey/resources/app.asar/node_modules/rg'))
      .toBe('/opt/codey/resources/app.asar.unpacked/node_modules/rg')
    expect(resolveUnpackedExecutablePath('C:\\dev\\node_modules\\rg.exe'))
      .toBe('C:\\dev\\node_modules\\rg.exe')
  })
})

describe('knowledge base registry and selection', () => {
  it('applies global, project, and conversation selection overrides in order', () => {
    expect(resolveKnowledgeBaseSelection(
      ['global-a', 'global-b'],
      { enabledIds: ['project-c'], disabledIds: ['global-a'] },
      { enabledIds: ['global-a'], disabledIds: ['global-b', 'project-c'] },
    )).toEqual(['global-a'])
  })

  it('normalizes registry entries, drops invalid and duplicate ids, and defaults legacy RAG providers', () => {
    const now = '2026-09-17T00:00:00.000Z'
    const normalized = normalizeKnowledgeBaseRegistry({
      version: 99,
      knowledgeBases: [
        {
          id: 'valid-id',
          name: '',
          source: { kind: 'local-directory', path: sourcePath },
          mode: 'rag',
          embeddingProvider: null,
          status: 'unexpected',
          fileCount: -1,
          totalBytes: 'bad',
          createdAt: now,
          updatedAt: now,
          indexedAt: false,
        },
        { id: 'valid-id', source: { kind: 'local-directory', path: sourcePath } },
        { id: '../escape', source: { kind: 'local-directory', path: sourcePath } },
        { id: 'relative', source: { kind: 'local-directory', path: 'relative/path' } },
      ],
    })

    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      id: 'valid-id',
      name: 'source',
      mode: 'rag',
      embeddingProvider: localProvider(),
      status: 'ready',
      fileCount: 0,
      totalBytes: 0,
      indexedAt: null,
    })
    expect(normalized[0].source.path).toBe(resolve(sourcePath))
  })
})

describe('rg knowledge bases', () => {
  it('returns relative paths and line numbers from exact text search', async () => {
    await mkdir(join(sourcePath, 'nested'))
    await writeFile(join(sourcePath, 'nested', 'facts.md'), 'first line\nexact needle here\nlast line', 'utf8')
    await writeFile(join(sourcePath, 'ignored.markdown'), 'exact needle in unsupported file', 'utf8')
    const knowledgeBase = await createKnowledgeBase({
      name: 'Facts',
      directoryPath: sourcePath,
      mode: 'rg',
    })

    const results = await searchKnowledgeBases([knowledgeBase], 'exact needle')

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      knowledgeBaseId: knowledgeBase.id,
      relativePath: 'nested/facts.md',
      lineStart: 2,
      lineEnd: 2,
      content: 'exact needle here',
    })
  })

  it('searches uppercase TXT and MD extensions without including .markdown files', async () => {
    await writeFile(join(sourcePath, 'UPPER.TXT'), 'uppercase txt needle', 'utf8')
    await writeFile(join(sourcePath, 'GUIDE.MD'), 'uppercase md needle', 'utf8')
    await writeFile(join(sourcePath, 'ignored.markdown'), 'uppercase markdown needle', 'utf8')
    const knowledgeBase = await createKnowledgeBase({ directoryPath: sourcePath, mode: 'rg' })

    const txtResults = await searchKnowledgeBases([knowledgeBase], 'uppercase txt needle')
    const mdResults = await searchKnowledgeBases([knowledgeBase], 'uppercase md needle')
    const ignoredResults = await searchKnowledgeBases([knowledgeBase], 'uppercase markdown needle')

    expect(txtResults.map((result) => result.relativePath)).toEqual(['UPPER.TXT'])
    expect(mdResults.map((result) => result.relativePath)).toEqual(['GUIDE.MD'])
    expect(ignoredResults).toEqual([])
  })

  it('removes registry and index data without deleting the source directory', async () => {
    const sourceFile = join(sourcePath, 'keep.txt')
    await writeFile(sourceFile, 'keep me', 'utf8')
    const knowledgeBase = await createKnowledgeBase({ directoryPath: sourcePath, mode: 'rg' })

    await removeKnowledgeBase(knowledgeBase.id)

    expect(await listKnowledgeBases()).toEqual([])
    expect(await readFile(sourceFile, 'utf8')).toBe('keep me')
  })
})

describe('RAG knowledge bases', () => {
  it('requires an explicit embedding provider when creating RAG knowledge bases', async () => {
    await writeFile(join(sourcePath, 'facts.txt'), 'facts', 'utf8')

    await expect(createKnowledgeBase({ directoryPath: sourcePath, mode: 'rag' }))
      .rejects.toThrow('RAG knowledge base requires an embedding provider')
    expect(await listKnowledgeBases()).toEqual([])
  })

  it('builds a fake local index and ranks chunks by cosine similarity', async () => {
    await writeFile(join(sourcePath, 'apples.txt'), 'apple orchard facts', 'utf8')
    await writeFile(join(sourcePath, 'bananas.txt'), 'banana plantation facts', 'utf8')
    useFakeEmbeddingProvider(async (texts) => texts.map((text) => text.includes('apple') ? [1, 0] : [0, 1]))

    const knowledgeBase = await createKnowledgeBase({
      name: 'Fruit',
      directoryPath: sourcePath,
      mode: 'rag',
      embeddingProvider: localProvider(),
    })
    const results = await searchKnowledgeBases([knowledgeBase], 'apple question', 2)

    expect(results.map((result) => result.relativePath)).toEqual(['apples.txt', 'bananas.txt'])
    expect(results[0].score).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })

  it('reuses the local embedding provider for indexing and search', async () => {
    await writeFile(join(sourcePath, 'facts.txt'), 'facts', 'utf8')
    let factoryCalls = 0
    setEmbeddingProviderFactoryForTests(() => {
      factoryCalls += 1
      return {
        id: 'cached-local',
        prepare: async () => undefined,
        embed: async (texts) => texts.map(() => [1, 0]),
      }
    })

    const knowledgeBase = await createKnowledgeBase({
      directoryPath: sourcePath,
      mode: 'rag',
      embeddingProvider: localProvider(),
    })
    await searchKnowledgeBases([knowledgeBase], 'facts')

    expect(factoryCalls).toBe(1)
  })

  it('stops a RAG search after an abort is requested', async () => {
    await writeFile(join(sourcePath, 'facts.txt'), 'facts', 'utf8')
    let releaseSearch: (() => void) | undefined
    let embedCalls = 0
    useFakeEmbeddingProvider(async (texts) => {
      embedCalls += 1
      if (embedCalls > 1) {
        await new Promise<void>((resolvePromise) => {
          releaseSearch = resolvePromise
        })
      }
      return texts.map(() => [1, 0])
    })

    const knowledgeBase = await createKnowledgeBase({
      directoryPath: sourcePath,
      mode: 'rag',
      embeddingProvider: localProvider(),
    })
    const controller = new AbortController()
    const search = searchKnowledgeBases([knowledgeBase], 'facts', undefined, controller.signal)
    const expectedFailure = expect(search).rejects.toThrow('Knowledge base search was stopped')
    await vi.waitFor(() => expect(releaseSearch).toBeTypeOf('function'))
    controller.abort()
    releaseSearch?.()

    await expectedFailure
  })

  it('keeps RAG failures visible and never falls back to rg', async () => {
    await writeFile(join(sourcePath, 'facts.txt'), 'searchable exact text', 'utf8')
    useFakeEmbeddingProvider(async () => { throw new Error('fake embedding failure') })

    await expect(createKnowledgeBase({
      directoryPath: sourcePath,
      mode: 'rag',
      embeddingProvider: localProvider(),
    })).rejects.toThrow('fake embedding failure')

    const [failed] = await listKnowledgeBases()
    expect(failed).toMatchObject({ mode: 'rag', status: 'error', error: 'fake embedding failure' })
    await expect(searchKnowledgeBases([failed], 'searchable exact text')).rejects.toThrow('is not ready')
  })

  it('preserves an error status and message when only renaming', async () => {
    await writeFile(join(sourcePath, 'facts.txt'), 'facts', 'utf8')
    useFakeEmbeddingProvider(async () => { throw new Error('index failed') })
    await expect(createKnowledgeBase({
      directoryPath: sourcePath,
      mode: 'rag',
      embeddingProvider: localProvider(),
    })).rejects.toThrow('index failed')
    const [failed] = await listKnowledgeBases()

    const renamed = await updateKnowledgeBase(failed.id, { name: 'Renamed' })

    expect(renamed).toMatchObject({ name: 'Renamed', mode: 'rag', status: 'error', error: 'index failed' })
  })

  it('rejects remote embedding providers in version 1', async () => {
    await writeFile(join(sourcePath, 'facts.txt'), 'facts', 'utf8')

    await expect(createKnowledgeBase({
      directoryPath: sourcePath,
      mode: 'rag',
      embeddingProvider: { kind: 'remote', providerId: 'future-provider', modelId: 'future-model' },
    })).rejects.toThrow('Remote embedding providers are not available in this version')
    expect(await listKnowledgeBases()).toEqual([])
  })

  it('allows a failed queued refresh to be followed by a successful refresh', async () => {
    await writeFile(join(sourcePath, 'facts.txt'), 'facts', 'utf8')
    let fail = false
    useFakeEmbeddingProvider(async (texts) => {
      if (fail) throw new Error('transient failure')
      return texts.map(() => [1, 0])
    })
    const knowledgeBase = await createKnowledgeBase({
      directoryPath: sourcePath,
      mode: 'rag',
      embeddingProvider: localProvider(),
    })
    fail = true
    const first = updateKnowledgeBase(knowledgeBase.id, { mode: 'rg' })
      .then(() => updateKnowledgeBase(knowledgeBase.id, { mode: 'rag', embeddingProvider: localProvider() }))
    await expect(first).rejects.toThrow('transient failure')
    fail = false

    const recovered = await updateKnowledgeBase(knowledgeBase.id, { mode: 'rg' })
      .then(() => updateKnowledgeBase(knowledgeBase.id, { mode: 'rag', embeddingProvider: localProvider() }))

    expect(recovered.status).toBe('ready')
  })
})
