import { describe, expect, it } from 'vitest'
import type { ChatMessage, DevelopmentProgressState, DevelopmentTimelineItem } from '../../shared/types'
import { conversationHistoryRows, conversationLiveRows, conversationRowStart, mergeConversationRows } from './conversation-render-rows'
import { initialConversationWindowStart } from '../../shared/conversation-window'
import { conversationVirtualWindow } from './conversation-virtual-layout'

const user = (id: string): ChatMessage => ({ id, role: 'user', content: id })
const blocks = Array.from({ length: 2000 }, (_, index) => ({ type: 'content' as const, content: `step ${index}` }))

describe('conversation render rows', () => {
  it('bounds a single long task by blocks even when fewer than five turns exist', () => {
    const messages: ChatMessage[] = [user('u'), { id: 'a', role: 'assistant', content: 'full response', blocks }]
    const rows = conversationHistoryRows(messages)
    expect(rows).toHaveLength(2001)
    expect(conversationRowStart(rows, initialConversationWindowStart(messages))).toBe(0)
    const offsets = Array.from({ length: rows.length + 1 }, (_, index) => index * 50)
    const window = conversationVirtualWindow(offsets, 30000, 600)
    expect(window.end - window.start).toBeLessThan(30)
    expect(rows[100].kind === 'message' && rows[100].message).toBe(messages[1])
    expect(messages[1].blocks).toHaveLength(2000)
  })

  it('preserves turn paging across assistant block groups and special messages', () => {
    const messages: ChatMessage[] = Array.from({ length: 8 }, (_, index) => [
      user(`u${index}`), { id: `a${index}`, role: 'assistant' as const, content: '', blocks: blocks.slice(0, 20) },
    ]).flat()
    const rows = conversationHistoryRows(messages)
    expect(conversationRowStart(rows, initialConversationWindowStart(messages))).toBe(3 * 21)
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
  })

  it('keeps live IDs and removes duplicates while the completed timeline is persisted', () => {
    const messages = [user('u')]
    const notice: DevelopmentTimelineItem = { type: 'model-request', event: { kind: 'retry', model: 'test', attempt: 2 } }
    const progress: DevelopmentProgressState = {
      timeline: [{ type: 'block', block: blocks[0] }, notice, { type: 'block', block: blocks[1] }], streamingBlocks: [],
    }
    const live = conversationLiveRows(progress, messages)
    const partial: ChatMessage[] = [...messages, { id: 'a0', role: 'assistant', content: '', blocks: [blocks[0]] }]
    const partialRows = mergeConversationRows(conversationHistoryRows(partial), conversationLiveRows(progress, partial))
    expect(partialRows.map((row) => row.id)).toEqual([conversationHistoryRows(messages)[0].id, ...live.map((row) => row.id)])
    const completed: ChatMessage[] = [...partial,
      { id: 'notice', role: 'assistant', content: '', modelRequest: notice.event },
      { id: 'a1', role: 'assistant', content: '', blocks: [blocks[1]] },
    ]
    const history = conversationHistoryRows(completed)
    expect(history.slice(1).map((row) => row.id)).toEqual(live.map((row) => row.id))
    expect(mergeConversationRows(history, conversationLiveRows(progress, completed))).toEqual(history)
  })

  it('keeps streaming row identity through commit and handles empty messages', () => {
    const messages = [user('u')]
    const streaming = conversationLiveRows({ timeline: [], streamingBlocks: [blocks[0]] }, messages)
    const committed = conversationLiveRows({ timeline: [{ type: 'block', block: blocks[0] }], streamingBlocks: [] }, messages)
    expect(streaming[0].id).toBe(committed[0].id)
    expect(conversationRowStart([], 0)).toBe(0)
    expect(conversationLiveRows({ timeline: [], streamingBlocks: [] }, [])).toEqual([])
  })
})
