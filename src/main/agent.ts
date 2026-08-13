import type {
  AgentContextMessage,
  AssistantMessageBlock,
  ContextCompressionNotice,
  ContextMetrics,
  Project,
} from '../shared/types'
import { readConfig } from './config'
import { manageContext, type ContextMessage } from './context'
import { log } from './logger'
import { truncateOutput } from './sandbox'
import { createAgentTools, runAgentTool, type ToolCall } from './tools'

type ResponseMessage = {
  content?: string | null
  tool_calls?: ToolCall[]
}

type ChatResponse = {
  choices?: Array<{ message?: ResponseMessage }>
  error?: { message?: string }
}

type ChatChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
  error?: { message?: string }
}

type AgentResult = {
  reply?: string
  blocks?: AssistantMessageBlock[]
  writtenFiles: string[]
  agentMessages: AgentContextMessage[]
  context?: ContextMetrics
  compressionNotices: ContextCompressionNotice[]
  error?: string
}

function mergeContextMetrics(
  current: ContextMetrics | undefined,
  next: ContextMetrics,
): ContextMetrics {
  if (!current) {
    return next
  }

  const originalTokens = Math.max(current.originalTokens, next.originalTokens)
  return {
    ...next,
    originalTokens,
    compressionRatio: next.compressedTokens ? originalTokens / next.compressedTokens : 1,
    filtered: current.filtered || next.filtered,
    rewritten: current.rewritten || next.rewritten,
    truncated: current.truncated || next.truncated,
  }
}

function toApiMessages(messages: AgentContextMessage[]): ContextMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    tool_calls: message.toolCalls as ToolCall[] | undefined,
    tool_call_id: message.toolCallId,
  }))
}

function toStoredMessages(messages: ContextMessage[]): AgentContextMessage[] {
  return messages
    .filter((message): message is ContextMessage & { role: Exclude<ContextMessage['role'], 'system'> } =>
      message.role !== 'system',
    )
    .map((message) => ({
      role: message.role,
      content: message.content,
      toolCalls: message.tool_calls,
      toolCallId: message.tool_call_id,
    }))
}

function toMessageBlocks(message: ResponseMessage): AssistantMessageBlock[] {
  const blocks: AssistantMessageBlock[] = []
  if (message.content) {
    blocks.push({ type: 'content', content: message.content })
  }
  blocks.push(...(message.tool_calls ?? []).map((toolCall) => ({
    type: 'function_call' as const,
    id: toolCall.id,
    name: toolCall.function.name,
    parameters: toolCall.function.arguments,
  })))
  return blocks
}

const modelRequestTimeoutMs = 180_000
const maxNetworkAttempts = 2

type CompletionError = Error & { partial?: ResponseMessage }

function errorDetails(error: unknown): { name?: string; message: string; cause?: unknown } {
  if (!(error instanceof Error)) {
    return { message: String(error) }
  }

  const cause = error.cause instanceof Error
    ? { name: error.cause.name, message: error.cause.message, code: (error.cause as NodeJS.ErrnoException).code }
    : error.cause
  return { name: error.name, message: error.message, cause }
}

function hasResponseData(message: ResponseMessage | undefined): boolean {
  return Boolean(message?.content || message?.tool_calls?.length)
}

function responseSize(message: ResponseMessage | undefined): number {
  if (!message) {
    return 0
  }
  return (message.content?.length ?? 0) + (message.tool_calls ?? []).reduce(
    (size, toolCall) => size + toolCall.id.length + toolCall.function.name.length + toolCall.function.arguments.length,
    0,
  )
}

function isRetryableRequestError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return error.name === 'AbortError' ||
    message === 'fetch failed' ||
    message.includes('network') ||
    message.includes('socket') ||
    message.includes('econnreset') ||
    message.includes('etimedout')
}

