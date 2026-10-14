import { describe, expect, it } from 'vitest'
import { latestPlanCardId } from './todo-card-state'
import type { ConversationRenderRow } from '../conversation-render-rows'
import type { TodoSnapshot } from '../../../shared/todo'

const snapshot = (action: TodoSnapshot['action']): string => JSON.stringify({ kind: 'todo-snapshot', version: 1, action, success: true, items: [], changes: [] })
const row = (id: string, result?: string): ConversationRenderRow => ({
  id, messageIndex: 0, kind: 'message', message: { id, role: 'assistant', content: '' },
  block: { type: 'function_call', id, name: 'todo', parameters: '{}', result },
})

describe('Todo card expansion selection', () => {
  it('selects only the newest completed Todo card across stored and live rows', () => {
    const rows: ConversationRenderRow[] = [row('old', snapshot('add')), row('pending'), {
      id: 'live', messageIndex: 1, kind: 'live', item: { type: 'block', block: { type: 'function_call', id: 'new', name: 'todo', parameters: '{}', result: snapshot('get') } },
    }]
    expect(latestPlanCardId(rows)).toBe('new')
    expect(latestPlanCardId(rows.slice(0, 2))).toBe('old')
    expect(latestPlanCardId([row('bad', '{')])).toBeNull()
  })
})
