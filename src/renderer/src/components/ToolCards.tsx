import type { AssistantMessageBlock } from '../../../shared/types'
import { parseTodoSnapshot } from '../../../shared/todo'
import { parseDagSnapshot } from '../../../shared/dag'
import { TodoToolCard } from './TodoToolCard'
import { DagToolCard } from './DagToolCard'

type ToolCardRenderer = (block: Extract<AssistantMessageBlock, { type: 'function_call' }>) => React.JSX.Element | null
const toolCards: Record<string, ToolCardRenderer> = {
  todo: (block) => {
    const snapshot = parseTodoSnapshot(block.result)
    return snapshot ? <TodoToolCard block={block} snapshot={snapshot} /> : null
  },
  dag: (block) => {
    const snapshot = parseDagSnapshot(block.result)
    return snapshot ? <DagToolCard block={block} snapshot={snapshot} /> : null
  },
}

/** Unknown, incomplete or invalid outputs retain the generic tool card. */
export function renderSpecializedToolCard(block: Extract<AssistantMessageBlock, { type: 'function_call' }>): React.JSX.Element | null {
  return toolCards[block.name]?.(block) ?? null
}
