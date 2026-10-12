import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { ChatMessage } from '../../shared/types'
import { conversationHistoryBatchSize, expandConversationWindowStart, initialConversationWindowStart } from '../../shared/conversation-window'
import { conversationEstimatedRowHeight, conversationRowAtOffset, conversationVirtualWindow, type VirtualWindow } from './conversation-virtual-layout'

type ReadingAnchor = { id: string; offset: number } | { id: null; offset: number }

/** UI paging only: messages remain in chronological order, independent of model context. */
export function ConversationHistory({
  messages, scrollContainerRef, shouldStickToBottom, renderMessage, renderLoadOlder,
}: {
  messages: ChatMessage[]
  scrollContainerRef: RefObject<HTMLDivElement | null>
  shouldStickToBottom: boolean
  renderMessage: (message: ChatMessage) => ReactNode
  renderLoadOlder: (loadOlder: () => void, count: number) => ReactNode
}): React.JSX.Element {
  const latestStart = initialConversationWindowStart(messages)
  const [startIndex, setStartIndex] = useState(latestStart)
  const expandedRef = useRef(false)
  const visibleStart = expandedRef.current ? Math.min(startIndex, latestStart) : latestStart
  const [windowRange, setWindowRange] = useState<VirtualWindow>(() => ({
    start: Math.max(latestStart, messages.length - 12), end: messages.length,
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
  const heightsRef = useRef(new Map<string, number>())
  const widthRef = useRef<number | null>(null)
  const handlersRef = useRef({ capture: (): ReadingAnchor | null => null, loadOlder: (): void => {} })
  const visibleMessages = useMemo(() => messages.slice(visibleStart), [messages, visibleStart])
  const layout = useMemo(() => {
    const offsets = [0]
    const indexes = new Map<string, number>()
    visibleMessages.forEach((message, index) => {
      indexes.set(message.id, index)
      offsets.push(offsets[index] + (heightsRef.current.get(message.id) ?? conversationEstimatedRowHeight))
    })
    return { offsets, indexes }
  }, [visibleMessages, revision])
  const effectiveWindowRange = expandedRef.current
    ? windowRange
    : { start: latestStart, end: messages.length }
  const renderedStart = Math.min(Math.max(effectiveWindowRange.start - visibleStart, 0), Math.max(0, visibleMessages.length - 1))
  const renderedEnd = Math.min(visibleMessages.length, Math.max(renderedStart + 1, effectiveWindowRange.end - visibleStart))
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
    followingRef.current = shouldStickToBottom
  }, [shouldStickToBottom])

  // Measure and reconcile before paint. Keep a message ID + viewport offset, never
  // a total scrollHeight delta (which also includes unrelated live output below).
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
      if (!visibleMessages.length) return null
      const top = viewportTop()
      for (const message of visibleMessages.slice(renderedStart, renderedEnd)) {
        const rect = nodesRef.current.get(message.id)?.getBoundingClientRect()
        if (rect && rect.bottom > top && rect.top < top + container.clientHeight) {
          return { id: message.id, offset: rect.top - top }
        }
      }
      const end = bottomSpacerRef.current?.getBoundingClientRect().bottom
      // When reading the separate live-response section, anchor its history boundary.
      if (end !== undefined && end <= top) return { id: null, offset: end - top }
      const index = conversationRowAtOffset(layout.offsets, container.scrollTop - origin())
      return { id: visibleMessages[index].id, offset: origin() + layout.offsets[index] - container.scrollTop }
    }
    handlersRef.current = {
      capture,
      loadOlder: () => {
        if (loadingRef.current || visibleStart <= 0) return
        const next = expandConversationWindowStart(messages, visibleStart)
        if (next === visibleStart) return
        anchorRef.current = capture()
        followingRef.current = false
        loadingRef.current = true
        expandedRef.current = true
        setStartIndex(next)
        setWindowRange((current) => ({
          start: Math.min(current.start, next),
          end: Math.max(current.end, next + 12),
        }))
      },
    }

    if (followingRef.current && !expandedRef.current && startIndex !== latestStart) {
      setStartIndex(latestStart)
      setWindowRange({ start: Math.max(latestStart, messages.length - 12), end: messages.length })
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

  useLayoutEffect(() => {
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

  const olderCount = Math.min(conversationHistoryBatchSize, messages.slice(0, visibleStart).filter((message) => message.role === 'user').length)
  return (
    <div className="conversation-history" ref={historyRef} data-history-start={visibleStart}>
      {visibleStart > 0 && (
        <div className="conversation-history-fold">
          {renderLoadOlder(() => handlersRef.current.loadOlder(), olderCount)}
        </div>
      )}
      <div aria-hidden="true" className="conversation-virtual-spacer" ref={topSpacerRef} style={{ height: topHeight }} />
      {visibleMessages.slice(renderedStart, renderedEnd).map((message) => (
        <div className="conversation-message-row" data-message-id={message.id} key={message.id} ref={getRowRef(message.id)}>
          {renderMessage(message)}
        </div>
      ))}
      <div aria-hidden="true" className="conversation-virtual-spacer" ref={bottomSpacerRef} style={{ height: bottomHeight }} />
    </div>
  )
}
