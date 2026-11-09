import { useLayoutEffect, useRef } from 'react'

/** Keep the first visible row in place when background activity reorders a scrolled list. */
export function useListScrollAnchor(ids: readonly string[], scope = ''): { ref: React.RefObject<HTMLElement | null>; onScroll: () => void } {
  const ref = useRef<HTMLElement>(null)
  const previous = useRef<{ id: string; offset: number; scrollTop: number } | null>(null)
  const previousScope = useRef(scope)
  const order = ids.join('\0')
  const capture = (): void => {
    const list = ref.current
    if (!list) return
    const top = list.getBoundingClientRect().top
    const row = Array.from(list.children).find(child => child.getBoundingClientRect().bottom > top) as HTMLElement | undefined
    previous.current = row ? { id: row.dataset.navId!, offset: row.getBoundingClientRect().top - top, scrollTop: list.scrollTop } : null
  }
  useLayoutEffect(() => {
    const list = ref.current
    const anchor = previous.current
    if (list && previousScope.current !== scope) {
      list.scrollTop = 0
    } else if (list && anchor && anchor.scrollTop > 0) {
      const row = Array.from(list.children).find(child => (child as HTMLElement).dataset.navId === anchor.id)
      if (row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset
    }
    previousScope.current = scope
    capture()
  }, [order, scope])
  return { ref, onScroll: capture }
}
