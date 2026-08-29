import type {
  AssistantMessageBlock,
  DevelopmentProgressState,
  DevelopmentProgressUpdate,
  DevelopmentStreamDelta,
} from './types'

export function createDevelopmentProgressState(): DevelopmentProgressState {
  return { timeline: [], streamingBlocks: [] }
}

function appendStreamingDelta(
  blocks: AssistantMessageBlock[],
  delta: DevelopmentStreamDelta,
): AssistantMessageBlock[] {
  const contentBlock = blocks.find((block) => block.type === 'content')
  const toolBlocks = blocks
    .filter((block): block is Extract<AssistantMessageBlock, { type: 'function_call' }> =>
      block.type === 'function_call')
    .map((block) => ({ ...block }))
  let content = contentBlock?.content ?? ''
  let changed = false

  if (delta.content) {
    content += delta.content
    changed = true
  }
  for (const update of delta.toolCalls ?? []) {
    const current = toolBlocks[update.index] ?? {
      type: 'function_call' as const,
      id: '',
      name: '',
      parameters: '',
    }
    const next = {
      ...current,
      id: current.id + (update.id ?? ''),
      name: current.name + (update.name ?? ''),
      parameters: current.parameters + (update.parameters ?? ''),
    }
    if (next.id !== current.id || next.name !== current.name || next.parameters !== current.parameters || !toolBlocks[update.index]) {
      toolBlocks[update.index] = next
      changed = true
    }
  }

  if (!changed) return blocks
  return [
    ...(content ? [{ type: 'content' as const, content }] : []),
    ...toolBlocks,
  ]
}

function streamParts(blocks: AssistantMessageBlock[]): {
  content: string
  toolCalls: Array<Extract<AssistantMessageBlock, { type: 'function_call' }>>
} {
  return {
    content: blocks.find((block) => block.type === 'content')?.content ?? '',
    toolCalls: blocks.filter(
      (block): block is Extract<AssistantMessageBlock, { type: 'function_call' }> =>
        block.type === 'function_call',
    ),
  }
}

function appendedSuffix(previous: string, next: string): string | null {
  return next.startsWith(previous) ? next.slice(previous.length) : null
}

/**
 * Converts cumulative streaming snapshots into append-only deltas for IPC.
 * Falls back to the original replacement when a provider rewrites prior content.
 */
export function compactDevelopmentProgressUpdate(
  state: DevelopmentProgressState,
  update: DevelopmentProgressUpdate,
): DevelopmentProgressUpdate | null {
  if (update.type !== 'replace-stream') return update

  const previous = streamParts(state.streamingBlocks)
  const next = streamParts(update.blocks)
  const content = appendedSuffix(previous.content, next.content)
  if (content === null || next.toolCalls.length < previous.toolCalls.length) return update

  const toolCalls: NonNullable<DevelopmentStreamDelta['toolCalls']> = []
  for (let index = 0; index < next.toolCalls.length; index += 1) {
    const current = previous.toolCalls[index]
    const candidate = next.toolCalls[index]
    const id = appendedSuffix(current?.id ?? '', candidate.id)
    const name = appendedSuffix(current?.name ?? '', candidate.name)
    const parameters = appendedSuffix(current?.parameters ?? '', candidate.parameters)
    if (id === null || name === null || parameters === null) return update
    if (id || name || parameters || !current) {
      toolCalls.push({
        index,
        ...(id ? { id } : {}),
        ...(name ? { name } : {}),
        ...(parameters ? { parameters } : {}),
      })
    }
  }

  if (!content && toolCalls.length === 0) return null
  return {
    type: 'append-stream',
    delta: {
      ...(content ? { content } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    },
  }
}

export function applyDevelopmentProgressUpdate(
  state: DevelopmentProgressState,
  update: DevelopmentProgressUpdate,
): DevelopmentProgressState {
  switch (update.type) {
    case 'reset':
      return createDevelopmentProgressState()
    case 'append':
      return update.items.length === 0
        ? state
        : { ...state, timeline: [...state.timeline, ...update.items] }
    case 'replace-stream':
      return { ...state, streamingBlocks: update.blocks }
    case 'append-stream': {
      const streamingBlocks = appendStreamingDelta(state.streamingBlocks, update.delta)
      return streamingBlocks === state.streamingBlocks ? state : { ...state, streamingBlocks }
    }
    case 'commit-stream':
      return {
        timeline: update.items.length === 0
          ? state.timeline
          : [...state.timeline, ...update.items],
        streamingBlocks: [],
      }
    case 'update-tool-result': {
      let changed = false
      const timeline = state.timeline.map((item) => {
        if (
          item.type !== 'block' ||
          item.block.type !== 'function_call' ||
          item.block.id !== update.toolCallId
        ) {
          return item
        }
        changed = true
        return {
          type: 'block' as const,
          block: {
            ...item.block,
            result: update.result,
            resultError: update.resultError,
          },
        }
      })
      return changed ? { ...state, timeline } : state
    }
  }
}
