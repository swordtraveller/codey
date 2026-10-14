import type { ConversationRenderRow } from '../conversation-render-rows'
import { parseTodoSnapshot } from '../../../shared/todo'

export function latestTodoCardId(rows: readonly ConversationRenderRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    const block = row.kind === 'message' ? row.block : row.kind === 'stream' ? row.block
      : row.item.type === 'block' ? row.item.block : undefined
    if (block?.type === 'function_call' && block.name === 'todo' && parseTodoSnapshot(block.result)) return block.id
  }
  return null
}