async function requestCompletionAttempt(
  messages: ContextMessage[],
  tools: object[],
  signal: AbortSignal,
  onUpdate?: (message: ResponseMessage) => void,
): Promise<ChatResponse> {
  const config = await readConfig()
  if (!config.baseUrl || !config.apiKey || !config.modelName) {
    throw new Error('Configure a model before sending a message')
  }

  const requestBody = {
    model: config.modelName,
    messages,
    tools,
    tool_choice: 'auto',
    stream: true,
  }
  log.debug('model.request', {
    url: config.baseUrl + '/chat/completions',
    body: requestBody,
  })

  let content = ''
  const toolCalls: ToolCall[] = []
  let buffer = ''
  let publishTimer: ReturnType<typeof setTimeout> | undefined
  let lastPublished = 0
  const currentMessage = (): ResponseMessage => ({
    content: content || null,
    tool_calls: toolCalls.length ? toolCalls.map((toolCall) => ({
      ...toolCall,
      function: { ...toolCall.function },
    })) : undefined,
  })
  const publish = (): void => {
    publishTimer = undefined
    lastPublished = Date.now()
    onUpdate?.(currentMessage())
  }
  const schedulePublish = (): void => {
    if (!onUpdate || publishTimer) {
      return
    }
    const delay = Math.max(0, 50 - (Date.now() - lastPublished))
    if (delay === 0) {
      publish()
    } else {
      publishTimer = setTimeout(publish, delay)
    }
  }

  try {
    const response = await fetch(config.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal,
    })

    if (!response.ok) {
      const body = await response.text()
      let data: ChatResponse = {}
      try {
        data = JSON.parse(body) as ChatResponse
      } catch {
        // The status error below is more useful than a JSON parsing error.
      }
      const message =
        data.error?.message || body.slice(0, 200) || 'Request failed with status ' + response.status
      log.error('model.response.failed', { status: response.status, message })
      throw new Error(message)
    }

    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const body = await response.text()
      const data = JSON.parse(body) as ChatResponse
      log.debug('model.response', { status: response.status, body: data })
      const message = data.choices?.[0]?.message
      if (message) {
        onUpdate?.(message)
      }
      return data
    }

    if (!response.body) {
      throw new Error('The model returned an empty response')
    }

    const consumeEvent = (event: string): void => {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!data || data === '[DONE]') {
        return
      }
      const chunk = JSON.parse(data) as ChatChunk
      if (chunk.error?.message) {
        throw new Error(chunk.error.message)
      }
      const delta = chunk.choices?.[0]?.delta
      if (!delta) {
        return
      }
      if (delta.content) {
        content += delta.content
      }
      for (const deltaToolCall of delta.tool_calls ?? []) {
        const index = deltaToolCall.index ?? 0
        const toolCall = toolCalls[index] ?? {
          id: '',
          type: 'function' as const,
          function: { name: '', arguments: '' },
        }
        toolCall.id += deltaToolCall.id ?? ''
        toolCall.function.name += deltaToolCall.function?.name ?? ''
        toolCall.function.arguments += deltaToolCall.function?.arguments ?? ''
        toolCalls[index] = toolCall
      }
      schedulePublish()
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const result = await reader.read()
      if (result.done) {
        break
      }
      buffer += decoder.decode(result.value, { stream: true })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ''
      for (const event of events) {
        consumeEvent(event)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      consumeEvent(buffer)
    }
    if (publishTimer) {
      clearTimeout(publishTimer)
    }
    publish()

    const data: ChatResponse = { choices: [{ message: currentMessage() }] }
    log.debug('model.response', { status: response.status, body: data })
    return data
  } catch (error) {
    if (publishTimer) {
      clearTimeout(publishTimer)
    }
    const failure = (error instanceof Error ? error : new Error(String(error))) as CompletionError
    failure.partial = currentMessage()
    throw failure
  }
}

async function requestCompletion(
  messages: ContextMessage[],
  tools: object[],
  onUpdate?: (message: ResponseMessage) => void,
): Promise<ChatResponse> {
  let latestPartial: ResponseMessage | undefined

  for (let attempt = 1; attempt <= maxNetworkAttempts; attempt += 1) {
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, modelRequestTimeoutMs)
    const update = (message: ResponseMessage): void => {
      const isMoreComplete = responseSize(message) >= responseSize(latestPartial)
      if (isMoreComplete) {
        latestPartial = message
      }
      if (hasResponseData(message) && isMoreComplete) {
        onUpdate?.(message)
      }
    }

    try {
      return await requestCompletionAttempt(messages, tools, controller.signal, update)
    } catch (error) {
      const details = errorDetails(error)
      const failure = (error instanceof Error ? error : new Error(details.message)) as CompletionError
      if (timedOut) {
        failure.message = 'Model request timed out after ' + modelRequestTimeoutMs / 1000 + ' seconds'
      }
      const partial = hasResponseData(failure.partial) ? failure.partial : latestPartial
      failure.partial = responseSize(partial) >= responseSize(latestPartial) ? partial : latestPartial
      log.error('model.request.failed', {
        attempt,
        maxAttempts: maxNetworkAttempts,
        timeoutSeconds: modelRequestTimeoutMs / 1000,
        ...details,
        message: failure.message,
        hasPartialResponse: hasResponseData(failure.partial),
      })

      if (attempt < maxNetworkAttempts && isRetryableRequestError(error)) {
        log.warn('model.request.retrying', {
          attempt: attempt + 1,
          maxAttempts: maxNetworkAttempts,
          reason: failure.message,
        })
        continue
      }
      throw failure
    } finally {
      clearTimeout(timeout)
    }
  }

  throw new Error('Model request failed')
}

