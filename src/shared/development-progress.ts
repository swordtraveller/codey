import type { DevelopmentProgressState, DevelopmentProgressUpdate } from './types'

export function createDevelopmentProgressState(): DevelopmentProgressState {
  return { timeline: [], streamingBlocks: [] }
}

export function applyDevelopmentProgressUpdate(
  state: DevelopmentProgressState,
  update: DevelopmentProgressUpdate,
): DevelopmentProgressState {
  switch (update.type) {
    case 'append':
      return update.items.length === 0
        ? state
        : { ...state, timeline: [...state.timeline, ...update.items] }
    case 'replace-stream':
      return { ...state, streamingBlocks: update.blocks }
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
