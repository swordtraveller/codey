import { getEncoding } from 'js-tiktoken'
import { estimatedImageTokens } from '../shared/image-attachments'
import type { ContextMessage } from './context'

const encoder = getEncoding('o200k_base')

type MessageTokenCacheEntry = {
  role: ContextMessage['role']
  content: ContextMessage['content']
  images: ContextMessage['images']
  toolCalls: ContextMessage['tool_calls']
  toolCallId: ContextMessage['tool_call_id']
  metadataSignature: string
  tokens: number
}

const messageTokenCache = new Map<string, MessageTokenCacheEntry>()
const anonymousMessageTokenCache = new WeakMap<object, number>()

function messageMetadataSignature(message: ContextMessage): string {
  return [
    message.createdAt ?? '',
    message.pinnedToHot ? '1' : '0',
    message.representation ?? '',
    message.truthRefs?.join('\u0000') ?? '',
    message.contextLayer ?? '',
    message.contextRegion ?? '',
    message.contextSource ?? '',
    message.recalledAtRoundId ?? '',
    message.lastAccessedAt ?? '',
    message.enteredHotAt ?? '',
    String(message.reuseCount ?? ''),
    message.manualContextLayer ?? '',
    message.manualProtected ? '1' : '0',
    message.protection ?? '',
  ].join('\u0001')
}

export function countContextTokens(value: unknown): number {
  let imageCount = 0
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (
      item && typeof item === 'object' &&
      'dataUrl' in item && 'mediaType' in item &&
      typeof item.dataUrl === 'string' && typeof item.mediaType === 'string' &&
      item.dataUrl.startsWith(`data:${item.mediaType};base64,`)
    ) {
      imageCount += 1
      return { ...item, dataUrl: '[image data omitted]' }
    }
    return item
  })
  return encoder.encode(serialized).length + imageCount * estimatedImageTokens
}

/** Count one message and reuse the result while its model-facing fields stay unchanged. */
export function countContextMessageTokens(message: ContextMessage): number {
  const id = message.id
  if (id) {
    const cached = messageTokenCache.get(id)
    if (cached
      && cached.role === message.role
      && cached.content === message.content
      && cached.images === message.images
      && cached.toolCalls === message.tool_calls
      && cached.toolCallId === message.tool_call_id
      && cached.metadataSignature === messageMetadataSignature(message)) {
      return cached.tokens
    }

    const tokens = countContextTokens(message)
    messageTokenCache.set(id, {
      role: message.role,
      content: message.content,
      images: message.images,
      toolCalls: message.tool_calls,
      toolCallId: message.tool_call_id,
      metadataSignature: messageMetadataSignature(message),
      tokens,
    })
    return tokens
  }

  const objectMessage = message as object
  const cached = anonymousMessageTokenCache.get(objectMessage)
  if (cached !== undefined) return cached
  const tokens = countContextTokens(message)
  anonymousMessageTokenCache.set(objectMessage, tokens)
  return tokens
}

export function sumContextMessageTokens(messages: readonly ContextMessage[]): number {
  let total = 0
  for (const message of messages) total += countContextMessageTokens(message)
  return total
}

export type ContextTokenCounter = {
  toolDefinitionTokens: number
  layerBaseTokens: number
  requestBaseTokens: number
  message: (message: ContextMessage) => number
  messages: (messages: readonly ContextMessage[]) => number
  layer: (messages: readonly ContextMessage[]) => number
  request: (messages: readonly ContextMessage[]) => number
}

/**
 * Build an additive counter for one context-management pass. Message tokenization
 * is cached; subsequent budget checks only add/subtract cached message totals.
 */
export function createContextTokenCounter(tools: object[]): ContextTokenCounter {
  const toolDefinitionTokens = countContextTokens(tools)
  const layerOverhead = countContextTokens([])
  const requestOverhead = Math.max(0, countContextTokens({ messages: [], tools }) - toolDefinitionTokens)
  const messages = (items: readonly ContextMessage[]) => sumContextMessageTokens(items)
  return {
    toolDefinitionTokens,
    layerBaseTokens: layerOverhead,
    requestBaseTokens: requestOverhead + toolDefinitionTokens,
    message: countContextMessageTokens,
    messages,
    layer: (items) => layerOverhead + messages(items),
    request: (items) => requestOverhead + toolDefinitionTokens + messages(items),
  }
}

/** Remove incomplete tool-call blocks before sending messages to a Chat Completions provider. */
export function normalizeToolCallSequence(messages: ContextMessage[]): ContextMessage[] {
  const result: ContextMessage[] = []
  let changed = false
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role === 'tool') {
      changed = true
      continue
    }
    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      result.push(message)
      continue
    }

    const expected = new Set(message.tool_calls.map((toolCall) => toolCall.id))
    const responses: ContextMessage[] = []
    let next = index + 1
    while (next < messages.length && messages[next].role === 'tool') {
      responses.push(messages[next])
      next += 1
    }
    const received = new Set(responses.map((response) => response.tool_call_id))
    const complete = expected.size > 0
      && received.size === expected.size
      && [...expected].every((id) => received.has(id))
      && responses.every((response) => response.tool_call_id && expected.has(response.tool_call_id))

    if (complete) {
      result.push(message, ...responses)
    } else if (message.content) {
      changed = true
      result.push({ ...message, tool_calls: undefined })
    } else {
      changed = true
    }
    index = next - 1
  }
  return changed ? result : messages
}
