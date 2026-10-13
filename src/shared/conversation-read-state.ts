import type { ChatMessage, ConversationTurnRecord } from './types'

/** Small enough to persist in the disk index; no message bodies are required. */
export type ReadMessage = Pick<ChatMessage, 'id' | 'role' | 'turn'> & {
  replyContent?: boolean
  compression?: unknown
  modelRequest?: unknown
}

export function readMessageMetadata(message: ReadMessage): ReadMessage {
  return { id: message.id, role: message.role, turn: message.turn,
    replyContent: message.replyContent ?? (message.role === 'assistant' && !message.compression && !message.modelRequest) }
}

export function turnHasError(turn: ConversationTurnRecord | undefined): boolean {
  return Boolean(turn && turn.result !== 'processing' && turn.result !== 'stopped'
    && (turn.result === 'timeout' || turn.result === 'other' || turn.error))
}

/** One receipt at the end of each finished reply, including failures with no output. */
export function completedReplyIds(messages: readonly ReadMessage[]): string[] {
  const ids: string[] = []
  let user: ReadMessage | undefined
  let lastReply: ReadMessage | undefined
  let hasContent = false
  const finish = (): void => {
    if (user && user.turn?.result !== 'processing' && (hasContent || turnHasError(user.turn))) ids.push((lastReply ?? user).id)
  }
  for (const message of messages) {
    if (message.role === 'user') {
      finish()
      user = message
      hasContent = false
      lastReply = undefined
    } else if (readMessageMetadata(message).replyContent) {
      hasContent = true
    }
    if (readMessageMetadata(message).replyContent) lastReply = message
  }
  finish()
  return ids
}

export function conversationReadState(messages: readonly ReadMessage[], lastReadMessageId?: string) {
  const readIndex = messages.findIndex((message) => message.id === lastReadMessageId)
  const replies = new Set(completedReplyIds(messages))
  const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user')
  const lastUser = lastUserIndex < 0 ? undefined : messages[lastUserIndex]
  const hasError = turnHasError(lastUser?.turn ?? messages.at(-1)?.turn)
  let errorReceiptId: string | undefined
  if (hasError && lastUser) {
    const reply = messages.slice(lastUserIndex + 1).filter((message) => readMessageMetadata(message).replyContent).at(-1)
    errorReceiptId = reply?.id ?? lastUser.id
  }
  const errorIndex = messages.findIndex((message) => message.id === errorReceiptId)
  return {
    unreadCount: messages.filter((message, index) => index > readIndex && replies.has(message.id)).length,
    lastReplyMessageId: [...replies].at(-1),
    hasError,
    // The failure remains in the transcript; this controls only the red unread-error marker.
    hasUnreadError: hasError && errorIndex > readIndex,
  }
}

