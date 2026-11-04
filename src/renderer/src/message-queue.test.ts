import { describe, expect, it } from 'vitest'
import { reorderQueuedMessages } from './message-queue'

const ids = (items: { id: string }[]) => items.map((item) => item.id)
const queue = () => ['a', 'b', 'c', 'd'].map((id) => ({ id }))

describe('queued message ordering', () => {
  it('moves a later message before an earlier one', () => {
    expect(ids(reorderQueuedMessages(queue(), 'd', 'b', 'before'))).toEqual(['a', 'd', 'b', 'c'])
  })
  it('moves an earlier message after a later one, including the tail', () => {
    expect(ids(reorderQueuedMessages(queue(), 'a', 'd', 'after'))).toEqual(['b', 'c', 'd', 'a'])
    expect(ids(reorderQueuedMessages(queue(), 'a', 'c', 'before'))).toEqual(['b', 'a', 'c', 'd'])
  })
  it('supports adjacent moves in both keyboard directions', () => {
    expect(ids(reorderQueuedMessages(queue(), 'c', 'b', 'before'))).toEqual(['a', 'c', 'b', 'd'])
    expect(ids(reorderQueuedMessages(queue(), 'b', 'c', 'after'))).toEqual(['a', 'c', 'b', 'd'])
  })
  it('ignores a stale source, a removed target, and dropping onto itself', () => {
    const original = queue()
    expect(reorderQueuedMessages(original, 'gone', 'a', 'after')).toBe(original)
    expect(reorderQueuedMessages(original, 'a', 'gone', 'after')).toBe(original)
    expect(reorderQueuedMessages(original, 'a', 'a', 'before')).toBe(original)
    expect(reorderQueuedMessages([], 'a', 'b', 'before')).toEqual([])
  })
  it('preserves payloads and the relative order of all other messages without mutating the queue', () => {
    const attachments = [{ name: 'test.pdf' }]
    const images = [{ name: 'test.png' }]
    const chosen = { id: 'c', content: 'chosen', attachments, images, createdAt: 123 }
    const original = [{ ...chosen, id: 'a' }, { ...chosen, id: 'b' }, chosen]
    const reordered = reorderQueuedMessages(original, 'c', 'a', 'before')
    expect(ids(reordered)).toEqual(['c', 'a', 'b'])
    expect(ids(original)).toEqual(['a', 'b', 'c'])
    expect(reordered[0]).toBe(chosen)
    expect(reordered[0].images).toBe(images)
    expect(reordered[0].attachments).toBe(attachments)
  })
})
