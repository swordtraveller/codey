import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => '.',
  },
}))
import type { ModelChainMember, RuntimeModelConfig } from '../src/shared/types'
import { requestCompletion } from '../src/main/agent'

function member(baseUrl: string, label: string): ModelChainMember {
  return { modelId: label, label, baseUrl, apiKey: 'key', modelName: `${label}-model` }
}

function target(members: ModelChainMember[], retriesPerModel = 3): RuntimeModelConfig {
  const first = members[0]!
  return {
    id: 'target',
    name: 'target',
    baseUrl: first.baseUrl,
    apiKey: first.apiKey,
    modelName: first.modelName,
    modelMaxContext: 128_000,
    chain: members,
    retriesPerModel,
  }
}

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const DONE_CHUNK = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
const PARTIAL_THEN_DIE: string[] = [
  'data: {"choices":[{"delta":{"content":"partial "}}]}\n\n',
]

const messages = [{ role: 'user' as const, content: 'hi' }]

describe('model chain failover', () => {
  it('retries a failing member up to retriesPerModel, then succeeds on the next member', async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const endpoint = String(url)
      calls.push(endpoint)
      if (endpoint.includes('primary')) throw new TypeError('fetch failed')
      return sseResponse([DONE_CHUNK])
    }) as typeof fetch
    try {
      const response = await requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')]),
        messages,
        [],
      )
      expect(response.choices?.[0]?.message?.content).toBe('ok')
      expect(calls.filter((url) => url.includes('primary'))).toHaveLength(3)
      expect(calls.filter((url) => url.includes('backup'))).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('fails over immediately on definitive status codes without exhausting retries', async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const endpoint = String(url)
      calls.push(endpoint)
      if (endpoint.includes('primary')) return new Response('{"error":{"message":"bad key"}}', { status: 401 })
      return sseResponse([DONE_CHUNK])
    }) as typeof fetch
    try {
      const response = await requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')]),
        messages,
        [],
      )
      expect(response.choices?.[0]?.message?.content).toBe('ok')
      expect(calls.filter((url) => url.includes('primary'))).toHaveLength(1)
      expect(calls.filter((url) => url.includes('backup'))).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not fail over once output has streamed', async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const endpoint = String(url)
      calls.push(endpoint)
      // Content streams first, then an in-stream error event fails the
      // request mid-flight with output already visible.
      return sseResponse([
        PARTIAL_THEN_DIE[0]!,
        'data: ' + JSON.stringify({ error: { message: 'mid-stream boom' } }),
      ])
    }) as typeof fetch
    try {
      await expect(requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')]),
        messages,
        [],
      )).rejects.toThrow()
      // Only the primary member was contacted; the backup never saw a request.
      expect(calls.filter((url) => url.includes('backup'))).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reports the exhausted chain when every member fails', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    try {
      await expect(requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')], 2),
        messages,
        [],
      )).rejects.toThrow('All models in the chain failed (primary → backup)')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('retries 5xx responses on the same member before failing over', async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const endpoint = String(url)
      calls.push(endpoint)
      if (endpoint.includes('primary')) return new Response('overloaded', { status: 503 })
      return sseResponse([DONE_CHUNK])
    }) as typeof fetch
    try {
      const response = await requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')], 2),
        messages,
        [],
      )
      expect(response.choices?.[0]?.message?.content).toBe('ok')
      expect(calls.filter((url) => url.includes('primary'))).toHaveLength(2)
      expect(calls.filter((url) => url.includes('backup'))).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
