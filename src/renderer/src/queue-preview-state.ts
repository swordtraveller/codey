import { reorderQueuedMessages } from './message-queue'

type QueueItem = { id: string; text: string }
type PreviewTurn = QueueItem & { reply: string; running: boolean }
type PreviewState = { queue: QueueItem[]; turns: PreviewTurn[]; nextId: number }
type PreviewAction =
  | { type: 'enqueue'; text: string }
  | { type: 'remove' | 'run-now'; id: string }
  | { type: 'clear' | 'toggle-running' }
  | { type: 'reorder'; source: string; target: string; placement: 'before' | 'after' }

export function createQueuePreviewState(): PreviewState {
  return {
    queue: [
      { id: '1', text: '帮我检查一下最近修改的故障转移逻辑，并补充边界测试。' },
      { id: '2', text: '再整理一份这次改动的简短说明。' },
    ],
    turns: [{
      id: 'initial',
      text: '调研一下会话工作期间，用户继续发送消息并先进入队列，待会话空闲时再从队列取用户消息使会话工作的可行性。',
      reply: '我在梳理会话忙碌期间的消息处理方式，重点看队列顺序、取消行为和会话空闲后的消费时机。',
      running: true,
    }],
    nextId: 3,
  }
}

export function queuePreviewReducer(state: PreviewState, action: PreviewAction): PreviewState {
  switch (action.type) {
    case 'enqueue': {
      const text = action.text.trim()
      return text ? { ...state, nextId: state.nextId + 1, queue: [...state.queue, { id: String(state.nextId), text }] } : state
    }
    case 'remove':
      return { ...state, queue: state.queue.filter((item) => item.id !== action.id) }
    case 'clear':
      return { ...state, queue: [] }
    case 'reorder':
      return { ...state, queue: reorderQueuedMessages(state.queue, action.source, action.target, action.placement) }
    case 'toggle-running':
      return { ...state, turns: state.turns.map((turn, index) => index === state.turns.length - 1 ? { ...turn, running: !turn.running } : turn) }
    case 'run-now': {
      const selected = state.queue.find((item) => item.id === action.id)
      if (!selected) return state
      // Publish the selected user message as a new turn, not a replacement for the old reply.
      return {
        ...state,
        queue: state.queue.filter((item) => item.id !== selected.id),
        turns: [
          ...state.turns.map((turn) => turn.running ? { ...turn, running: false } : turn),
          { ...selected, reply: `正在处理：${selected.text}`, running: true },
        ],
      }
    }
  }
}
