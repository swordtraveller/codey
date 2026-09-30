export interface UnreadState {
  lastReadMessageId?: string
  lastReadAt?: number
}

export function calculateUnreadCount(
  messages: Array<{ id: string }>,
  state: UnreadState
): number {
  if (!state.lastReadMessageId) {
    return messages.length
  }

  const lastReadIndex = messages.findIndex(m => m.id === state.lastReadMessageId)
  if (lastReadIndex === -1) {
    return messages.length
  }

  return Math.max(0, messages.length - lastReadIndex - 1)
}

export function hasUnread(messages: Array<{ id: string }>, state: UnreadState): boolean {
  return calculateUnreadCount(messages, state) > 0
}

export function getLastMessageId(messages: Array<{ id: string }>): string | undefined {
  return messages[messages.length - 1]?.id
}

// LocalStorage keys
const UNREAD_STORAGE_KEY = 'codey-unread-state'

export function saveUnreadState(conversationId: string, state: UnreadState): void {
  try {
    const all = loadAllUnreadStates()
    all[conversationId] = state
    localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(all))
  } catch (e) {
    console.error('Failed to save unread state:', e)
  }
}

export function loadUnreadState(conversationId: string): UnreadState {
  const all = loadAllUnreadStates()
  return all[conversationId] || {}
}

export function loadAllUnreadStates(): Record<string, UnreadState> {
  try {
    const saved = localStorage.getItem(UNREAD_STORAGE_KEY)
    return saved ? JSON.parse(saved) : {}
  } catch (e) {
    console.error('Failed to load unread states:', e)
    return {}
  }
}

export function clearAllUnreadStates(): void {
  localStorage.removeItem(UNREAD_STORAGE_KEY)
}
