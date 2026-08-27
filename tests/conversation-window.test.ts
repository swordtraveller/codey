import { describe, expect, it } from 'vitest'
import {
  expandConversationWindowStart,
  initialConversationWindowStart,
} from '../src/shared/conversation-window'

describe('conversation render window', () => {
  it('starts with only the newest batch visible', () => {
    expect(initialConversationWindowStart(0)).toBe(0)
    expect(initialConversationWindowStart(20)).toBe(0)
    expect(initialConversationWindowStart(30)).toBe(0)
    expect(initialConversationWindowStart(31)).toBe(1)
    expect(initialConversationWindowStart(100)).toBe(70)
  })

  it('expands toward older messages in fixed batches', () => {
    expect(expandConversationWindowStart(70)).toBe(40)
    expect(expandConversationWindowStart(20)).toBe(0)
    expect(expandConversationWindowStart(0)).toBe(0)
  })
})

