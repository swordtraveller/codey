/** Observe only mounted reply-end markers, never virtual-list overscan as a whole. */
export function observeConversationReadReceipts(
  root: HTMLElement,
  content: HTMLElement,
  onRead: (messageId: string) => Promise<void>,
  isForeground = (): boolean => document.visibilityState === 'visible' && document.hasFocus(),
): () => void {
  const seen = new Set<string>()
  const nodes = new Set<HTMLElement>()
  let candidate: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let disposed = false
  const visibleId = (): string | undefined => {
    if (!isForeground()) return undefined
    const bounds = root.getBoundingClientRect()
    const top = Math.max(bounds.top + root.clientTop, 0)
    const bottom = Math.min(bounds.top + root.clientTop + root.clientHeight, window.innerHeight)
    let last: string | undefined
    for (const node of nodes) {
      if (!node.isConnected) continue
      const rect = node.getBoundingClientRect()
      const id = node.dataset.readMessageId
      if (rect.height > 0 && rect.top >= top && rect.bottom <= bottom
        && rect.right > Math.max(bounds.left, 0) && rect.left < Math.min(bounds.right, window.innerWidth)
        && id && !seen.has(id)) last = id
    }
    return last
  }
  const cancel = (): void => { clearTimeout(timer); timer = undefined; candidate = undefined }
  const check = (): void => {
    if (disposed || pending) return
    const next = visibleId()
    if (candidate === next) return
    cancel()
    candidate = next
    if (!next) return
    timer = setTimeout(() => {
      timer = undefined
      if (disposed || visibleId() !== next) { cancel(); check(); return }
      pending = true
      let succeeded = false
      void onRead(next).then(() => {
        succeeded = true
        // Reading the newest visible reply also acknowledges preceding replies.
        for (const node of nodes) {
          if (node.dataset.readMessageId) seen.add(node.dataset.readMessageId)
          if (node.dataset.readMessageId === next) break
        }
        seen.add(next)
      }).catch(() => {
        // Keep it unread. Retry on the next scroll, focus or layout change.
      }).finally(() => { pending = false; cancel(); if (succeeded) check() })
    }, 500)
  }
  const intersection = new IntersectionObserver(check, { root, threshold: 1 })
  const scan = (): void => {
    intersection.disconnect()
    nodes.clear()
    for (const node of content.querySelectorAll<HTMLElement>('[data-read-message-id]')) {
      nodes.add(node)
      intersection.observe(node)
    }
    check()
  }
  const mutation = new MutationObserver(scan)
  mutation.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-read-message-id'] })
  const resize = new ResizeObserver(check)
  resize.observe(root)
  root.addEventListener('scroll', check, { passive: true })
  window.addEventListener('focus', check)
  window.addEventListener('blur', cancel)
  document.addEventListener('visibilitychange', check)
  scan()
  return () => {
    disposed = true
    cancel()
    intersection.disconnect()
    mutation.disconnect()
    resize.disconnect()
    root.removeEventListener('scroll', check)
    window.removeEventListener('focus', check)
    window.removeEventListener('blur', cancel)
    document.removeEventListener('visibilitychange', check)
  }
}
