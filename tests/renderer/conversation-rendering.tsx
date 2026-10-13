import { observeConversationReadReceipts } from '../../src/renderer/src/conversation-read-receipts'
import React, { StrictMode, useMemo, useRef, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type { ChatMessage, DevelopmentProgressState } from '../../src/shared/types'
import { ConversationHistory } from '../../src/renderer/src/ConversationHistory'
import { conversationHistoryRows, conversationLiveRows, mergeConversationRows, type ConversationRenderRow } from '../../src/renderer/src/conversation-render-rows'
import { ConversationPageLoader } from '../../src/renderer/src/conversation-page-loader'
import { LazyDetails } from '../../src/renderer/src/components/LazyDetails'
import '../../src/renderer/src/styles.css'

const emptyProgress: DevelopmentProgressState = { timeline: [], streamingBlocks: [] }
const blocks = Array.from({ length: 2000 }, (_, index) => ({ type: 'content' as const, content: `step ${index}` }))
const user = (id: string): ChatMessage => ({ id, role: 'user', content: id })
let bodyRenders = 0
let maxMounted = 0
const root = createRoot(document.getElementById('root')!)
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200))
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }

type Snapshot = { messages: ChatMessage[]; progress?: DevelopmentProgressState; session?: string; follow?: boolean; pagination?: { hasOlder: boolean; loading: boolean; loadOlder: () => Promise<void> } }
function Row({ row }: { row: ConversationRenderRow }): React.JSX.Element {
  const block = row.kind === 'message' ? row.block : row.kind === 'stream' ? row.block : row.item.type === 'block' ? row.item.block : undefined
  return <div className="message assistant">
    {block?.type === 'function_call' ? <LazyDetails summary={block.name}>
      {() => { bodyRenders++; return <div style={{ height: 350 }} data-tool-body>{block.result}<LazyDetails stateKey="logs" summary="logs">{() => <pre data-logs>logs</pre>}</LazyDetails></div> }}
    </LazyDetails> : <div className="message-card" style={{ minHeight: 40 + (row.messageIndex % 3) * 35 }} data-text>{block?.type === 'content' ? block.content : row.kind === 'message' ? row.message.content : 'notice'}</div>}
  </div>
}
function Fixture({ messages, progress = emptyProgress, follow = true, pagination }: Snapshot): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => mergeConversationRows(conversationHistoryRows(messages), conversationLiveRows(progress, messages)), [messages, progress])
  return <div id="scroll" ref={ref} style={{ height: 480, width: 720, overflow: 'auto', overflowAnchor: 'none' }}>
    <div className="messages">
      <ConversationHistory messages={messages} rows={rows} scrollContainerRef={ref} shouldStickToBottom={follow} pagination={pagination}
        renderRow={(row) => <Row row={row} />} renderLoadOlder={(load) => <button id="older" onClick={load}>older</button>} />
      <div style={{ height: 1 }} />
    </div>
  </div>
}
function PagedFixture({ loader }: { loader: ConversationPageLoader }): React.JSX.Element {
  const state = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot)
  return <Fixture messages={state.messages} pagination={{ hasOlder: Boolean(state.before), loading: state.loadingOlder, loadOlder: loader.loadOlder }} />
}
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-message-id]')]
const scroller = (): HTMLElement => document.getElementById('scroll')!
function visible(): HTMLElement[] {
  const container = scroller().getBoundingClientRect()
  return rows().filter((node) => { const rect = node.getBoundingClientRect(); return rect.bottom > container.top && rect.top < container.bottom })
}
function anchor(): { id: string; offset: number } {
  const row = visible()[0]
  assert(row, 'viewport must contain a mounted row')
  return { id: row.dataset.messageId!, offset: row.getBoundingClientRect().top - scroller().getBoundingClientRect().top }
}
function sameAnchor(before: ReturnType<typeof anchor>): void {
  const after = anchor()
  assert(after.id === before.id && Math.abs(after.offset - before.offset) < 2, `anchor moved: ${JSON.stringify({ before, after })}`)
}
function sameRowAnchor(before: ReturnType<typeof anchor>): void {
  const row = rows().find((item) => item.dataset.messageId === before.id)
  const offset = row ? row.getBoundingClientRect().top - scroller().getBoundingClientRect().top : null
  assert(offset !== null && Math.abs(offset - before.offset) < 2, 'paged anchor moved: ' + JSON.stringify({ before, offset }))
}
function bounded(): void {
  maxMounted = Math.max(maxMounted, rows().length)
  assert(rows().length > 0 && rows().length < 45, `mounted ${rows().length} rows`)
  assert(visible().length > 0, `blank viewport: ${JSON.stringify({ top: scroller().scrollTop, height: scroller().scrollHeight, viewport: scroller().getBoundingClientRect().toJSON(), mounted: rows().map((row) => ({ id: row.dataset.messageId, rect: row.getBoundingClientRect().toJSON() })) })}`)
}
async function render(snapshot: Snapshot): Promise<void> {
  root.render(<StrictMode><Fixture key={snapshot.session ?? 'default'} {...snapshot} /></StrictMode>)
  await pause()
  bounded()
}
async function scroll(top: number): Promise<void> {
  scroller().scrollTop = top
  scroller().dispatchEvent(new Event('scroll'))
  await pause()
  bounded()
}
function atBottom(): boolean { const c = scroller(); return c.scrollHeight - c.clientHeight - c.scrollTop < 3 }

