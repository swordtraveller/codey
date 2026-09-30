import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearModelCatalogCache,
  fetchModelCapabilities,
  findModelCapabilities,
} from '../src/main/model-capabilities'

const catalog = {
  anthropic: {
    models: {
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        limit: { context: 1_000_000, output: 64_000 },
        modalities: { input: ['text', 'image', 'pdf'] },
      },
    },
  },
  openai: {
    models: {
      'gpt-4o': {
        id: 'gpt-4o',
        limit: { context: 128_000, output: 16_384 },
        modalities: { input: ['text', 'image', 'pdf'] },
      },
      'gpt-4o-audio-preview': {
        id: 'gpt-4o-audio-preview',
        limit: { context: 128_000 },
        modalities: { input: ['text', 'audio', 'video'] },
      },
    },
  },
  mirror: {
    models: {
      'gpt-4o': {
        id: 'gpt-4o',
        limit: { context: 999 },
        modalities: { input: ['text'] },
      },
    },
  },
  minimal: {
    models: {
      'bare-model': { id: 'bare-model' },
    },
  },
}

describe('models.dev capability lookup', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    clearModelCatalogCache()
  })

  it('maps a model entry to context, output, and modality capabilities', () => {
    expect(findModelCapabilities(catalog, 'claude-sonnet-4-5')).toEqual({
      maxContextTokens: 1_000_000,
      maxOutputTokens: 64_000,
      image: true,
      pdf: true,
      video: false,
      audio: false,
    })
  })

  it('matches model names case-insensitively', () => {
    expect(findModelCapabilities(catalog, '  Claude-Sonnet-4-5 ')?.maxContextTokens).toBe(1_000_000)
  })

  it('prefers the provider when the name is provider-prefixed', () => {
    expect(findModelCapabilities(catalog, 'mirror/gpt-4o')?.maxContextTokens).toBe(999)
    expect(findModelCapabilities(catalog, 'openai/gpt-4o')?.maxContextTokens).toBe(128_000)
  })

  it('requires an exact model id match', () => {
    expect(findModelCapabilities(catalog, 'gpt-4o')?.maxOutputTokens).toBe(16_384)
    const audioPreview = findModelCapabilities(catalog, 'gpt-4o-audio-preview')
    expect(audioPreview?.audio).toBe(true)
    expect(audioPreview?.video).toBe(true)
    expect(audioPreview?.maxOutputTokens).toBeUndefined()
  })

  it('tolerates models without limits or modalities', () => {
    expect(findModelCapabilities(catalog, 'bare-model')).toEqual({
      maxContextTokens: undefined,
      maxOutputTokens: undefined,
      image: false,
      pdf: false,
      video: false,
      audio: false,
    })
  })

  it('returns null for unknown or empty names', () => {
    expect(findModelCapabilities(catalog, 'unknown-model')).toBeNull()
    expect(findModelCapabilities(catalog, '  ')).toBeNull()
    expect(findModelCapabilities(null, 'gpt-4o')).toBeNull()
  })

  it('returns ok capabilities from a fetched catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 })))
    await expect(fetchModelCapabilities('claude-sonnet-4-5')).resolves.toEqual({
      status: 'ok',
      maxContextTokens: 1_000_000,
      maxOutputTokens: 64_000,
      image: true,
      pdf: true,
      video: false,
      audio: false,
    })
  })

  it('returns not-found for an absent model without calling the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchModelCapabilities('  ')).resolves.toEqual({ status: 'not-found' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns network-error when the catalog request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    await expect(fetchModelCapabilities('gpt-4o')).resolves.toEqual({ status: 'network-error' })
  })

  it('returns network-error on a non-200 catalog response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })))
    await expect(fetchModelCapabilities('gpt-4o')).resolves.toEqual({ status: 'network-error' })
  })

  it('caches the catalog between lookups', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchModelCapabilities('gpt-4o')
    const second = await fetchModelCapabilities('bare-model')
    expect(second).toMatchObject({ status: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
