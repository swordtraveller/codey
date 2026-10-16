import { isDagSnapshot, type DagSnapshot } from './dag'
import { isTodoSnapshot, type TodoSnapshot } from './todo'

/** Run is an execution attempt; a normal end does not assert that the user's goal was verified. */
export type TaskRunStatus = 'running' | 'normal' | 'failed' | 'stopped'
export type RunEventPayload =
  | { type: 'run-started'; userMessageId: string; taskId: string; continuedFromRunId?: string }
  | { type: 'run-finished'; status: Exclude<TaskRunStatus, 'running'>; error?: string }
  | {
    type: 'model-call'
    callId: string
    phase: 'started' | 'finished' | 'failed'
    /** Actual provider model identifier; retained for compatibility with v1 journals. */
    model: string
    /** ModelDefinition model name, independent of provider. */
    modelName?: string
    /** Display name of the configured provider-specific model link. */
    modelLabel?: string
    /** Stable configured ModelLink identifier. */
    modelId?: string
    provider?: string
    providerId?: string
    requestIndex: number
    attempt?: number
    reason?: string
    durationMs?: number
    firstTokenMs?: number
  }
  | { type: 'tool-call'; toolCallId: string; name: string; phase: 'started' | 'finished'; failed?: boolean; cancelled?: boolean }
  | { type: 'approval'; toolCallId: string; stage: string; outcome: string; detail?: string }
  | { type: 'validation'; toolCallId: string; status: string }
  | { type: 'dag-snapshot'; toolCallId: string; taskId: string; snapshot: DagSnapshot }
  | { type: 'todo-snapshot'; toolCallId: string; taskId: string; snapshot: TodoSnapshot }

export type TaskRunEvent = RunEventPayload & {
  version: 1
  id: string
  runId: string
  sequence: number // monotonically increasing per conversation journal
  at: string
}

/** Reject incompatible or damaged records before they can become authoritative state. */
export function isTaskRunEvent(value: unknown): value is TaskRunEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  const text = (key: string): boolean => typeof event[key] === 'string' && (event[key] as string).length > 0
  const optionalText = (key: string): boolean => event[key] === undefined || typeof event[key] === 'string'
  if (event.version !== 1 || !Number.isInteger(event.sequence) || Number(event.sequence) < 1
    || !text('id') || !text('runId') || !text('at') || !Number.isFinite(Date.parse(String(event.at)))) return false
  switch (event.type) {
    case 'run-started': return text('userMessageId') && text('taskId') && optionalText('continuedFromRunId')
    case 'run-finished': return ['normal', 'failed', 'stopped'].includes(String(event.status)) && optionalText('error')
    case 'model-call': return text('callId') && text('model') && Number.isInteger(event.requestIndex)
      && ['started', 'finished', 'failed'].includes(String(event.phase)) && optionalText('reason') && optionalText('provider')
      && optionalText('modelName') && optionalText('modelLabel') && optionalText('modelId') && optionalText('providerId')
      && (event.attempt === undefined || (Number.isInteger(event.attempt) && Number(event.attempt) > 0))
      && (event.durationMs === undefined || (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0))
      && (event.firstTokenMs === undefined || (typeof event.firstTokenMs === 'number' && Number.isFinite(event.firstTokenMs) && event.firstTokenMs >= 0))
    case 'tool-call': return text('toolCallId') && text('name') && ['started', 'finished'].includes(String(event.phase))
      && (event.failed === undefined || typeof event.failed === 'boolean')
      && (event.cancelled === undefined || typeof event.cancelled === 'boolean')
    case 'approval': return text('toolCallId') && text('stage') && text('outcome') && optionalText('detail')
    case 'validation': return text('toolCallId') && text('status')
    case 'dag-snapshot': return text('toolCallId') && text('taskId') && isDagSnapshot(event.snapshot)
    case 'todo-snapshot': return text('toolCallId') && text('taskId') && isTodoSnapshot(event.snapshot)
    default: return false
  }
}