async function runTests(): Promise<unknown> {
  const passed: string[] = []
  const history: ChatMessage[] = [user('u'), { id: 'answer', role: 'assistant', content: '', blocks }]
  await render({ messages: history })
  assert(atBottom(), 'initial mount should follow bottom')
  assert(document.body.textContent?.includes('step 1999'), 'last historical block is missing')
  await scroll(scroller().scrollHeight / 2)
  const reading = anchor()
  await render({ messages: [...history, user('new-turn')], progress: { timeline: [], streamingBlocks: [{ type: 'content', content: 'new output' }] } })
  sameAnchor(reading)
  await scroll(0)
  assert(document.body.textContent?.includes('step 0'), 'first historical block is missing')
  await scroll(scroller().scrollHeight)
  assert(atBottom(), 'return to bottom failed')
  passed.push('2000-block history: bounded DOM, upward scrolling and return to bottom')

  const messages = [user('live-user')]
  const progress: DevelopmentProgressState = { timeline: blocks.map((block) => ({ type: 'block', block })), streamingBlocks: [] }
  await render({ session: 'live', messages, progress })
  assert(atBottom(), 'live initial bottom')
  const appended = { ...progress, streamingBlocks: [{ type: 'content' as const, content: 'streaming tail' }] }
  await render({ session: 'live', messages, progress: appended })
  assert(atBottom(), 'appending should follow bottom')
  await scroll(scroller().scrollHeight / 2)
  const liveAnchor = anchor()
  await render({ session: 'live', messages, progress: { ...appended, streamingBlocks: [{ type: 'content', content: 'streaming tail updated\n'.repeat(100) }] } })
  sameAnchor(liveAnchor)
  // Resize while reading, then stream again: the resized anchor must remain stable.
  scroller().style.width = '480px'
  await pause()
  bounded()
  const resized = anchor()
  await render({ session: 'live', messages, progress: appended })
  sameAnchor(resized)
  const completed = [...messages, { id: 'saved', role: 'assistant' as const, content: '', blocks }]
  await render({ session: 'live', messages: completed, progress })
  sameAnchor(resized)
  await render({ session: 'live', messages: completed })
  sameAnchor(resized)
  passed.push('2000 live blocks: follow, reading anchor, resize and persistence handoff')

  const turns: ChatMessage[] = Array.from({ length: 8 }, (_, index) => [user(`u${index}`), {
    id: `a${index}`, role: 'assistant' as const, content: '', blocks: blocks.slice(0, 100),
  }]).flat()
  await render({ session: 'paging', messages: turns })
  await scroll(200)
  const pagingAnchor = anchor()
  document.getElementById('older')!.click()
  await pause()
  bounded()
  sameAnchor(pagingAnchor)
  await scroll(0)
  assert(document.body.textContent?.includes('u0'), 'older turns were not loaded')
  passed.push('older turn expansion preserves reading anchor without mounting a whole batch')

  const tools: ChatMessage[] = [user('tools'), { id: 'tools-answer', role: 'assistant', content: '', blocks: Array.from({ length: 500 }, (_, index) => ({
    type: 'function_call' as const, id: `tool${index}`, name: `tool ${index}`, parameters: '{}', result: 'large output'.repeat(1000),
  })) }]
  await render({ session: 'tools', messages: tools })
  assert(bodyRenders === 0 && !document.querySelector('[data-tool-body]'), 'collapsed tools must not render details')
  await scroll(scroller().scrollHeight / 2)
  const target = visible()[1] ?? visible()[0]
  const targetId = target.dataset.messageId
  const details = target.querySelector('details')!
  details.querySelector('summary')!.click()
  await pause()
  assert(details.querySelector('[data-tool-body]'), 'expanded body not mounted')
  assert(!details.querySelector('[data-logs]'), 'collapsed logs were mounted')
  details.querySelector('details')!.querySelector('summary')!.click()
  await pause()
  assert(details.querySelector('[data-logs]'), 'expanded logs not mounted')
  const top = scroller().scrollTop
  await scroll(scroller().scrollHeight)
  assert(!rows().some((row) => row.dataset.messageId === targetId), 'offscreen tool did not unmount')
  await scroll(top)
  const restored = rows().find((row) => row.dataset.messageId === targetId)?.querySelector('details')
  assert(restored?.open && restored.querySelector('[data-tool-body]'), 'tool expansion was lost after recycling')
  assert(restored.querySelector('[data-logs]'), 'nested log expansion was lost after recycling')
  restored.querySelector('summary')!.click()
  await pause()
  assert(!restored.querySelector('[data-tool-body]'), 'collapsed body not released')
  passed.push('500 tools: deferred details/logs, recycling and retained expansion state')
  const pagedMessages: ChatMessage[] = Array.from({ length: 15 }, (_, index) => [user('page-u' + index), { id: 'page-a' + index, role: 'assistant' as const, content: '', blocks: blocks.slice(0, 8) }]).flat()
  let pendingOlder: (() => void) | undefined
  let olderCalls = 0
  let latestMessages = pagedMessages.slice(20)
  const loader = new ConversationPageLoader((before) => {
    if (!before) return Promise.resolve({ messages: latestMessages, before: 'page-u10', revision: '1' })
    olderCalls++
    const end = pagedMessages.findIndex((message) => message.id === before)
    const start = Math.max(0, end - 10)
    return new Promise((resolve) => { pendingOlder = () => resolve({ messages: pagedMessages.slice(start, end), before: start ? pagedMessages[start].id : null, revision: '1' }) })
  })
  await loader.refresh()
  root.render(<StrictMode><PagedFixture key="paged" loader={loader} /></StrictMode>)
  await pause()
  bounded()
  assert(atBottom(), 'paged initial mount should follow bottom')
  await scroll(0)
  const pagedAnchor = anchor()
  scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: -50 }))
  assert(olderCalls === 1, 'an in-flight page must not be requested twice')
  latestMessages = [...latestMessages, user('page-new')]
  await loader.refresh()
  await pause()
  sameRowAnchor(pagedAnchor)
  pendingOlder!()
  await pause()
  sameRowAnchor(pagedAnchor)
  bounded()
  assert(loader.getSnapshot().messages.at(-1)?.id === 'page-new', 'older response lost the latest message')
  await scroll(0)
  const oldestAnchor = anchor()
  pendingOlder!()
  await pause()
  sameRowAnchor(oldestAnchor)
  assert(!document.getElementById('older'), 'oldest page should remove the loading control')
  await scroll(0)
  assert(visible().length > 0, 'oldest page is blank')
  await scroll(scroller().scrollHeight)
  assert(atBottom(), 'paged return to bottom failed')
  passed.push('async data pages: duplicate request guard, concurrent tail update, prepend anchor and oldest boundary')

  // The hidden Electron harness cannot gain OS focus: inject the foreground
  // predicate while exercising real DOM geometry, observers and timers.
  await render({ messages: history, session: 'receipts' })
  const read: string[] = []
  let foreground = false
  const readRoot = scroller()
  const content = readRoot.querySelector<HTMLElement>('.conversation-history')!
  const stopReceipts = observeConversationReadReceipts(readRoot, content, async (id) => { read.push(id) }, () => foreground)
  const dwell = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 650))
  await dwell()
  assert(read.length === 0, 'background window must not acknowledge a visible reply')
  await scroll(scroller().scrollHeight / 2)
  foreground = true
  window.dispatchEvent(new Event('focus'))
  await dwell()
  assert(read.length === 0, 'viewing a long reply halfway must not acknowledge its end')
  await scroll(scroller().scrollHeight)
  window.dispatchEvent(new Event('blur'))
  foreground = false
  await dwell()
  assert(read.length === 0, 'losing focus during dwell must cancel the receipt')
  foreground = true
  window.dispatchEvent(new Event('focus'))
  await dwell()
  assert(read.join(',') === 'answer', 'focusing the visible reply end must acknowledge it')
  stopReceipts()

  const nextMessages: ChatMessage[] = [...history, { ...user('pending'), turn: { startedAt: 1, result: 'processing' } }]
  await render({ messages: nextMessages, session: 'receipts' })
  assert(!content.querySelector('[data-read-message-id="pending"]'), 'a running turn cannot produce a receipt')
  let completeWrite: (() => void) | undefined
  const concurrentReads: string[] = []
  const stopConcurrent = observeConversationReadReceipts(readRoot, content, async (id) => {
    concurrentReads.push(id)
    if (concurrentReads.length === 1) await new Promise<void>((resolve) => { completeWrite = resolve })
  }, () => true)
  await dwell()
  await render({ messages: [...history, { ...user('pending'), turn: { startedAt: 1, result: 'other', error: 'failed' } }], session: 'receipts' })
  completeWrite?.()
  await dwell()
  assert(concurrentReads.includes('pending'), 'a newly completed reply during a receipt write must still be acknowledged')
  stopConcurrent()

  const switched: string[] = []
  const stopSwitch = observeConversationReadReceipts(readRoot, content, async (id) => { switched.push(id) }, () => true)
  stopSwitch()
  await dwell()
  assert(switched.length === 0, 'switching conversations must cancel pending receipts')
  passed.push('read receipts: foreground, long reply end, dwell cancellation, completion during write and disposal')

  root.unmount()
  return { passed, maxMounted }
}
Object.assign(window, { runTests })
