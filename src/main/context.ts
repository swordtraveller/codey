import { getEncoding } from 'js-tiktoken'
import type { ContextMetrics, ModelConfig } from '../shared/types'
import type { ToolCall } from './tools'

export type ContextMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

type TextPart = { text: string; protected: boolean }

export type ContextResult = {
  messages: ContextMessage[]
  metrics: ContextMetrics
}

const encoder = getEncoding('o200k_base')
const protectedBlockPattern = /```[\s\S]*?```|Traceback \(most recent call last\):[\s\S]*?(?=\n\n|$)|(?:^|\n)(?:Error|Exception|Caused by):[^\n]*(?:\n\s+at [^\n]*)*|(?:^|\n)(?:(?:\d{4}-\d{2}-\d{2}[T ][^\n]*)|(?:(?:\[[^\]\n]+\]\s*)?(?:DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b[^\n]*))/g

function countTokens(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length
}

function splitText(content: string): TextPart[] {
  const parts: TextPart[] = []
  let index = 0
  for (const match of content.matchAll(protectedBlockPattern)) {
    const start = match.index ?? 0
    if (start > index) {
      parts.push({ text: content.slice(index, start), protected: false })
    }
    parts.push({ text: match[0], protected: true })
    index = start + match[0].length
  }
  if (index < content.length) {
    parts.push({ text: content.slice(index), protected: false })
  }
  return parts
}

function filterNaturalLanguage(text: string): string {
  const seen = new Set<string>()
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => {
      if (!paragraph || seen.has(paragraph)) {
        return false
      }
      seen.add(paragraph)
      return true
    })
    .join('\n\n')
}

function rewriteNaturalLanguage(text: string): string {
  return text
    .replace(/\b(?:please|kindly|basically|actually|just)\b[:,]?\s*/gi, '')
    .replace(/(?:\u8bf7\u6ce8\u610f|\u9700\u8981\u6ce8\u610f\u7684\u662f|\u7b80\u5355\u6765\u8bf4|\u4e5f\u5c31\u662f)[\uFF0C,:\uFF1A]?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function transformMessage(
  message: ContextMessage,
  transform: (text: string) => string,
): ContextMessage {
  if (!message.content || message.role === 'system' || message.role === 'tool' || message.tool_calls) {
    return message
  }

  return {
    ...message,
    content: splitText(message.content)
      .map((part) => part.protected ? part.text : transform(part.text))
      .filter(Boolean)
      .join('\n\n'),
  }
}

function getRecentStart(messages: ContextMessage[], rounds: number): number {
  let userMessages = 0
  for (let index = messages.length - 1; index > 0; index -= 1) {
    if (messages[index].role === 'user') {
      userMessages += 1
      if (userMessages === rounds) {
        return index
      }
    }
  }
  return 1
}

function splitRounds(messages: ContextMessage[]): ContextMessage[][] {
  const rounds: ContextMessage[][] = []
  for (const message of messages) {
    if (message.role === 'user' || rounds.length === 0) {
      rounds.push([message])
    } else {
      rounds.at(-1)?.push(message)
    }
  }
  return rounds
}

export function manageContext(
  messages: ContextMessage[],
  tools: object[],
  config: ModelConfig,
): ContextResult {
  const triggerThreshold = config.modelMaxContext - config.safeOutputMargin
  const count = (items: ContextMessage[]) => countTokens({ messages: items, tools })
  const originalTokens = count(messages)
  let managed = messages
  let filtered = false
  let rewritten = false
  let truncated = false

  if (originalTokens >= triggerThreshold) {
    filtered = true
    const recentStart = getRecentStart(messages, config.recentKeepRounds)
    const system = messages.slice(0, 1)
    let older = messages.slice(1, recentStart)
    const recent = messages.slice(recentStart)

    older = older.map((message) => transformMessage(message, filterNaturalLanguage))
    managed = [...system, ...older, ...recent]

    if (count(managed) >= triggerThreshold) {
      rewritten = true
      older = older.map((message) => transformMessage(message, rewriteNaturalLanguage))
      managed = [...system, ...older, ...recent]
    }

    const oldRounds = splitRounds(older)
    while (count(managed) >= triggerThreshold && oldRounds.length > 0) {
      oldRounds.shift()
      managed = [...system, ...oldRounds.flat(), ...recent]
      truncated = true
    }
  }

  const compressedTokens = count(managed)
  return {
    messages: managed,
    metrics: {
      originalTokens,
      compressedTokens,
      modelMaxContext: config.modelMaxContext,
      triggerThreshold,
      compressionRatio: compressedTokens ? originalTokens / compressedTokens : 1,
      filtered,
      rewritten,
      truncated,
    },
  }
}
