import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => name === 'logs' ? '.agent_tmp/test-logs/model-failover' : '.',
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
  // Fail during body consumption, after the optional first SSE event.
  function terminatedResponse(partial: boolean): Response {
    let sent = false
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (partial && !sent) {
          sent = true
          controller.enqueue(new TextEncoder().encode(PARTIAL_THEN_DIE[0]!))
        } else {
          controller.error(new TypeError('terminated'))
        }
      },
    }), { headers: { 'content-type': 'text/event-stream' } })
  }

  const temporaryMessage = '服务暂时不可用。 原因：上游服务、网络链路或代理返回异常响应。 解决方案：请稍后重试。'
  const fixedMerchantMessage = '固定商家当前不可用。 原因：您固定的商家当前处于繁忙、冷却、不可用或能力不匹配状态。 解决方案：请在模型市场切换固定商家，或开启智能路由/兜底后重试。 request_id: 202610110739383742285098268d9d6qrdASxzO'
  const providerOutages = [temporaryMessage, fixedMerchantMessage, 'Arbitrary new vendor wording 93817']
  const transientResponses = [
    { name: 'terminated', response: terminatedResponse },
    { name: 'provider temporary outage', response: (partial: boolean) => sseResponse([
      ...(partial ? PARTIAL_THEN_DIE : []),
      'data: ' + JSON.stringify({ error: { message: temporaryMessage } }) + '\n\n',
    ]) },
    { name: 'fixed merchant unavailable', response: (partial: boolean) => sseResponse([
      ...(partial ? PARTIAL_THEN_DIE : []),
      'data: ' + JSON.stringify({ error: { message: fixedMerchantMessage } }) + '\n\n',
    ]) },
    { name: 'unknown provider error', response: (partial: boolean) => sseResponse([
      ...(partial ? PARTIAL_THEN_DIE : []),
      'data: {"error":{"message":"Arbitrary new vendor wording 93817","code":"unrecognized_code"}}\n\n',
    ]) },
    { name: 'malformed SSE JSON', response: (partial: boolean) => sseResponse([
      ...(partial ? PARTIAL_THEN_DIE : []), 'data: {broken\n\n',
    ]) },
    { name: 'provider error type', response: (partial: boolean) => sseResponse([
      ...(partial ? PARTIAL_THEN_DIE : []),
      'data: ' + JSON.stringify({ error: { message: 'Provider failed', type: 'server_error' } }) + '\n\n',
    ]) },
  ]

  it.each(transientResponses)('retries $name on the same model before output', async ({ response }) => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    const events: string[] = []
    globalThis.fetch = vi.fn(async (url: unknown) => {
      calls.push(String(url))
      return calls.length === 1 ? response(false) : sseResponse([DONE_CHUNK])
    }) as typeof fetch
    try {
      const result = await requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')]),
        messages, [], undefined, undefined, undefined, undefined, (event) => events.push(event.kind),
      )
      expect(result.choices?.[0]?.message?.content).toBe('ok')
      expect(calls).toHaveLength(2)
      expect(calls.every((url) => url.includes('primary'))).toBe(true)
      expect(events).toEqual(['failure', 'retry'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it.each(transientResponses)('exhausts retries for $name after partial output, then fails over', async ({ response }) => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    const events: string[] = []
    globalThis.fetch = vi.fn(async (url: unknown) => {
      calls.push(String(url))
      return String(url).includes('primary') ? response(true) : sseResponse([DONE_CHUNK])
    }) as typeof fetch
    try {
      const result = await requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')], 3),
        messages, [], undefined, undefined, undefined, undefined, (event) => events.push(event.kind),
      )
      expect(result.choices?.[0]?.message?.content).toBe('ok')
      expect(calls.filter((url) => url.includes('primary'))).toHaveLength(4)
      expect(calls.filter((url) => url.includes('backup'))).toHaveLength(1)
      expect(events).toEqual(['failure', 'retry', 'failure', 'retry', 'failure', 'retry', 'failure', 'failover'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('retries a nested transport error code through completion wrappers', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn()
      .mockRejectedValueOnce(new Error('Request failed', { cause: { code: 'UND_ERR_SOCKET' } }))
      .mockResolvedValueOnce(sseResponse([DONE_CHUNK]))
    try {
      const result = await requestCompletion(target([member('https://primary.example.com/v1', 'primary')]), messages, [])
      expect(result.choices?.[0]?.message?.content).toBe('ok')
      expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it.each(providerOutages)('routes HTTP 200 JSON provider errors through retry and failover: %s', async (message) => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (url: unknown) => {
      calls.push(String(url))
      return String(url).includes('primary')
        ? new Response(JSON.stringify({ error: { message } }), { status: 200 })
        : sseResponse([DONE_CHUNK])
    }) as typeof fetch
    try {
      const result = await requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')], 2), messages, [],
      )
      expect(result.choices?.[0]?.message?.content).toBe('ok')
      expect(calls.filter((url) => url.includes('primary'))).toHaveLength(3)
      expect(calls.filter((url) => url.includes('backup'))).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it.each([401, 403].flatMap((status) => providerOutages.map((message) => ({ status, message }))))('exhausts retries for HTTP $status regardless of wording: $message', async ({ status, message }) => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (url: unknown) => {
      calls.push(String(url))
      return String(url).includes('primary')
        ? new Response(JSON.stringify({ error: { message } }), { status })
        : sseResponse([DONE_CHUNK])
    }) as typeof fetch
    try {
      await requestCompletion(target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')]), messages, [])
      expect(calls.filter((url) => url.includes('primary'))).toHaveLength(4)
      expect(calls.filter((url) => url.includes('backup'))).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('never retries or fails over after user cancellation, even for terminated', async () => {
    const originalFetch = globalThis.fetch
    const controller = new AbortController()
    const events: string[] = []
    globalThis.fetch = vi.fn(async () => {
      controller.abort()
      throw new TypeError('terminated')
    }) as typeof fetch
    try {
      await expect(requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')]),
        messages, [], undefined, controller.signal, undefined, undefined, (event) => events.push(event.kind),
      )).rejects.toThrow('Operation stopped')
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
      expect(events).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('makes the initial request plus configured retries before switching members', async () => {
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
      expect(calls.filter((url) => url.includes('primary'))).toHaveLength(4)
      expect(calls.filter((url) => url.includes('backup'))).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('exhausts retries even for authentication failures', async () => {
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
      expect(calls.filter((url) => url.includes('primary'))).toHaveLength(4)
      expect(calls.filter((url) => url.includes('backup'))).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('exhausts every member for an unknown in-stream error after partial output', async () => {
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
      // Even unknown errors exhaust the full budget of every member.
      expect(calls.filter((url) => url.includes('backup'))).toHaveLength(4)
      expect(calls.filter((url) => url.includes('primary'))).toHaveLength(4)
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
      expect(calls.filter((url) => url.includes('primary'))).toHaveLength(3)
      expect(calls.filter((url) => url.includes('backup'))).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it.each([
    { name: 'complete SSE', response: () => sseResponse([DONE_CHUNK]) },
    { name: 'complete JSON', response: () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })) },
    { name: 'complete tool call', response: () => sseResponse(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"file_read","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n']) },
  ])('returns $name without retry or failover', async ({ response }) => {
    const originalFetch = globalThis.fetch
    const events: string[] = []
    globalThis.fetch = vi.fn(async () => response()) as typeof fetch
    try {
      const result = await requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')]),
        messages, [], undefined, undefined, undefined, undefined, (event) => events.push(event.kind),
      )
      expect(result.choices?.[0]?.message).toBeDefined()
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
      expect(events).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it.each([
    { name: 'empty JSON', response: () => new Response('{}') },
    { name: 'empty message', response: () => new Response('{"choices":[{"message":{}}]}') },
    { name: 'invalid JSON', response: () => new Response('<html>proxy changed its response</html>') },
    { name: 'empty SSE', response: () => sseResponse(['data: [DONE]\n\n']) },
    { name: 'missing SSE end', response: () => sseResponse(PARTIAL_THEN_DIE) },
  ])('retries $name and succeeds on the last allowed attempt', async ({ response }) => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = vi.fn(async () => ++calls < 3 ? response() : sseResponse([DONE_CHUNK])) as typeof fetch
    try {
      const result = await requestCompletion(target([member('https://primary.example.com/v1', 'primary')], 2), messages, [])
      expect(result.choices?.[0]?.message?.content).toBe('ok')
      expect(calls).toBe(3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('uses the same retry budget for requests with images', async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (url: unknown) => {
      calls.push(String(url))
      if (String(url).includes('primary')) throw new Error('Unknown image provider failure')
      return sseResponse([DONE_CHUNK])
    }) as typeof fetch
    try {
      const result = await requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')], 2),
        [{ ...messages[0], images: [{ id: 'image', name: 'test.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' }] }], [],
      )
      expect(result.choices?.[0]?.message?.content).toBe('ok')
      expect(calls.map((url) => url.includes('primary') ? 'primary' : 'backup')).toEqual(['primary', 'primary', 'primary', 'backup'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it.each([new Error('Unknown failure'), null, 'vendor changed this string'])('exhausts all members for any thrown failure: %s', async (failure) => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (url: unknown) => { calls.push(String(url)); throw failure }) as typeof fetch
    try {
      await expect(requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')], 2), messages, [],
      )).rejects.toThrow('All models in the chain failed (primary → backup)')
      expect(calls.map((url) => url.includes('primary') ? 'primary' : 'backup')).toEqual(['primary', 'primary', 'primary', 'backup', 'backup', 'backup'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('retries timeouts and fails over after the timeout budget is exhausted', async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    vi.useFakeTimers()
    globalThis.fetch = vi.fn((url: unknown, init?: RequestInit) => {
      calls.push(String(url))
      if (String(url).includes('backup')) return Promise.resolve(sseResponse([DONE_CHUNK]))
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('No response')), { once: true })
      })
    }) as typeof fetch
    try {
      const pending = requestCompletion(target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')], 1), messages, [])
      await vi.advanceTimersByTimeAsync(360_000)
      expect((await pending).choices?.[0]?.message?.content).toBe('ok')
      expect(calls.map((url) => url.includes('primary') ? 'primary' : 'backup')).toEqual(['primary', 'primary', 'backup'])
    } finally {
      vi.useRealTimers()
      globalThis.fetch = originalFetch
    }
  })

  it('stops cancellation during a retry before trying any other member', async () => {
    const originalFetch = globalThis.fetch
    const controller = new AbortController()
    const events: string[] = []
    globalThis.fetch = vi.fn(async () => { throw new Error('Unknown error') }) as typeof fetch
    try {
      await expect(requestCompletion(
        target([member('https://primary.example.com/v1', 'primary'), member('https://backup.example.com/v1', 'backup')]),
        messages, [], undefined, controller.signal, undefined, undefined, (event) => {
          events.push(event.kind)
          if (event.kind === 'retry') controller.abort()
        },
      )).rejects.toThrow('Operation stopped')
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
      expect(events).toEqual(['failure', 'retry'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
