export type VirtualWindow = { start: number; end: number }

export const conversationEstimatedRowHeight = 480
const overscan = 5

/** Offsets include the final bottom edge. Return the row containing y. */
export function conversationRowAtOffset(offsets: readonly number[], y: number): number {
  const count = offsets.length - 1
  let low = 0
  let high = count
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (offsets[middle + 1] <= y) low = middle + 1
    else high = middle
  }
  return Math.max(0, Math.min(low, count - 1))
}

export function conversationVirtualWindow(
  offsets: readonly number[], scrollTop: number, viewportHeight: number,
): VirtualWindow {
  const count = offsets.length - 1
  if (count <= 0) return { start: 0, end: 0 }
  return {
    start: Math.max(0, conversationRowAtOffset(offsets, Math.max(0, scrollTop)) - overscan),
    end: Math.min(count, conversationRowAtOffset(offsets, Math.max(0, scrollTop + viewportHeight)) + overscan + 1),
  }
}
