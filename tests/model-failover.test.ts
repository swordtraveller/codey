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

  it('does not retry a non-retryable in-stream error after partial output', async () => {
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
      // An unclassified stream error does not retry or fail over.
      expect(calls.filter((url) => url.includes('backup'))).toHaveLength(0)
      expect(calls.filter((url) => url.includes('primary'))).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('retries an interrupted partial stream once and discards the failed attempt', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      return calls === 1
        ? sseResponse(['data: {"choices":[{"delta":{"content":"draft"}}]}\n\n'])
        : sseResponse([DONE_CHUNK])
    }) as typeof fetch
    const events: string[] = []
    const updates: string[] = []
    try {
      const response = await requestCompletion(
        target([member('https://primary.example.com/v1', 'primary')], 1), messages, [],
        (message) => updates.push(message.content ?? ''), undefined, undefined, undefined,
        (event) => events.push(event.kind),
      )
      expect(response.choices?.[0]?.message?.content).toBe('ok')
      expect(calls).toBe(2)
      expect(updates).toContain('draft')
      expect(updates).toContain('ok')
      expect(events).toEqual(['failure', 'retry'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('fails over after a partial retry fails and reports every transition', async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (url: unknown) => {
      calls.push(String(url))
      return String(url).includes('primary')
        ? sseResponse(['data: {"choices":[{"delta":{"content":"draft"}}]}\n\n'])
        : sseResponse([DONE_CHUNK])
    }) as typeof fetch
    const events: string[] = []
    try {
      const response = await requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')], 1),
        messages, [], undefined, undefined, undefined, undefined,
        (event) => events.push(event.kind),
      )
      expect(response.choices?.[0]?.message?.content).toBe('ok')
      expect(calls.filter((url) => url.includes('primary'))).toHaveLength(2)
      expect(calls.filter((url) => url.includes('backup'))).toHaveLength(1)
      expect(events).toEqual(['failure', 'retry', 'failure', 'failover'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not accept a truncated tool call without [DONE]', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write_file","arguments":"{"}}]}}]}\n\n',
    ])) as typeof fetch
    try {
      await expect(requestCompletion(target([member('https://primary.example.com/v1', 'primary')], 1), messages, []))
        .rejects.toThrow('SSE stream ended before [DONE]')
      expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it.each([429, 503])('retries a partial stream reporting status %i', async (status) => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      return calls === 1
        ? sseResponse([
          'data: {"choices":[{"delta":{"content":"draft"}}]}\n\n',
          `data: {"error":{"message":"upstream busy","code":"${status}"}}\n\n`,
        ])
        : sseResponse([DONE_CHUNK])
    }) as typeof fetch
    try {
      const result = await requestCompletion(target([member('https://primary.example.com/v1', 'primary')], 1), messages, [])
      expect(result.choices?.[0]?.message?.content).toBe('ok')
      expect(calls).toBe(2)
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
