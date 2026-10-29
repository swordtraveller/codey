import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultModelConfig, type ModelChainMember, type RuntimeModelConfig } from '../src/shared/types'
import { requestAuditVerdict } from '../src/main/command-audit'

function member(id: string, modelName = id): ModelChainMember {
  return { modelId: id, label: id, modelName, providerName: id + ' provider', baseUrl: 'https://' + id + '.example/v1/', apiKey: 'test-key' }
}
function target(chain = [member('first'), member('second')], retriesPerModel = 1): RuntimeModelConfig {
  return { ...defaultModelConfig, id: 'audit-group', chain, retriesPerModel }
}
function reply(content: string, refusal?: string): Response {
  return Response.json({ choices: [{ message: { content, refusal } }] })
}
const allow = () => reply('{"verdict":"allow"}')
const options = {
  command: 'echo checked', workspacePath: 'D:/project', environment: 'pwsh7/bare',
  timeoutSeconds: 180, durationGateSeconds: 60, sessionModelName: 'executor',
}
function pendingUntilAborted(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const abort = () => reject(new Error('aborted'))
    if (init?.signal?.aborted) abort()
    else init?.signal?.addEventListener('abort', abort, { once: true })
  })
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('command audit model groups', () => {
  it('returns the first available verdict and the actual member label', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(allow())
    vi.stubGlobal('fetch', fetchMock)
    const result = await requestAuditVerdict({ ...options, target: target() })
    expect(result).toMatchObject({ status: 'allow', modelName: 'first provider / first' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries then fails over in configured order, retaining the complete audit context', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(reply('invalid response'))
      .mockResolvedValueOnce(allow())
    vi.stubGlobal('fetch', fetchMock)
    const onStep = vi.fn()
    const result = await requestAuditVerdict({ ...options, target: target(), onStep })
    expect(result).toMatchObject({ status: 'allow', modelName: 'second provider / second' })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://first.example/v1/chat/completions', 'https://first.example/v1/chat/completions', 'https://second.example/v1/chat/completions',
    ])
    for (const [, init] of fetchMock.mock.calls) {
      const prompt = JSON.parse(init.body).messages[0].content
      for (const context of [options.command, options.workspacePath, options.environment, '180s', '60s', 'command safety auditor']) {
        expect(prompt).toContain(context)
      }
    }
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(2000)
    expect(onStep.mock.calls.map(([step]) => step.detail).join('\n')).toMatch(/HTTP 503[\s\S]*unparseable[\s\S]*switching/)
  })

  it.each([
    ['explicit denial', () => reply('{"verdict":"deny","reason":"unsafe"}')],
    ['structured refusal', () => reply('', 'unsafe')],
    ['denial with malformed reason', () => reply('{"verdict":"deny","reason":{}}')],
  ])('never retries or switches after %s', async (_label, response) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response()).mockResolvedValue(allow())
    vi.stubGlobal('fetch', fetchMock)
    expect((await requestAuditVerdict({ ...options, target: target() })).status).toBe('deny')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('skips same-name models across providers, ignoring case and whitespace', async () => {
    const fetchMock = vi.fn().mockResolvedValue(allow())
    vi.stubGlobal('fetch', fetchMock)
    const onStep = vi.fn()
    const result = await requestAuditVerdict({ ...options, target: target([member('same', ' EXECUTOR '), member('safe')]), onStep })
    expect(result.status).toBe('allow')
    expect(fetchMock.mock.calls[0][0]).toContain('safe.example')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onStep.mock.calls[0][0].detail).toContain('skipped')
  })

  it.each([{ chain: [] }, { chain: [member('same', 'executor')] }])('blocks a chain with no eligible members', async ({ chain }) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await requestAuditVerdict({ ...options, target: target(chain) })).status).toBe('unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks if the executing model cannot be identified', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await requestAuditVerdict({ ...options, sessionModelName: undefined, target: target() })).status).toBe('unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exhausts configured attempts and fails closed', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network unavailable'))
    vi.stubGlobal('fetch', fetchMock)
    expect((await requestAuditVerdict({ ...options, target: target(undefined, 2) })).status).toBe('unavailable')
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('preserves the single-model repair retry with the original safety prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply('not JSON')).mockResolvedValueOnce(allow())
    vi.stubGlobal('fetch', fetchMock)
    const result = await requestAuditVerdict({ ...options, target: { ...defaultModelConfig, modelName: 'auditor', baseUrl: 'https://single.example/v1' } })
    expect(result.status).toBe('allow')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages[0].content).toContain(options.command)
  })

  it('drops JSON mode only for explicit incompatibility and resets it on failover', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('response_format is not supported', { status: 400 }))
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(allow())
    vi.stubGlobal('fetch', fetchMock)
    expect((await requestAuditVerdict({ ...options, target: target(undefined, 0) })).status).toBe('allow')
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).response_format)).toEqual([
      { type: 'json_object' }, undefined, { type: 'json_object' },
    ])
  })

  it('does not treat authentication errors as JSON compatibility failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await requestAuditVerdict({ ...options, target: target([member('first')], 0) })).status).toBe('unavailable')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('cancels without trying another model (already aborted: %s)', async (alreadyAborted) => {
    const controller = new AbortController()
    const fetchMock = vi.fn(pendingUntilAborted)
    vi.stubGlobal('fetch', fetchMock)
    if (alreadyAborted) controller.abort()
    const result = requestAuditVerdict({ ...options, target: target(), signal: controller.signal })
    controller.abort()
    expect((await result).status).toBe('aborted')
    expect(fetchMock).toHaveBeenCalledTimes(alreadyAborted ? 0 : 1)
  })

  it('fails over after a member timeout and cleans timers', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockImplementationOnce(pendingUntilAborted).mockResolvedValueOnce(allow())
    vi.stubGlobal('fetch', fetchMock)
    const result = requestAuditVerdict({ ...options, target: target() })
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await result).status).toBe('allow')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds total audit time, blocks remaining members, and cleans timers', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(pendingUntilAborted)
    vi.stubGlobal('fetch', fetchMock)
    const result = requestAuditVerdict({ ...options, target: target(['a', 'b', 'c', 'd', 'e'].map(id => member(id))) })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await result).toMatchObject({ status: 'unavailable', reason: 'audit time limit exceeded' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })
})