export async function develop(
  project: Project,
  agentMessages: AgentContextMessage[],
  onBlocks?: (blocks: AssistantMessageBlock[]) => void,
): Promise<AgentResult> {
  if (project.folders.length === 0) {
    return {
      writtenFiles: [],
      agentMessages,
      compressionNotices: [],
      error: 'Add a project folder before sending a request',
    }
  }

  const writtenFiles: string[] = []
  const tools = createAgentTools(project)
  const config = await readConfig()
  const systemMessage: ContextMessage = {
    role: 'system',
    content: [
      'You are a coding agent working in the project folders below.',
      ...project.folders.map((folder) => `- ${folder.id}: ${folder.path}`),
      'Each folder is an independent sandbox root. Every path-based tool requires folder_id and a relative path.',
      `The project Python environment is stored under folder ID ${project.pythonEnvironmentFolderId}.`,
      'Inspect relevant files before editing. Prefer file_patch for a unique local change and write_file for complete file creation or replacement.',
      'Use file and project tools for general development work. Use Python tools only for Python-related tasks or explicit Python environment operations.',
      'Every tool is restricted to the project sandbox. Do not access .git, agent_venv, or cache directories.',
      'Tool calls and tool results are critical context and must be retained verbatim if conversation context is ever compacted.',
      'Do not run tests unless the user asks. After completing changes, give a concise summary.',
    ].join('\n'),
  }
  let apiMessages = [systemMessage, ...toApiMessages(agentMessages)]
  let context: ContextMetrics | undefined
  const blocks: AssistantMessageBlock[] = []
  const compressionNotices: ContextCompressionNotice[] = []

  let completedToolCalls = 0

  try {
    for (let turn = 0; turn < 12; turn += 1) {
      const managed = manageContext(apiMessages, tools, config)
      apiMessages = managed.messages
      context = mergeContextMetrics(context, managed.metrics)
      const methods = [
        managed.metrics.filtered && 'filter',
        managed.metrics.rewritten && 'rewrite',
        managed.metrics.truncated && 'truncate',
      ].filter((method): method is string => Boolean(method))
      if (methods.length > 0) {
        compressionNotices.push({
          originalTokens: managed.metrics.originalTokens,
          compressedTokens: managed.metrics.compressedTokens,
          compressionRatio: managed.metrics.compressionRatio,
          method: methods.join(', '),
        })
      }
      if (managed.metrics.compressedTokens >= managed.metrics.triggerThreshold) {
        throw new Error('Recent conversation exceeds the configured input budget')
      }
      let response: ChatResponse
      try {
        response = await requestCompletion(apiMessages, tools, (message) => {
          onBlocks?.([...blocks, ...toMessageBlocks(message)])
        })
      } catch (error) {
        const partial = (error as CompletionError).partial
        const partialBlocks = toMessageBlocks(partial ?? {})
        if (partialBlocks.length > 0) {
          blocks.push(...partialBlocks)
          onBlocks?.([...blocks])
        }
        const message = partialBlocks.length > 0
          ? `Model connection interrupted after ${completedToolCalls} tool operation(s). Files already written were kept.`
          : error instanceof Error ? error.message : 'Request failed'
        throw new Error(message)
      }
      const message = response.choices?.[0]?.message
      if (!message) {
        throw new Error('The model returned an empty response')
      }

      const toolCalls = message.tool_calls ?? []
      if (toolCalls.length > 20) {
        throw new Error('The model returned too many tool calls')
      }
      if (toolCalls.length === 0) {
        const reply = message.content?.trim()
        if (!reply) {
          throw new Error('The model returned an empty response')
        }
        const block = { type: 'content' as const, content: reply }
        blocks.push(block)
        onBlocks?.([...blocks])
        apiMessages.push({ role: 'assistant', content: reply })
        return {
          reply,
          blocks,
          writtenFiles,
          agentMessages: toStoredMessages(apiMessages),
          context,
          compressionNotices,
        }
      }

      const responseBlocks = toMessageBlocks(message)
      blocks.push(...responseBlocks)
      onBlocks?.([...blocks])
      apiMessages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls })
      for (const toolCall of toolCalls) {
        let content: string
        try {
          content = await runAgentTool(project, toolCall, writtenFiles)
          completedToolCalls += 1
        } catch (error) {
          content = truncateOutput(`Error: ${error instanceof Error ? error.message : 'Tool failed'}`)
        }
        apiMessages.push({ role: 'tool', tool_call_id: toolCall.id, content })
      }
    }
    throw new Error('The model exceeded the tool-call limit')
  } catch (error) {
    return {
      blocks,
      writtenFiles,
      agentMessages: toStoredMessages(apiMessages),
      context,
      compressionNotices,
      error: error instanceof Error ? error.message : 'Request failed',
    }
  }
}
