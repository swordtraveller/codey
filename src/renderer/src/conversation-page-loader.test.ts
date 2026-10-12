import { describe, expect, it } from 'vitest'
import type { ChatMessage, ConversationMessagePage } from '../../shared/types'
import { ConversationPageLoader } from './conversation-page-loader'
const message = (id: string): ChatMessage => ({ id, role: 'user', content: id })
const page = (ids: string[], before: string | null = null): ConversationMessagePage => ({ messages: ids.map(message), before, revision: 'r' })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

describe('conversation page cache', () => {
  it('deduplicates concurrent older reads and retains new tail messages arriving during an older read', async () => {
    const pending = deferred<ConversationMessagePage>()
    let current = page(['5', '6'], '5')
    const loader = new ConversationPageLoader((before) => before ? pending.promise : Promise.resolve(current))
    await loader.refresh()
    const first = loader.loadOlder()
    expect(loader.loadOlder()).toBe(first)
    current = page(['5', '6', '7'], '5')
    await loader.refresh()
    pending.resolve(page(['3', '4'], '3'))
    await first
    expect(loader.getSnapshot().messages.map((item) => item.id)).toEqual(['3', '4', '5', '6', '7'])
    expect(loader.getSnapshot().before).toBe('3')
  })
  it('retains a prepended page when an older latest-page request completes afterwards', async () => {
    const pending = deferred<ConversationMessagePage>()
    let refreshes = 0
    const loader = new ConversationPageLoader((before) => before ? Promise.resolve(page(['3', '4'], '3')) : ++refreshes === 1 ? Promise.resolve(page(['5', '6'], '5')) : pending.promise)
    await loader.refresh()
    const refresh = loader.refresh()
    await loader.loadOlder()
    pending.resolve(page(['5', '6', '7'], '5'))
    await refresh
    expect(loader.getSnapshot().messages.map((item) => item.id)).toEqual(['3', '4', '5', '6', '7'])
    expect(loader.getSnapshot().before).toBe('3')
  })
  it('ignores stale refresh responses and keeps each conversation isolated', async () => {
    const pending = deferred<ConversationMessagePage>()
    let reads = 0
    const loader = new ConversationPageLoader(() => ++reads === 1 ? pending.promise : Promise.resolve(page(['new'])))
    const old = loader.refresh()
    await loader.refresh()
    pending.resolve(page(['old']))
    await old
    expect(loader.getSnapshot().messages.map((item) => item.id)).toEqual(['new'])
    expect(new ConversationPageLoader(() => Promise.resolve(page([]))).getSnapshot().messages).toEqual([])
  })
  it('fills gaps if more than a page arrives between refreshes', async () => {
    let refreshed = false
    const loader = new ConversationPageLoader((before) => Promise.resolve(!refreshed ? page(['1', '2']) : before === '5' ? page(['3', '4'], '3') : before === '3' ? page(['1', '2']) : page(['5', '6'], '5')))
    await loader.refresh()
    refreshed = true
    await loader.refresh()
    expect(loader.getSnapshot().messages.map((item) => item.id)).toEqual(['1', '2', '3', '4', '5', '6'])
  })
  it('keeps the cursor and cached rows after a read failure so the user can retry', async () => {
    let fail = true
    const loader = new ConversationPageLoader((before) => !before ? Promise.resolve(page(['3'], '3')) : fail ? Promise.reject(new Error('disk error')) : Promise.resolve(page(['1', '2'])))
    await loader.refresh()
    await loader.loadOlder()
    expect(loader.getSnapshot()).toMatchObject({ before: '3', error: 'disk error', loadingOlder: false })
    fail = false
    await loader.loadOlder()
    expect(loader.getSnapshot().messages.map((item) => item.id)).toEqual(['1', '2', '3'])
    expect(loader.getSnapshot().before).toBeNull()
  })
  it('replaces an optimistic user message only once the saved user arrives', async () => {
    let current = page(['1'])
    const loader = new ConversationPageLoader(() => Promise.resolve(current))
    await loader.refresh()
    loader.addOptimistic(message('optimistic'))
    await loader.refresh()
    expect(loader.getSnapshot().messages.map((item) => item.id)).toEqual(['1', 'optimistic'])
    current = page(['1', 'saved'])
    await loader.refresh()
    expect(loader.getSnapshot().messages.map((item) => item.id)).toEqual(['1', 'saved'])
  })
  it('retries the failed latest refresh instead of loading an older page', async () => {
    let fail = false
    const requests: Array<string | null> = []
    const loader = new ConversationPageLoader((before) => {
      requests.push(before)
      return fail ? Promise.reject(new Error('refresh failed')) : Promise.resolve(page(['5', '6'], '5'))
    })
    await loader.refresh()
    fail = true
    await loader.refresh()
    fail = false
    await loader.retry()
    expect(requests).toEqual([null, null, null])
    expect(loader.getSnapshot().error).toBeNull()
  })

})
