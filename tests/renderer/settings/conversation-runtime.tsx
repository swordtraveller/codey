import React, { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { useConversationRuntime } from '../../../src/renderer/src/hooks/useConversationRuntime'
import type { ConversationRuntimeState, ConversationStateChange } from '../../../src/shared/types'

const assert = (value: unknown, detail: string) => { if (!value) throw new Error(detail) }
type Snapshot = Record<string, ConversationRuntimeState>
let runtime: ReturnType<typeof useConversationRuntime>
function Harness({ conversationId }: { conversationId: string }) {
  runtime = useConversationRuntime({ activeProjectId: 'p', activeConversationId: conversationId })
  return null
}

export async function runConversationRuntimeTests(): Promise<string[]> {
  const original = window.codey
  const listeners = new Set<(change: ConversationStateChange) => void>()
  const requests: { resolve: (states: Snapshot) => void; reject: (error: Error) => void }[] = []
  Object.assign(window, { codey: {
    ...original,
    onDevelopmentProgress: () => () => {},
    subscribeDevelopmentProgress: async () => ({ timeline: [], streamingBlocks: [] }),
    onConversationStateChange: (listener: (change: ConversationStateChange) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getConversationRuntimeStates: () => {
      assert(listeners.size > 0, 'subscribe before requesting the snapshot')
      return new Promise<Snapshot>((resolve, reject) => { requests.push({ resolve, reject }) })
    },
  } })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const passed: string[] = []
  const emit = (projectId: string, conversationId: string, state: ConversationRuntimeState) => {
    for (const listener of listeners) listener({ projectId, conversationId, state })
  }
  const begin = () => runtime.beginTurn({ projectId: 'p', conversationId: 'local', userMessageId: 'message', traceId: 'trace' })
  try {
    await act(async () => { root.render(<StrictMode><Harness conversationId="first" /></StrictMode>) })
    assert(listeners.size === 1, 'StrictMode cleans up the earlier subscription')
    await act(async () => {
      emit('p', 'ended', 'idle')
      emit('p', 'new', 'running')
      begin()
      requests.at(-1)!.resolve({ 'p:ended': 'running', 'p:background': 'running', 'other:remote': 'running', 'p:debug': 'debugging' })
      requests[0].resolve({ 'p:stale': 'running' })
    })
    assert(runtime.conversationStates['p:ended'] === 'idle', 'late snapshot cannot resurrect finished tasks')
    for (const key of ['p:new', 'p:local', 'p:background', 'other:remote']) {
      assert(runtime.conversationStates[key] === 'running', 'restores background runs and preserves newer changes: ' + key)
    }
    assert(runtime.conversationStates['p:debug'] === 'debugging', 'debugging stays distinct from processing')
    assert(!runtime.conversationStates['p:stale'], 'discard snapshot from cancelled effect')
    passed.push('runtime snapshot restores background tasks without overwriting newer events or local turns')

    const requestCount = requests.length
    await act(async () => { root.render(<StrictMode><Harness conversationId="second" /></StrictMode>) })
    assert(requests.length === requestCount && listeners.size === 1, 'switching conversations keeps a single global subscription')
    assert(runtime.conversationStates['p:local'] === 'running', 'background task remains running after navigation')
    await act(async () => { runtime.setStopping('p:local', true) })
    assert(runtime.conversationStates['p:local'] === 'running', 'stop request does not hide processing before confirmation')
    for (const result of ['normal', 'timeout', 'other', 'stopped'] as const) {
      await act(async () => { begin() })
      await act(async () => { runtime.finishTurn('p:local', { result }) })
      assert(runtime.conversationStates['p:local'] === 'idle', 'finished local turn clears processing: ' + result)
    }
    await act(async () => { emit('other', 'remote', 'idle') })
    assert(runtime.conversationStates['other:remote'] === 'idle', 'background completion clears processing')
    passed.push('navigation, stop request, final completion and background events preserve runtime semantics')

    await act(async () => { root.render(null) })
    assert(listeners.size === 0, 'unmount removes global subscription')
    await act(async () => { root.render(<Harness conversationId="first" />) })
    await act(async () => { requests.at(-1)!.resolve({}) })
    assert(Object.keys(runtime.conversationStates).length === 0, 'new process snapshot does not revive stale tasks')
    passed.push('fresh runtime does not reuse stale processing state')

    await act(async () => { root.render(null) })
    await act(async () => { root.render(<Harness conversationId="first" />) })
    await act(async () => { requests.at(-1)!.reject(new Error('snapshot unavailable')) })
    await act(async () => { emit('p', 'recovered', 'running') })
    assert(runtime.conversationStates['p:recovered'] === 'running', 'snapshot failure does not disable live events')
    passed.push('live state updates survive an initial snapshot failure')
    return passed
  } finally {
    await act(async () => { root.unmount() })
    Object.assign(window, { codey: original })
    container.remove()
  }
}
