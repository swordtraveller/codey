import { randomUUID } from 'node:crypto'
import type { TodoChange, TodoItem, TodoSnapshot, TodoStatus } from '../shared/todo'
import type { AgentToolProvider } from './agent-tool-provider'
import type { TaskRunJournal } from './task-run-journal'

const statuses: TodoStatus[] = ['pending', 'in_progress', 'finished', 'blocked', 'skipped']
type Action = TodoSnapshot['action']
const actions: Action[] = ['get', 'add', 'del', 'set']
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Unexpected Todo parameter; expected ${allowed.join(', ')}`)
}

export function applyTodoAction(
  current: readonly TodoItem[], args: unknown,
  createId: () => string = randomUUID,
  now: () => string = () => new Date().toISOString(),
): TodoSnapshot {
  if (!record(args) || !actions.includes(args.action as Action)) throw new Error('action must be get, add, del, or set')
  const action = args.action as Action
  const items = current.map((item) => ({ ...item }))
  const changes: TodoChange[] = []
  if (action === 'get') keys(args, ['action'])
  if (action === 'add') {
    keys(args, ['action', 'name'])
    if (typeof args.name !== 'string' || !args.name.trim() || args.name.trim().length > 160) throw new Error('name must be 1–160 characters')
    if (items.length >= 100) throw new Error('Todo list is limited to 100 items')
    const timestamp = now()
    const item: TodoItem = { id: `todo_${createId()}`, name: args.name.trim(), status: 'pending', createdAt: timestamp, updatedAt: timestamp }
    items.push(item)
    changes.push({ kind: 'added', item })
  }
  if (action === 'del') {
    keys(args, ['action', 'id'])
    const index = items.findIndex((item) => item.id === args.id)
    if (index < 0) throw new Error('Todo ID not found')
    changes.push({ kind: 'deleted', item: items[index] })
    items.splice(index, 1)
  }
  if (action === 'set') {
    keys(args, ['action', 'updates'])
    if (!record(args.updates) || Object.keys(args.updates).length === 0 || Object.keys(args.updates).length > 100) throw new Error('updates must be a nonempty map of Todo IDs to statuses')
    // Validate the entire batch before applying anything.
    for (const [id, update] of Object.entries(args.updates)) {
      if (!items.some((item) => item.id === id)) throw new Error(`Todo ID not found: ${id}`)
      if (!record(update)) throw new Error(`Invalid update for ${id}`)
      keys(update, ['status'])
      if (!statuses.includes(update.status as TodoStatus)) throw new Error(`Invalid status for ${id}`)
    }
    for (const [id, update] of Object.entries(args.updates)) {
      const item = items.find((entry) => entry.id === id)!
      const status = (update as { status: TodoStatus }).status
      if (item.status === status) continue
      item.status = status
      item.updatedAt = now()
      changes.push({ kind: 'updated', item: { ...item } })
    }
  }
  return { kind: 'todo-snapshot', version: 1, success: true, action, items, changes }
}

export const todoToolDefinition = {
  type: 'function',
  function: {
    name: 'todo',
    description: 'Manage a flat task Todo list. Use for multi-step work when a plan helps. Status means plan progress, not verified goal success. IDs come from add/get; names are not identifiers. Every call returns an immutable snapshot. A continuation shares its Todo list; a new user task starts a new one.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions },
        name: { type: 'string', description: 'For add: item name (1–160 characters).' },
        id: { type: 'string', description: 'For del: stable ID returned by add/get.' },
        updates: { type: 'object', description: 'For set: map of stable Todo IDs to {status}.', additionalProperties: {
          type: 'object', properties: { status: { type: 'string', enum: statuses } }, required: ['status'], additionalProperties: false,
        } },
      },
      required: ['action'], additionalProperties: false,
    },
  },
}

export function createTodoToolProvider(journal: TaskRunJournal, runId: string, taskId: string): AgentToolProvider {
  let items = journal.latestTodoItems(taskId)
  return {
    tools: [],
    async execute(toolCall, signal) {
      if (toolCall.function.name !== 'todo') return undefined
      if (signal?.aborted) throw new Error('Operation stopped')
      let args: unknown
      try { args = JSON.parse(toolCall.function.arguments) }
      catch { args = null }
      let snapshot: TodoSnapshot
      try { snapshot = applyTodoAction(items, args) }
      catch (error) {
        const action = record(args) && actions.includes(args.action as Action) ? args.action as Action : 'get'
        snapshot = { kind: 'todo-snapshot', version: 1, success: false, action,
          items: items.map((item) => ({ ...item })), changes: [], error: error instanceof Error ? error.message : 'Invalid Todo request' }
      }
      await journal.append(runId, { type: 'todo-snapshot', toolCallId: toolCall.id, taskId, snapshot })
      items = snapshot.items
      return JSON.stringify(snapshot)
    },
  }
}
