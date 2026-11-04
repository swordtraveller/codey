import { describe, expect, it, vi } from 'vitest'
import { ConversationTurnCoordinator } from './conversation-turn-coordinator'
import { reorderQueuedMessages } from './message-queue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('conversation turn coordination', () => {
  it('sends the selected payload after stop even if rows move, without the queue head stealing the turn', async () => {
    const original = ['head', 'selected', 'tail'].map((id) => ({
      id, content: `message ${id}`, images: [{ name: `${id}.png` }], attachments: [{ name: `${id}.pdf` }],
    }))
    let queue = [...original]
    const sent: typeof queue = []
    const cleanup = deferred<void>()
    const selectedCleanup = deferred<void>()
    const stop = deferred<void>()
    const coordinator = new ConversationTurnCoordinator(() => {
      // Model an eager automatic pump reacting to the previous turn becoming idle.
      if (!coordinator.isBusy('a') && queue.length) void dispatch(queue[0].id)
    })
    const dispatch = (id: string): Promise<boolean> => {
      const message = queue.find((item) => item.id === id)
      if (!message) return Promise.resolve(false)
      return coordinator.run('a', async () => {
        queue = queue.filter((item) => item.id !== id)
        sent.push(message)
        if (id === 'selected') await selectedCleanup.promise
        return true
      })
    }
    const previous = coordinator.run('a', async () => { await cleanup.promise; return true })
    const immediate = coordinator.runNow('a', () => stop.promise, () => dispatch('selected'))
    queue = reorderQueuedMessages(queue, 'tail', 'selected', 'before')
    cleanup.resolve()
    await previous
    expect(sent).toEqual([])
    stop.resolve()
    await vi.waitFor(() => expect(sent).toEqual([original[1]]))
    expect(sent[0]).toBe(original[1])
    expect(queue.map((item) => item.id)).toEqual(['head', 'tail'])
    selectedCleanup.resolve()
    await immediate
    expect(sent.map((item) => item.id)).toEqual(['selected', 'head', 'tail'])
  })

  it('reserves a conversation synchronously and releases it after renderer cleanup', async () => {
    const cleanup = deferred<void>()
    const settled = vi.fn()
    const coordinator = new ConversationTurnCoordinator(settled)
    const send = vi.fn(async () => true)
    const first = coordinator.run('a', async () => { await cleanup.promise; return true })
    expect(coordinator.hasTurn('a')).toBe(true)
    expect(await coordinator.run('a', send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
    cleanup.resolve()
    expect(await first).toBe(true)
    expect(coordinator.isBusy('a')).toBe(false)
    expect(settled).toHaveBeenCalledOnce()
  })

  it('waits for stop acceptance AND full cleanup before dispatching the selected message', async () => {
    const coordinator = new ConversationTurnCoordinator(vi.fn())
    const stop = deferred<void>()
    const cleanup = deferred<void>()
    const events: string[] = []
    const first = coordinator.run('a', async () => {
      await cleanup.promise
      events.push('old-turn-cleared')
      return true
    })
    const selected = vi.fn(() => coordinator.run('a', async () => {
      events.push('selected-started')
      return true
    }))
    const immediate = coordinator.runNow('a', () => stop.promise, selected)
    expect(coordinator.isInterrupting('a')).toBe(true)
    stop.resolve()
    await Promise.resolve()
    expect(selected).not.toHaveBeenCalled()
    expect(await coordinator.run('a', async () => true)).toBe(false)
    cleanup.resolve()
    await Promise.all([first, immediate])
    expect(events).toEqual(['old-turn-cleared', 'selected-started'])
    expect(selected).toHaveBeenCalledOnce()
    expect(coordinator.isBusy('a')).toBe(false)
  })

  it('keeps the reservation if the old turn ends before the stop response arrives', async () => {
    const coordinator = new ConversationTurnCoordinator(vi.fn())
    const stop = deferred<void>()
    const first = coordinator.run('a', async () => true)
    const selected = vi.fn(async () => true)
    const immediate = coordinator.runNow('a', () => stop.promise, selected)
    await first
    expect(coordinator.hasTurn('a')).toBe(false)
    expect(coordinator.isBusy('a')).toBe(true)
    expect(await coordinator.run('a', async () => true)).toBe(false)
    expect(selected).not.toHaveBeenCalled()
    stop.resolve()
    expect(await immediate).toBe(true)
  })

  it('ignores duplicate run-now requests while stopping', async () => {
    const coordinator = new ConversationTurnCoordinator(vi.fn())
    const stop = deferred<void>()
    const selected = vi.fn(async () => true)
    const duplicateStop = vi.fn(async () => undefined)
    const duplicateSend = vi.fn(async () => true)
    const immediate = coordinator.runNow('a', () => stop.promise, selected)
    expect(await coordinator.runNow('a', duplicateStop, duplicateSend)).toBe(false)
    expect(duplicateStop).not.toHaveBeenCalled()
    expect(duplicateSend).not.toHaveBeenCalled()
    stop.resolve()
    await immediate
    expect(selected).toHaveBeenCalledOnce()
  })

  it('retains the selected message if stopping fails, and permits a manual retry', async () => {
    const coordinator = new ConversationTurnCoordinator(vi.fn())
    const queue = ['first', 'chosen', 'last']
    const dispatch = vi.fn(async () => { queue.splice(queue.indexOf('chosen'), 1); return true })
    await expect(coordinator.runNow('a', async () => { throw new Error('stop failed') }, dispatch)).rejects.toThrow('stop failed')
    expect(dispatch).not.toHaveBeenCalled()
    expect(queue).toEqual(['first', 'chosen', 'last'])
    expect(coordinator.isBusy('a')).toBe(false)
    await coordinator.runNow('a', async () => undefined, dispatch)
    expect(queue).toEqual(['first', 'last'])
  })

  it('isolates conversation reservations when the user switches conversations', async () => {
    const coordinator = new ConversationTurnCoordinator(vi.fn())
    const stop = deferred<void>()
    const events: string[] = []
    const immediate = coordinator.runNow('project:a', () => stop.promise, () => coordinator.run('project:a', async () => {
      events.push('a-selected')
      return true
    }))
    await coordinator.run('project:b', async () => { events.push('b-sent'); return true })
    expect(events).toEqual(['b-sent'])
    stop.resolve()
    await immediate
    expect(events).toEqual(['b-sent', 'a-selected'])
  })

  it('can interrupt a run-now turn again without an older request releasing the newer reservation', async () => {
    const coordinator = new ConversationTurnCoordinator(vi.fn())
    const selectedTurn = deferred<boolean>()
    const nextStop = deferred<void>()
    const first = coordinator.runNow('a', async () => undefined, () => coordinator.run('a', () => selectedTurn.promise))
    await Promise.resolve()
    await Promise.resolve()
    const nextDispatch = vi.fn(() => coordinator.run('a', async () => true))
    const second = coordinator.runNow('a', () => nextStop.promise, nextDispatch)
    selectedTurn.resolve(true)
    await first
    expect(coordinator.isInterrupting('a')).toBe(true)
    expect(nextDispatch).not.toHaveBeenCalled()
    nextStop.resolve()
    await second
    expect(nextDispatch).toHaveBeenCalledOnce()
    expect(coordinator.isBusy('a')).toBe(false)
  })

  it('releases a failed old turn and still starts the selected message', async () => {
    const coordinator = new ConversationTurnCoordinator(vi.fn())
    const failure = deferred<boolean>()
    const previous = coordinator.run('a', () => failure.promise)
    const previousResult = expect(previous).rejects.toThrow('old turn failed')
    const dispatch = vi.fn(() => coordinator.run('a', async () => true))
    const immediate = coordinator.runNow('a', async () => undefined, dispatch)
    failure.reject(new Error('old turn failed'))
    await previousResult
    expect(await immediate).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
  })
})
