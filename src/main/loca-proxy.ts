import { appendFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { performance } from 'node:perf_hooks'
import type { ModelConfig } from '../shared/types'
import { defaultContextManagementConfig, type ContextManagementConfig } from '../shared/types'
import { manageContext, type ContextMessage } from './context'
import { toProviderMessages } from './model-messages'
import type { ToolCall } from './tools'

type OpenAIMessage = {
  role?: unknown
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: unknown
}

type OpenAIRequest = {
  model?: unknown
  messages?: unknown
  tools?: unknown
  [key: string]: unknown
}

export type LocaProxyOptions = {
  targetBaseUrl: string
  targetApiKey: string
  modelConfig: ModelConfig
  contextConfig?: Partial<ContextManagementConfig>
  rhaiScript?: string
  tracePath?: string
}

export type LocaProxy = {
  server: Server
  port: number
  close: () => Promise<void>
}

export function locaUpstreamEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`
}

function contentText(content: unknown): string | null {
  if (typeof content === 'string' || content === null) return content
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part && typeof part === 'object'))
      .map((part) => typeof part.text === 'string' ? part.text : part.type === 'image_url' ? '[image omitted]' : '')
      .join('')
  }
  return typeof content === 'object' ? JSON.stringify(content) : String(content)
}

function contextMessages(value: unknown): ContextMessage[] {
  if (!Array.isArray(value)) throw new Error('LOCA request does not contain a messages array')
  return value.map((item, index) => {
    const message = item as OpenAIMessage
    const role = message.role === 'system' || message.role === 'user' || message.role === 'assistant' || message.role === 'tool'
      ? message.role
      : 'assistant'
    return {
      id: `loca-message-${index}`,
      role,
      content: contentText(message.content),
      tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls as ToolCall[] : undefined,
      tool_call_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined,
      contextLayer: 'hot',
      contextSource: 'live',
      representation: 'original',
      createdAt: new Date(0).toISOString(),
    }
  })
}

function contextConfig(options: LocaProxyOptions): ContextManagementConfig {
  const overrides = options.contextConfig ?? {}
  return {
    ...defaultContextManagementConfig,
    ...overrides,
    customStrategyEnabled: Boolean(options.rhaiScript),
    customStrategyScript: options.rhaiScript ?? '',
    hotTokenBudget: Math.max(1_000, overrides.hotTokenBudget ?? defaultContextManagementConfig.hotTokenBudget),
    warmTokenBudget: Math.max(0, overrides.warmTokenBudget ?? defaultContextManagementConfig.warmTokenBudget),
    safeOutputMargin: Math.min(
      options.modelConfig.modelMaxContext - 1,
      Math.max(0, overrides.safeOutputMargin ?? defaultContextManagementConfig.safeOutputMargin),
    ),
  }
}
async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 256 * 1024 * 1024) {
        reject(new Error('LOCA request body exceeds 256 MiB'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.setHeader('content-length', Buffer.byteLength(body))
  response.end(body)
}

async function appendTrace(options: LocaProxyOptions, entry: Record<string, unknown>): Promise<void> {
  if (!options.tracePath) return
  try {
    await appendFile(options.tracePath, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // Diagnostics must never replace the upstream response or proxy error.
  }
}

async function forward(request: OpenAIRequest, options: LocaProxyOptions): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${options.targetApiKey}`,
  }
  return fetch(locaUpstreamEndpoint(options.targetBaseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...request, model: request.model || options.modelConfig.modelName }),
  })
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, options: LocaProxyOptions): Promise<void> {
  const requestPath = request.url ? new URL(request.url, 'http://127.0.0.1').pathname : ''
  if (request.method !== 'POST' || !requestPath.endsWith('/chat/completions')) {
    sendJson(response, 404, { error: { message: 'LOCA proxy only supports POST /chat/completions' } })
    return
  }

  const started = performance.now()
  const upstreamEndpoint = locaUpstreamEndpoint(options.targetBaseUrl)
  const strategy = options.rhaiScript ? 'rhai' : 'builtin'
  try {
    const payload = JSON.parse(await readBody(request)) as OpenAIRequest
    const messages = contextMessages(payload.messages)
    const latestUserMessageId = [...messages].reverse().find((message) => message.role === 'user')?.id
    const config = contextConfig(options)
    const contextResult = manageContext(messages, Array.isArray(payload.tools) ? payload.tools : [], options.modelConfig, config, {
      allowCustomStrategy: Boolean(options.rhaiScript),
      latestUserMessageId,
    })
    const coldRecallCount = contextResult.actions.filter((action) => action.type === 'recall').length
    if (contextResult.overflow) {
      await appendTrace(options, {
        timestamp: new Date().toISOString(),
        durationMs: performance.now() - started,
        upstreamEndpoint,
        strategy,
        originalTokens: contextResult.metrics.originalTokens,
        compressedTokens: contextResult.metrics.compressedTokens,
        compressionRatio: contextResult.metrics.compressionRatio,
        coldRecallCount,
        error: `Codey context overflow: ${contextResult.overflow.reason}`,
      })
      sendJson(response, 400, {
        error: { message: `Codey context overflow: ${contextResult.overflow.reason}` },
        codey_context: contextResult.metrics,
      })
      return
    }

    const managedRequest = {
      ...payload,
      messages: toProviderMessages(contextResult.messages),
    }
    const upstream = await forward(managedRequest, options)
    const text = await upstream.text()
    response.statusCode = upstream.status
    response.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json')
    response.end(text)

    await appendTrace(options, {
      timestamp: new Date().toISOString(),
      durationMs: performance.now() - started,
      upstreamEndpoint,
      upstreamStatus: upstream.status,
      strategy,
      originalTokens: contextResult.metrics.originalTokens,
      compressedTokens: contextResult.metrics.compressedTokens,
      compressionRatio: contextResult.metrics.compressionRatio,
      coldRecallCount,
      ...(upstream.ok ? {} : { error: `Upstream returned HTTP ${upstream.status}` }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'LOCA proxy request failed'
    await appendTrace(options, {
      timestamp: new Date().toISOString(),
      durationMs: performance.now() - started,
      upstreamEndpoint,
      strategy,
      error: message,
    })
    sendJson(response, 500, { error: { message } })
  }
}

export async function startLocaContextProxy(options: LocaProxyOptions): Promise<LocaProxy> {
  const server = createServer((request, response) => {
    void handleRequest(request, response, options)
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('Failed to determine LOCA proxy port')
  }
  return {
    server,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}
