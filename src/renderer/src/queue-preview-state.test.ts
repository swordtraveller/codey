import { describe, expect, it } from 'vitest'
import { createQueuePreviewState, queuePreviewReducer } from './queue-preview-state'

describe('queue preview run now', () => {
  it('publishes the selected non-head message as a new user turn and keeps the stopped history', () => {
    const initial = createQueuePreviewState()
    const selected = initial.queue[1]
    const next = queuePreviewReducer(initial, { type: 'run-now', id: selected.id })
    expect(next.queue).toEqual([initial.queue[0]])
    expect(next.turns).toEqual([
      { ...initial.turns[0], running: false },
      { ...selected, reply: `正在处理：${selected.text}`, running: true },
    ])
    expect(initial.turns[0].running).toBe(true)
    expect(initial.queue).toHaveLength(2)
  })

  it('selects by stable ID after reordering, not by the original row position', () => {
    const initial = createQueuePreviewState()
    const reordered = queuePreviewReducer(initial, { type: 'reorder', source: '2', target: '1', placement: 'before' })
    const next = queuePreviewReducer(reordered, { type: 'run-now', id: '1' })
    expect(next.turns.at(-1)?.text).toBe(initial.queue[0].text)
    expect(next.queue.map((item) => item.id)).toEqual(['2'])
  })

  it('ignores duplicate or removed IDs instead of falling back to the queue head', () => {
    const first = queuePreviewReducer(createQueuePreviewState(), { type: 'run-now', id: '2' })
    expect(queuePreviewReducer(first, { type: 'run-now', id: '2' })).toBe(first)
    const removed = queuePreviewReducer(first, { type: 'remove', id: '1' })
    expect(queuePreviewReducer(removed, { type: 'run-now', id: '1' })).toBe(removed)
  })

  it('keeps identical text messages distinct and preserves all previous turns', () => {
    let state = createQueuePreviewState()
    state = queuePreviewReducer(state, { type: 'enqueue', text: 'same text' })
    state = queuePreviewReducer(state, { type: 'enqueue', text: 'same text' })
    state = queuePreviewReducer(state, { type: 'run-now', id: '4' })
    expect(state.queue.map((item) => item.id)).toEqual(['1', '2', '3'])
    state = queuePreviewReducer(state, { type: 'run-now', id: '3' })
    expect(state.turns.map((turn) => [turn.id, turn.running])).toEqual([
      ['initial', false], ['4', false], ['3', true],
    ])
    expect(state.queue.map((item) => item.id)).toEqual(['1', '2'])
  })

  it('only pauses or resumes the latest turn', () => {
    const started = queuePreviewReducer(createQueuePreviewState(), { type: 'run-now', id: '2' })
    const stopped = queuePreviewReducer(started, { type: 'toggle-running' })
    expect(stopped.turns.every((turn) => !turn.running)).toBe(true)
    const resumed = queuePreviewReducer(stopped, { type: 'toggle-running' })
    expect(resumed.turns).toEqual(started.turns)
  })
})
