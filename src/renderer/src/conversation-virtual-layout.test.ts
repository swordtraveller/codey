import { describe, expect, it } from 'vitest'
import { conversationVirtualWindow, conversationRowAtOffset } from './conversation-virtual-layout'

describe('conversation virtual layout', () => {
  it('maps offsets to rows without returning an empty window at the boundary', () => {
    const offsets = [0, 100, 200, 300]
    expect(conversationRowAtOffset(offsets, 0)).toBe(0)
    expect(conversationRowAtOffset(offsets, 100)).toBe(1)
    expect(conversationRowAtOffset(offsets, 299)).toBe(2)
    expect(conversationVirtualWindow(offsets, 0, 100)).toEqual({ start: 0, end: 3 })
  })

  it('keeps the virtual window bounded to the available rows', () => {
    const offsets = Array.from({ length: 101 }, (_, index) => index * 100)
    const window = conversationVirtualWindow(offsets, 5000, 600)
    expect(window.start).toBe(45)
    expect(window.end).toBe(62)
    expect(window.end).toBeLessThanOrEqual(offsets.length - 1)
  })
})
