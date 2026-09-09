import { afterEach, describe, expect, it, vi } from 'vitest'
import { testModelConnectivity } from '../src/main/model-connectivity'
import { defaultModelConfig } from '../src/shared/types'

function model(overrides: Partial<typeof defaultModelConfig> = {}) {
  return { ...defaultModelConfig, baseUrl: 'https://api.example.com/v1', apiKey: 'key', modelName: 'glm-5.3', ...overrides }
}

function modelsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })
}

describe('model connectivity probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports ok when the model is listed (case-insensitive)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => modelsResponse(['gpt-4o', 'GLM-5.3'])))
    await expect(testModelConnectivity(model())).resolves.toEqual({ status: 'ok', models: 2 })
  })

  it('reports auth errors for 401/403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401 })))
    await expect(testModelConnectivity(model())).resolves.toMatchObject({ status: 'auth-error' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })))
    await expect(testModelConnectivity(model())).resolves.toMatchObject({ status: 'auth-error' })
  })

  it('reports model-not-found with a bounded sample of available ids', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => modelsResponse(['a', 'b', 'c'])))
    await expect(testModelConnectivity(model())).resolves.toEqual({
      status: 'model-not-found',
      available: ['a', 'b', 'c'],
    })
    const many = Array.from({ length: 50 }, (_, index) => `model-${index}`)
    vi.stubGlobal('fetch', vi.fn(async () => modelsResponse(many)))
    const result = await testModelConnectivity(model())
    expect(result.status).toBe('model-not-found')
    if (result.status === 'model-not-found') expect(result.available).toHaveLength(20)
  })

  it('reports network errors when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    await expect(testModelConnectivity(model())).resolves.toMatchObject({ status: 'network-error' })
  })

  it('reports endpoint errors for non-auth HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await expect(testModelConnectivity(model())).resolves.toMatchObject({ status: 'endpoint-error', detail: 'HTTP 500' })
  })
})
