import type { AssistantMessageBlock, ChatMessage, DevelopmentProgressState, DevelopmentTimelineItem } from '../../shared/types'

/** UI-only rows. Original messages and blocks stay intact for storage and copy. */
export type ConversationRenderRow = { id: string; messageIndex: number } & (
  | { kind: 'message'; message: ChatMessage; block?: AssistantMessageBlock }
  | { kind: 'live'; item: DevelopmentTimelineItem }
  | { kind: 'stream'; block: AssistantMessageBlock }
)

const turnRowId = (userId: string, index: number): string => JSON.stringify(['turn', userId, index])

export function conversationHistoryRows(messages: readonly ChatMessage[]): ConversationRenderRow[] {
  let userId: string | undefined
  let turnIndex = 0
  return messages.flatMap((message, messageIndex): ConversationRenderRow[] => {
    if (message.role === 'user') {
      userId = message.id
      turnIndex = 0
      return [{ id: JSON.stringify(['message', message.id]), messageIndex, kind: 'message', message }]
    }
    // The main process persists timeline blocks in order, grouping consecutive
    // blocks into messages. Keep row IDs independent of that grouping.
    const id = (index: number): string => userId === undefined
      ? JSON.stringify(['message', message.id, index])
      : turnRowId(userId, turnIndex++)
    if (!message.compression && !message.modelRequest && message.blocks?.length) {
      return message.blocks.map((block, index) => ({
        id: id(index), messageIndex, kind: 'message', message, block,
      }))
    }
    return [{ id: id(0), messageIndex, kind: 'message', message }]
  })
}

export function conversationLiveRows(progress: DevelopmentProgressState, messages: readonly ChatMessage[]): ConversationRenderRow[] {
  let userId: string | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') { userId = messages[index].id; break }
  }
  const id = (index: number): string => userId === undefined
    ? JSON.stringify(['live', index]) : turnRowId(userId, index)
  return [
    ...progress.timeline.map((item, index): ConversationRenderRow => ({
      id: id(index), messageIndex: messages.length, kind: 'live', item,
    })),
    ...progress.streamingBlocks.map((block, index): ConversationRenderRow => ({
      id: id(progress.timeline.length + index), messageIndex: messages.length, kind: 'stream', block,
    })),
  ]
}

/** Saving a completed task and clearing progress can arrive in separate updates. */
export function mergeConversationRows(history: ConversationRenderRow[], live: ConversationRenderRow[]): ConversationRenderRow[] {
  if (!live.length) return history
  const savedIds = new Set(history.map((row) => row.id))
  return [...history, ...live.filter((row) => !savedIds.has(row.id))]
}

/** First render row belonging to a message or a newer one, including live output. */
export function conversationRowStart(rows: readonly ConversationRenderRow[], messageIndex: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (rows[middle].messageIndex < messageIndex) low = middle + 1
    else high = middle
  }
  return low
}
