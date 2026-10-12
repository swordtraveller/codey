import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { ChatMessage } from '../../shared/types'
import { conversationHistoryBatchSize, expandConversationWindowStart, initialConversationWindowStart } from '../../shared/conversation-window'
import { conversationEstimatedRowHeight, conversationRowAtOffset, conversationVirtualWindow, type VirtualWindow } from './conversation-virtual-layout'
import { DetailsStateContext } from './components/LazyDetails'
import { conversationRowStart, type ConversationRenderRow } from './conversation-render-rows'

type ReadingAnchor = { id: string; offset: number } | { id: null; offset: number }

/** Virtual rows stay independent of model context and data-page ownership. */
export function ConversationHistory({
  messages, rows, scrollContainerRef, shouldStickToBottom, renderRow, renderLoadOlder, pagination,
}: {
  pagination?: { hasOlder: boolean; loading: boolean; loadOlder: () => Promise<void> }
  messages: ChatMessage[]
  rows: ConversationRenderRow[]
  scrollContainerRef: RefObject<HTMLDivElement | null>
  shouldStickToBottom: boolean
  renderRow: (row: ConversationRenderRow) => ReactNode
  renderLoadOlder: (loadOlder: () => void, count: number) => ReactNode
}): React.JSX.Element {
  const latestMessageStart = useMemo(() => pagination ? 0 : initialConversationWindowStart(messages), [messages, pagination])
  const latestStart = conversationRowStart(rows, latestMessageStart)
  const [startIndex, setStartIndex] = useState(latestStart)
  const expandedRef = useRef(false)
  const visibleStart = expandedRef.current ? Math.min(startIndex, latestStart) : latestStart
  const [windowRange, setWindowRange] = useState<VirtualWindow>(() => ({
    start: Math.max(latestStart, rows.length - 12), end: rows.length,
  }))
  const [revision, setRevision] = useState(0)
  const loadingRef = useRef(false)
  const followingRef = useRef(shouldStickToBottom)
  const anchorRef = useRef<ReadingAnchor | null>(null)
  const lastScrollTopRef = useRef(0)
  const frameRef = useRef<number | null>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const topSpacerRef = useRef<HTMLDivElement>(null)
  const bottomSpacerRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const nodesRef = useRef(new Map<string, HTMLDivElement>())
  const callbacksRef = useRef(new Map<string, (node: HTMLDivElement | null) => void>())
  const detailsStatesRef = useRef(new Map<string, Map<string, boolean>>())
  const heightsRef = useRef(new Map<string, number>())
  const widthRef = useRef<number | null>(null)
  const handlersRef = useRef({ capture: (): ReadingAnchor | null => null, loadOlder: (): void => {} })
  const visibleRows = useMemo(() => rows.slice(visibleStart), [rows, visibleStart])
  const layout = useMemo(() => {
    const offsets = [0]
    const indexes = new Map<string, number>()
    visibleRows.forEach((row, index) => {
      indexes.set(row.id, index)
      offsets.push(offsets[index] + (heightsRef.current.get(row.id) ?? conversationEstimatedRowHeight))
    })
    return { offsets, indexes }
  }, [visibleRows, revision])
  // Virtualize from the first mount, even before the user expands older turns.
  const effectiveWindowRange = windowRange
  const renderedStart = Math.min(Math.max(effectiveWindowRange.start - visibleStart, 0), Math.max(0, visibleRows.length - 1))
  const renderedEnd = Math.min(visibleRows.length, Math.max(renderedStart + 1, effectiveWindowRange.end - visibleStart))
  const topHeight = layout.offsets[renderedStart] ?? 0
  const bottomHeight = (layout.offsets.at(-1) ?? 0) - (layout.offsets[renderedEnd] ?? 0)

  // The callback only requests a fresh render; it cannot retain stale offsets/props.
  const scheduleUpdate = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      setRevision((value) => value + 1)
    })
  }, [])

  const getRowRef = useCallback((id: string) => {
    const existing = callbacksRef.current.get(id)
    if (existing) return existing
    const callback = (node: HTMLDivElement | null): void => {
      const previous = nodesRef.current.get(id)
      if (previous && previous !== node) observerRef.current?.unobserve(previous)
      if (node) {
        nodesRef.current.set(id, node)
        observerRef.current?.observe(node)
      } else {
        nodesRef.current.delete(id)
      }
    }
    callbacksRef.current.set(id, callback)
    return callback
  }, [])

  useLayoutEffect(() => {
    const ids = new Set(rows.map((row) => row.id))
    for (const id of heightsRef.current.keys()) if (!ids.has(id)) heightsRef.current.delete(id)
    for (const id of detailsStatesRef.current.keys()) if (!ids.has(id)) detailsStatesRef.current.delete(id)
    for (const id of callbacksRef.current.keys()) if (!ids.has(id)) callbacksRef.current.delete(id)
  }, [rows])

  useLayoutEffect(() => {
    followingRef.current = shouldStickToBottom
  }, [shouldStickToBottom])

  // Measure and reconcile before paint. Keep a message ID + viewport offset, never
  // a total scrollHeight delta (which also includes newly appended output).
  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const topSpacer = topSpacerRef.current
    if (!container || !topSpacer) return
    const viewportTop = (): number => container.getBoundingClientRect().top + container.clientTop
    const origin = (): number => topSpacer.getBoundingClientRect().top - viewportTop() + container.scrollTop
    const setScrollTop = (top: number): void => {
      container.scrollTop = top
      lastScrollTopRef.current = container.scrollTop
    }
    const capture = (): ReadingAnchor | null => {
      if (!visibleRows.length) return null
      const top = viewportTop()
      for (const message of visibleRows.slice(renderedStart, renderedEnd)) {
        const rect = nodesRef.current.get(message.id)?.getBoundingClientRect()
        if (rect && rect.bottom > top && rect.top < top + container.clientHeight) {
          return { id: message.id, offset: rect.top - top }
        }
      }
      const end = bottomSpacerRef.current?.getBoundingClientRect().bottom
      // If the viewport is below all rows, retain its offset from the list boundary.
      if (end !== undefined && end <= top) return { id: null, offset: end - top }
      const index = conversationRowAtOffset(layout.offsets, container.scrollTop - origin())
      return { id: visibleRows[index].id, offset: origin() + layout.offsets[index] - container.scrollTop }
    }
    handlersRef.current = {
      capture,
      loadOlder: () => {
        if (pagination) {
          if (pagination.loading || loadingRef.current || !pagination.hasOlder) return
          anchorRef.current = capture()
          followingRef.current = false
          loadingRef.current = true
          void pagination.loadOlder().finally(() => { loadingRef.current = false; scheduleUpdate() })
          return
        }
        if (loadingRef.current || visibleStart <= 0) return
        const messageStart = rows[visibleStart]?.messageIndex ?? messages.length
        const next = conversationRowStart(rows, expandConversationWindowStart(messages, messageStart))
        if (next === visibleStart) return
        anchorRef.current = capture()
        followingRef.current = false
        loadingRef.current = true
        expandedRef.current = true
        setStartIndex(next)
      },
    }

    if (followingRef.current && !expandedRef.current && startIndex !== latestStart) {
      setStartIndex(latestStart)
      setWindowRange({ start: Math.max(latestStart, rows.length - 12), end: rows.length })
      return
    }
    if (followingRef.current && !loadingRef.current) {
      setScrollTop(container.scrollHeight)
    } else {
      const anchor = anchorRef.current
      if (anchor) {
        let offset: number | undefined
        if (anchor.id === null) {
          offset = bottomSpacerRef.current?.getBoundingClientRect().bottom
          if (offset !== undefined) offset -= viewportTop()
        } else {
          const node = nodesRef.current.get(anchor.id)
          const index = layout.indexes.get(anchor.id)
          if (node) offset = node.getBoundingClientRect().top - viewportTop()
          else if (index !== undefined) offset = origin() + layout.offsets[index] - container.scrollTop
        }
        if (offset !== undefined) setScrollTop(container.scrollTop + offset - anchor.offset)
      }
    }

    let changed = false
    const width = historyRef.current?.getBoundingClientRect().width ?? 0
    if (widthRef.current !== null && width !== widthRef.current) {
      // Offscreen measurements no longer describe wrapped content at this width.
      heightsRef.current.clear()
      changed = true
    }
    widthRef.current = width
    for (const [id, node] of nodesRef.current) {
      const height = node.getBoundingClientRect().height
      if (height > 0 && heightsRef.current.get(id) !== height) {
        heightsRef.current.set(id, height)
        changed = true
      }
    }
    if (changed) {
      if (!anchorRef.current) anchorRef.current = capture()
      setRevision((value) => value + 1)
      return
    }
    const next = conversationVirtualWindow(layout.offsets, container.scrollTop - origin(), container.clientHeight)
    const start = visibleStart + next.start
    const end = visibleStart + next.end
    if (windowRange.start !== start || windowRange.end !== end) {
      if (!anchorRef.current) anchorRef.current = capture()
      setWindowRange({ start, end })
      return
    }
    loadingRef.current = false
    anchorRef.current = capture()
    lastScrollTopRef.current = container.scrollTop
  })

  // The scrolling element can be an ancestor mounted in the same commit.
  // Its ref is guaranteed to be attached by the passive effect, not by a
  // child's layout effect. The scheduled reconciliation measures before paint.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const observer = new ResizeObserver(scheduleUpdate)
    observerRef.current = observer
    // Refs run before effects, including StrictMode's effect re-setup.
    for (const node of nodesRef.current.values()) observer.observe(node)
    observer.observe(container)
    if (historyRef.current) observer.observe(historyRef.current)
    if (historyRef.current?.parentElement) observer.observe(historyRef.current.parentElement)
    const onScroll = (): void => {
      const top = container.scrollTop
      const moved = Math.abs(top - lastScrollTopRef.current) > 1
      const movingUp = top < lastScrollTopRef.current
      if (moved) {
        followingRef.current = container.scrollHeight - top - container.clientHeight <= 2
        anchorRef.current = handlersRef.current.capture()
      }
      lastScrollTopRef.current = top
      if (moved && movingUp && top <= 64) handlersRef.current.loadOlder()
      scheduleUpdate()
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) {
        followingRef.current = false
        anchorRef.current = handlersRef.current.capture()
        if (container.scrollTop <= 64) handlersRef.current.loadOlder()
      }
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    container.addEventListener('wheel', onWheel, { passive: true })
    scheduleUpdate()
    return () => {
      observer.disconnect()
      observerRef.current = null
      container.removeEventListener('scroll', onScroll)
      container.removeEventListener('wheel', onWheel)
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      // Keep mounted refs: StrictMode may replay effects without detaching DOM.
    }
  }, [scheduleUpdate, scrollContainerRef])

  const olderCount = pagination ? conversationHistoryBatchSize : Math.min(conversationHistoryBatchSize, messages.slice(0, rows[visibleStart]?.messageIndex ?? messages.length).filter((message) => message.role === 'user').length)
  return (
    <div className="conversation-history" ref={historyRef} data-history-start={visibleStart}>
      {(pagination ? pagination.hasOlder : visibleStart > 0) && (
        <div className="conversation-history-fold">
          {renderLoadOlder(() => handlersRef.current.loadOlder(), olderCount)}
        </div>
      )}
      <div aria-hidden="true" className="conversation-virtual-spacer" ref={topSpacerRef} style={{ height: topHeight }} />
      {visibleRows.slice(renderedStart, renderedEnd).map((row) => {
        let detailsState = detailsStatesRef.current.get(row.id)
        if (!detailsState) {
          detailsState = new Map()
          detailsStatesRef.current.set(row.id, detailsState)
        }
        return (
          <div className="conversation-message-row" data-message-id={row.id} key={row.id} ref={getRowRef(row.id)}>
            <DetailsStateContext.Provider value={detailsState}>{renderRow(row)}</DetailsStateContext.Provider>
          </div>
        )
      })}
      <div aria-hidden="true" className="conversation-virtual-spacer" ref={bottomSpacerRef} style={{ height: bottomHeight }} />
    </div>
  )
}
