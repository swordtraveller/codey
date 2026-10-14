import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { ConversationPageLoader } from './conversation-page-loader'

export function useConversationMessages(projectId: string | undefined, conversationId: string | undefined, revision: string | undefined) {
  const loader = useMemo(() => new ConversationPageLoader((before) => {
    if (!projectId || !conversationId) return Promise.resolve({ messages: [], before: null, revision: '' })
    return window.codey.getConversationMessages(projectId, conversationId, before)
  }), [projectId, conversationId])
  const state = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot)
  useEffect(() => { if (conversationId) void loader.refresh() }, [loader, conversationId, revision])
  return { ...state, ensureMessage: loader.ensureMessage, retry: loader.retry, loadOlder: loader.loadOlder, refresh: loader.refresh, addOptimistic: (message: Parameters<ConversationPageLoader['addOptimistic']>[0]) => loader.addOptimistic(message) }
}
