import { describe, expect, it } from 'vitest'
import { completedReplyIds, conversationReadState, readMessageMetadata, type ReadMessage } from './conversation-read-state'

const user = (id: string, result?: NonNullable<ReadMessage['turn']>['result']): ReadMessage => ({
  id, role: 'user', turn: result ? { startedAt: 1, result } : undefined,
})
const assistant = (id: string, extra: Partial<ReadMessage> = {}): ReadMessage => ({ id, role: 'assistant', ...extra })

describe('conversation read state', () => {
  it('counts completed replies rather than timeline records and preserves index semantics', () => {
    const messages = [user('u', 'normal'), assistant('a'), assistant('compression', { compression: {} }),
      assistant('request', { modelRequest: {} }), assistant('b'), user('u2', 'processing'), assistant('partial')]
    expect(completedReplyIds(messages)).toEqual(['b'])
    expect(completedReplyIds([user('u', 'normal'), assistant('content'), assistant('event', { modelRequest: {} })])).toEqual(['content'])
    expect(conversationReadState(messages)).toMatchObject({ unreadCount: 1, lastReplyMessageId: 'b', hasError: false })
    expect(conversationReadState(messages.map(readMessageMetadata))).toEqual(conversationReadState(messages))
    expect(conversationReadState(messages, 'b').unreadCount).toBe(0)
  })

  it('advances across all older replies and supports legacy turns without status', () => {
    const messages = [user('u'), assistant('a'), user('u2'), assistant('b'), user('u3'), assistant('c')]
    expect(conversationReadState(messages, 'a').unreadCount).toBe(2)
    expect(conversationReadState(messages, 'c').unreadCount).toBe(0)
    expect(conversationReadState(messages, 'missing').unreadCount).toBe(3)
  })

  it('keeps failure independent of reading, including failures with no assistant output', () => {
    const failed = [user('u', 'other'), assistant('request', { modelRequest: {} })]
    expect(conversationReadState(failed, 'request')).toMatchObject({ unreadCount: 0, hasError: true, hasUnreadError: false })
    expect(conversationReadState(failed)).toMatchObject({ hasError: true, hasUnreadError: true })
    expect(completedReplyIds([user('empty', 'timeout')])).toEqual(['empty'])
    for (const result of ['processing', 'normal', 'stopped'] as const) {
      expect(conversationReadState([...failed, user('next', result)]).hasError).toBe(false)
    }
    expect(conversationReadState([{ ...user('stopped', 'stopped'), turn: { startedAt: 1, result: 'stopped', error: 'cancelled' } }]).hasError).toBe(false)
  })

  it('does not count internal-only successful turns as replies', () => {
    expect(completedReplyIds([user('u', 'normal'), assistant('event', { modelRequest: {} })])).toEqual([])
  })
})
