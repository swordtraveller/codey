import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { locaUpstreamEndpoint, startLocaContextProxy } from '../src/main/loca-proxy'
import { contextConfig } from '../scripts/loca'
import { defaultContextManagementConfig, defaultModelConfig } from '../src/shared/types'

async function listen(status = 200, responseBody?: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Array<{ content?: unknown }> }
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.end(responseBody ?? JSON.stringify({
      choices: [{ message: { content: body.messages?.at(-1)?.content ?? '' } }],
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not start')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

async function readTrace(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const lines = (await readFile(path, 'utf8')).trim().split(/\r?\n/)
      const last = lines.at(-1)
      if (last) return JSON.parse(last) as Record<string, unknown>
    } catch {
      // The proxy appends the trace after ending the HTTP response.
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`trace was not written: ${path}`)
}

describe('LOCA context proxy small-window regression', () => {
  function longContextTaskMessage(): string {
    const filler = 'archived '.repeat(400)
    return `The following archive is intentionally verbose background context.\n\n<background>\n${filler}\n</background>\n\nWrite CODEY-FILESYSTEM-LONG-CONTEXT-OK to answer.txt, then claim done.`
  }

  async function roundTrip(safeOutputMargin: number): Promise<{ status: number; body: string }> {
    const upstream = await listen()
    const proxy = await startLocaContextProxy({
      targetBaseUrl: upstream.url,
      targetApiKey: 'target-key',
      modelConfig: { ...defaultModelConfig, modelName: 'test-model', modelMaxContext: 4_096 },
      contextConfig: { ...defaultContextManagementConfig, layeredEnabled: true, safeOutputMargin },
    })
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          messages: [{ role: 'user', content: longContextTaskMessage() }],
        }),
      })
      return { status: response.status, body: await response.text() }
    } finally {
      await proxy.close()
      await upstream.close()
    }
  }

  it('rejects every request when the margin collapses a 4k window threshold to one token', async () => {
    const result = await roundTrip(4_095)
    expect(result.status).toBe(400)
    expect(result.body).toContain('latest_user_too_large')
  })

  it('forwards the same request when the runner binds the margin to --max-tokens', async () => {
    const saved = { LOCA_SAFE_OUTPUT_MARGIN: process.env.LOCA_SAFE_OUTPUT_MARGIN, RULER_SAFE_OUTPUT_MARGIN: process.env.RULER_SAFE_OUTPUT_MARGIN }
    delete process.env.LOCA_SAFE_OUTPUT_MARGIN
    delete process.env.RULER_SAFE_OUTPUT_MARGIN
    try {
      const runnerConfig = contextConfig({ modelContextSize: 4_096, maxTokens: 256, maxTokensProvided: true })
      expect(runnerConfig.safeOutputMargin).toBe(256)
      const result = await roundTrip(runnerConfig.safeOutputMargin)
      expect(result.status).toBe(200)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

describe('LOCA context proxy', () => {
  it('normalizes the configured upstream base URL to chat completions', () => {
    expect(locaUpstreamEndpoint('https://example.test/v1')).toBe('https://example.test/v1/chat/completions')
    expect(locaUpstreamEndpoint('https://example.test/v1/')).toBe('https://example.test/v1/chat/completions')
    expect(locaUpstreamEndpoint('https://example.test/v1/chat/completions')).toBe('https://example.test/v1/chat/completions')
  })

  it('applies Codey context management before forwarding an OpenAI request', async () => {
    const upstream = await listen()
    const proxy = await startLocaContextProxy({
      targetBaseUrl: upstream.url,
      targetApiKey: 'target-key',
      modelConfig: { ...defaultModelConfig, modelMaxContext: 10_000 },
      contextConfig: { ...defaultContextManagementConfig, layeredEnabled: false, hotTokenBudget: 10_000 },
    })

    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions?trace=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          messages: [
            { role: 'system', content: 'Answer exactly.' },
            { role: 'user', content: 'LOCA proxy smoke test' },
          ],
        }),
      })
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      expect(response.status).toBe(200)
      expect(body.choices?.[0]?.message?.content).toBe('LOCA proxy smoke test')
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it('透传上游错误并记录不含密钥的诊断 trace', async () => {
    const upstream = await listen(429, JSON.stringify({ error: { message: 'rate limited' } }))
    const traceDir = await mkdtemp(join(tmpdir(), 'codey-loca-trace-'))
    const tracePath = join(traceDir, 'trace.jsonl')
    const proxy = await startLocaContextProxy({
      targetBaseUrl: upstream.url,
      targetApiKey: 'super-secret-key',
      tracePath,
      modelConfig: { ...defaultModelConfig, modelMaxContext: 10_000 },
      contextConfig: { ...defaultContextManagementConfig, layeredEnabled: false, hotTokenBudget: 10_000 },
    })

    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          messages: [{ role: 'user', content: 'trigger upstream error' }],
        }),
      })
      expect(response.status).toBe(429)
      expect(await response.text()).toContain('rate limited')

      const trace = await readTrace(tracePath)
      expect(trace.upstreamEndpoint).toBe(`${upstream.url}/chat/completions`)
      expect(trace.upstreamStatus).toBe(429)
      expect(trace.error).toBe('Upstream returned HTTP 429')
      expect(JSON.stringify(trace)).not.toContain('super-secret-key')
    } finally {
      await proxy.close()
      await upstream.close()
      await rm(traceDir, { recursive: true, force: true })
    }
  })
})
