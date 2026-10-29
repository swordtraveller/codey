import type { ChatMessage, Conversation } from './types'
import { validTimestamp } from './list-sorting'

type DateEvidence = Pick<ChatMessage, 'role' | 'createdAt' | 'turn'> & { compression?: unknown; modelRequest?: unknown; replyContent?: boolean }

/** Legacy dates are evidence-based estimates; null means no evidence, not "now". */
export function inferConversationDates(value: Pick<Conversation, 'createdAt' | 'lastActivityAt'>, messages: readonly DateEvidence[]): Pick<Conversation, 'createdAt' | 'lastActivityAt'> {
  let earliest: string | undefined
  let latest: string | undefined
  const include = (raw: unknown): void => {
    const date = typeof raw === 'number' && Number.isFinite(raw) && Math.abs(raw) <= 8.64e15
      ? new Date(raw).toISOString() : validTimestamp(raw)
    if (!date) return
    if (!earliest || Date.parse(date) < Date.parse(earliest)) earliest = date
    if (!latest || Date.parse(date) > Date.parse(latest)) latest = date
  }
  for (const message of messages) {
    if (message.compression || message.modelRequest || (message.role === 'assistant' && message.replyContent === false)) continue
    include(message.createdAt)
    include(message.turn?.startedAt)
    include(message.turn?.endedAt)
  }
  const createdAt = value.createdAt === undefined ? earliest ?? null : validTimestamp(value.createdAt) ?? null
  return {
    createdAt,
    lastActivityAt: value.lastActivityAt === undefined ? latest ?? createdAt : validTimestamp(value.lastActivityAt) ?? null,
  }
}

export function recordConversationActivity(conversation: Conversation, at = new Date().toISOString()): void {
  const previous = validTimestamp(conversation.lastActivityAt) ?? validTimestamp(conversation.createdAt)
  if (!previous || Date.parse(at) > Date.parse(previous)) conversation.lastActivityAt = at
}
