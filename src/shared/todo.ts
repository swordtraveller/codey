/** Versioned, immutable Todo tool output. Historical cards render this snapshot, not live state. */
export type TodoStatus = 'pending' | 'in_progress' | 'finished' | 'blocked' | 'skipped'

export type TodoItem = {
  id: string
  name: string
  status: TodoStatus
  createdAt: string
  updatedAt: string
}

export type TodoChange = { kind: 'added' | 'updated' | 'deleted'; item: TodoItem }

export type TodoSnapshot = {
  kind: 'todo-snapshot'
  version: 1
  success: boolean
  action: 'get' | 'add' | 'del' | 'set'
  items: TodoItem[]
  changes: TodoChange[]
  error?: string
}

const statuses: readonly string[] = ['pending', 'in_progress', 'finished', 'blocked', 'skipped']
const actions: readonly string[] = ['get', 'add', 'del', 'set']
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function isTodoSnapshot(value: unknown): value is TodoSnapshot {
  return isObject(value) && value.kind === 'todo-snapshot' && value.version === 1
    && typeof value.success === 'boolean' && actions.includes(String(value.action))
    && Array.isArray(value.items) && value.items.every((item) => isObject(item)
      && typeof item.id === 'string' && typeof item.name === 'string'
      && statuses.includes(String(item.status)) && typeof item.createdAt === 'string'
      && typeof item.updatedAt === 'string')
    && Array.isArray(value.changes) && value.changes.every((change) => isObject(change)
      && ['added', 'updated', 'deleted'].includes(String(change.kind))
      && isObject(change.item) && typeof change.item.id === 'string'
      && typeof change.item.name === 'string' && statuses.includes(String(change.item.status))
      && typeof change.item.createdAt === 'string' && typeof change.item.updatedAt === 'string')
    && (value.error === undefined || typeof value.error === 'string')
}

export function parseTodoSnapshot(result?: string): TodoSnapshot | null {
  if (!result) return null
  try {
    const parsed: unknown = JSON.parse(result)
    return isTodoSnapshot(parsed) ? parsed : null
  } catch { return null }
}
