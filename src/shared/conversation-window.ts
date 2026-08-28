export const conversationHistoryBatchSize = 5

type ConversationWindowMessage = {
  role: 'user' | 'assistant'
}

function userMessageIndexes(messages: readonly ConversationWindowMessage[]): number[] {
  return messages.flatMap((message, index) => message.role === 'user' ? [index] : [])
}

/**
 * Keeps the newest complete user turns visible. A user message starts a turn;
 * all subsequent assistant messages remain with it until the next user message.
 */
export function initialConversationWindowStart(
  messages: readonly ConversationWindowMessage[],
  turnCount = conversationHistoryBatchSize,
): number {
  const userIndexes = userMessageIndexes(messages)
  if (userIndexes.length <= turnCount) return 0
  return userIndexes.at(-turnCount) ?? 0
}

export function expandConversationWindowStart(
  messages: readonly ConversationWindowMessage[],
  currentStart: number,
  turnCount = conversationHistoryBatchSize,
): number {
  const olderTurnStarts = userMessageIndexes(messages).filter((index) => index < currentStart)
  if (olderTurnStarts.length === 0) return 0
  return olderTurnStarts[Math.max(0, olderTurnStarts.length - turnCount)] ?? 0
}
