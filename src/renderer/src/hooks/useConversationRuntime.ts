import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ConversationRuntimeState,
  ConversationTurnRecord,
} from '../../../shared/types'
import {
  clearDevelopmentProgress,
  replaceDevelopmentProgress,
  resetDevelopmentProgress,
  updateDevelopmentProgress,
} from '../development-progress-store'

export type ConversationTurn = ConversationTurnRecord & {
  projectId: string
  conversationId: string
  userMessageId: string
}

type RuntimeTurnResult = {
  result: ConversationTurnRecord['result']
  error?: string
}

type UseConversationRuntimeOptions = {
  activeProjectId: string
  activeConversationId: string
}

type BeginTurnOptions = {
  projectId: string
  conversationId: string
  userMessageId: string
  traceId: string
}

export function useConversationRuntime({
  activeProjectId,
  activeConversationId,
}: UseConversationRuntimeOptions) {
  const [conversationStates, setConversationStates] = useState<Record<string, ConversationRuntimeState>>({})
  const [sessionModelDisplay, setSessionModelDisplay] = useState<{ key: string; providerName: string; modelName: string } | null>(null)
  const [stoppingConversations, setStoppingConversations] = useState<Record<string, boolean>>({})
  const [conversationTurns, setConversationTurns] = useState<Record<string, ConversationTurn>>({})
  const activeConversationKeyRef = useRef('')
  const activeTraceIdsRef = useRef<Record<string, string>>({})
  const lastProgressTraceAtRef = useRef<Record<string, number>>({})
  const activeConversationKey = activeProjectId && activeConversationId
    ? `${activeProjectId}:${activeConversationId}`
    : ''

  activeConversationKeyRef.current = activeConversationKey

  useEffect(() => window.codey.onDevelopmentProgress((progress) => {
    const key = `${progress.projectId}:${progress.conversationId}`
    const now = performance.now()
    if (now - (lastProgressTraceAtRef.current[key] ?? 0) >= 1_000) {
      lastProgressTraceAtRef.current[key] = now
      window.codey.recordPerformanceTrace({
        traceId: activeTraceIdsRef.current[key] ?? 'renderer-session',
        scope: 'renderer',
        phase: 'progress-received',
        projectId: progress.projectId,
        conversationId: progress.conversationId,
      })
    }
    if (progress.update.type === 'model-changed') {
      setSessionModelDisplay({
        key,
        providerName: progress.update.providerName,
        modelName: progress.update.modelName,
      })
    }
    updateDevelopmentProgress(progress)
  }), [])

  useEffect(() => {
    let cancelled = false
    const projectId = activeProjectId || null
    const conversationId = activeConversationId || null
    const key = projectId && conversationId ? `${projectId}:${conversationId}` : ''
    void window.codey
      .subscribeDevelopmentProgress(projectId, conversationId)
      .then((state) => {
        if (!cancelled && key && activeConversationKeyRef.current === key) {
          replaceDevelopmentProgress(key, state)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeConversationId, activeProjectId])

  useEffect(() => () => {
    void window.codey.subscribeDevelopmentProgress(null, null)
  }, [])

  useEffect(() => window.codey.onConversationStateChange((change) => {
    setConversationStates((current) => ({
      ...current,
      [`${change.projectId}:${change.conversationId}`]: change.state,
    }))
  }), [])

  const beginTurn = useCallback(({ projectId, conversationId, userMessageId, traceId }: BeginTurnOptions): void => {
    const conversationKey = `${projectId}:${conversationId}`
    activeTraceIdsRef.current[conversationKey] = traceId
    resetDevelopmentProgress(conversationKey)
    setConversationStates((current) => ({ ...current, [conversationKey]: 'running' }))
    setStoppingConversations((current) => ({ ...current, [conversationKey]: false }))
    setConversationTurns((current) => ({
      ...current,
      [conversationKey]: {
        projectId,
        conversationId,
        userMessageId,
        startedAt: Date.now(),
        result: 'processing',
      },
    }))
  }, [])

  const updateTurnUserMessage = useCallback((conversationKey: string, userMessageId: string): void => {
    setConversationTurns((current) => ({
      ...current,
      [conversationKey]: {
        ...current[conversationKey],
        userMessageId,
      },
    }))
  }, [])

  const finishTurn = useCallback((conversationKey: string, result: RuntimeTurnResult): void => {
    setConversationTurns((current) => ({
      ...current,
      [conversationKey]: {
        ...current[conversationKey],
        endedAt: Date.now(),
        result: result.result,
        error: result.error,
      },
    }))
    setConversationStates((current) => ({ ...current, [conversationKey]: 'idle' }))
  }, [])

  const setStopping = useCallback((conversationKey: string, stopping: boolean): void => {
    setStoppingConversations((current) => ({ ...current, [conversationKey]: stopping }))
  }, [])

  const clearRun = useCallback((conversationKey: string): void => {
    delete activeTraceIdsRef.current[conversationKey]
    clearDevelopmentProgress(conversationKey)
    setStoppingConversations((current) => {
      if (!current[conversationKey]) return current
      const next = { ...current }
      delete next[conversationKey]
      return next
    })
  }, [])

  return {
    activeConversationKey,
    activeConversationKeyRef,
    conversationStates,
    conversationTurns,
    finishTurn,
    beginTurn,
    clearRun,
    setStopping,
    sessionModelDisplay,
    stoppingConversations,
    updateTurnUserMessage,
  }
}
