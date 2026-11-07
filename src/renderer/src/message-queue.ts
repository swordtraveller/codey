export function reorderQueuedMessages<T extends { id: string }>(
  items: T[], sourceId: string, targetId: string, placement: 'before' | 'after',
): T[] {
  if (sourceId === targetId) return items
  const source = items.find((item) => item.id === sourceId)
  if (!source || !items.some((item) => item.id === targetId)) return items
  const remaining = items.filter((item) => item.id !== sourceId)
  const index = remaining.findIndex((item) => item.id === targetId)
  remaining.splice(index + (placement === 'after' ? 1 : 0), 0, source)
  return remaining
}
