export const conversationHistoryBatchSize = 30

export function initialConversationWindowStart(
  totalMessages: number,
  batchSize = conversationHistoryBatchSize,
): number {
  return Math.max(0, totalMessages - batchSize)
}

export function expandConversationWindowStart(
  currentStart: number,
  batchSize = conversationHistoryBatchSize,
): number {
  return Math.max(0, currentStart - batchSize)
}
