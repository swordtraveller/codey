import { applyDevelopmentProgressUpdate, createDevelopmentProgressState } from '../../shared/development-progress'
import type { DevelopmentProgress, DevelopmentProgressState } from '../../shared/types'

const states = new Map<string, DevelopmentProgressState>()
const listeners = new Map<string, Set<() => void>>()
const emptyState = createDevelopmentProgressState()

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener()
}

export function developmentProgressKey(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`
}

export function updateDevelopmentProgress(progress: DevelopmentProgress): void {
  const key = developmentProgressKey(progress.projectId, progress.conversationId)
  const current = states.get(key) ?? emptyState
  const next = applyDevelopmentProgressUpdate(current, progress.update)
  if (next === current) return
  states.set(key, next)
  notify(key)
}

export function resetDevelopmentProgress(key: string): void {
  states.set(key, createDevelopmentProgressState())
  notify(key)
}

export function clearDevelopmentProgress(key: string): void {
  if (!states.delete(key)) return
  notify(key)
}

export function getDevelopmentProgress(key: string): DevelopmentProgressState {
  return states.get(key) ?? emptyState
}

export function subscribeDevelopmentProgress(key: string, listener: () => void): () => void {
  let current = listeners.get(key)
  if (!current) {
    current = new Set()
    listeners.set(key, current)
  }
  current.add(listener)
  return () => {
    current?.delete(listener)
    if (current?.size === 0) listeners.delete(key)
  }
}
