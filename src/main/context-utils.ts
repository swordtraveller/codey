import { getEncoding } from 'js-tiktoken'
import { estimatedImageTokens } from '../shared/image-attachments'
import type { ContextMessage } from './context'

const encoder = getEncoding('o200k_base')

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
