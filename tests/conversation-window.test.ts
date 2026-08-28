import { describe, expect, it } from 'vitest'
import {
  expandConversationWindowStart,
  initialConversationWindowStart,
} from '../src/shared/conversation-window'

const message = (role: 'user' | 'assistant') => ({ role })

describe('conversation render window', () => {
  it('starts with the newest five complete user turns', () => {
    const messages = [
      message('user'), message('assistant'),
      message('user'), message('assistant'),
      message('user'), message('assistant'),
      message('user'), message('assistant'),
      message('user'), message('assistant'),
      message('user'), message('assistant'),
    ]

    expect(initialConversationWindowStart([])).toBe(0)
    expect(initialConversationWindowStart(messages.slice(0, 10))).toBe(0)
    expect(initialConversationWindowStart(messages)).toBe(2)
  })

  it('keeps every assistant response belonging to a visible user turn', () => {
    const messages = [
      message('user'), message('assistant'), message('assistant'),
      message('user'), message('assistant'),
      message('user'), message('assistant'),
      message('user'), message('assistant'),
      message('user'), message('assistant'),
      message('user'),
    ]

    expect(initialConversationWindowStart(messages)).toBe(3)
  })

  it('expands toward older turns in five-turn batches', () => {
    const messages = Array.from({ length: 12 }, () => [message('user'), message('assistant')]).flat()
    expect(initialConversationWindowStart(messages)).toBe(14)
    expect(expandConversationWindowStart(messages, 14)).toBe(4)
    expect(expandConversationWindowStart(messages, 4)).toBe(0)
  })
})
