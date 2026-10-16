import type { TaskRunEvent } from './task-run'

export type PerformanceDimension = 'provider' | 'modelName' | 'specificModel'
export type PerformanceAnalyticsQuery = {
  dimension?: PerformanceDimension
  /** Inclusive terminal-event timestamps in ISO format. */
  from?: string
  to?: string
}

export type PerformanceAnalyticsRow = {
  key: string
  provider: string
  modelName: string
  specificModel: string
  sampleCount: number
  successCount: number
  failureCount: number
  /** Latencies include successful calls only, not quick errors or timeouts. */
  averageDurationMs: number | null
  p50DurationMs: number | null
  p95DurationMs: number | null
  averageFirstTokenMs: number | null
}

export type PerformanceAnalytics = {
  generatedAt: string
  dimension: PerformanceDimension
  from?: string
  to?: string
  totalCalls: number
  skippedCalls: number
  skippedJournals: number
  rows: PerformanceAnalyticsRow[]
}

type ModelCall = Extract<TaskRunEvent, { type: 'model-call' }>
type Sample = {
  provider: string
  modelName: string
  specificModel: string
  phase: 'finished' | 'failed'
  durationMs: number
  firstTokenMs?: number
}

function parseBoundary(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value) throw new Error(`Invalid analytics ${label} timestamp`)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid analytics ${label} timestamp`)
  return timestamp
}

function validDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (!sorted.length) return null
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

function average(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

/** Derive independent dimensions from the existing journal, never from current settings. */
export function aggregateModelCallEvents(
  events: readonly TaskRunEvent[],
  query: PerformanceAnalyticsQuery = {},
): PerformanceAnalytics {
  const dimension = query.dimension ?? 'provider'
  if (!['provider', 'modelName', 'specificModel'].includes(dimension)) throw new Error('Invalid analytics dimension')
  const from = parseBoundary(query.from, 'from')
  const to = parseBoundary(query.to, 'to')
  if (from !== undefined && to !== undefined && from > to) throw new Error('Analytics from timestamp must not be after to timestamp')

  const starts = new Map<string, ModelCall>()
  const terminals = new Map<string, ModelCall>()
  for (const event of events) {
    if (event.type !== 'model-call') continue
    const key = JSON.stringify([event.runId, event.callId])
    // Reading the same journal twice must not double-count a completed attempt.
    if (event.phase === 'started') starts.set(key, event)
    else terminals.set(key, event)
  }
  const groups = new Map<string, Sample[]>()
  let skippedCalls = 0
  for (const [callKey, event] of terminals) {
    const timestamp = Date.parse(event.at)
    if (!Number.isFinite(timestamp) || (from !== undefined && timestamp < from) || (to !== undefined && timestamp > to)) continue
    if (!validDuration(event.durationMs)) { skippedCalls += 1; continue }
    const start = starts.get(callKey)
    const provider = event.provider || start?.provider || ''
    const providerKey = event.providerId || start?.providerId
    const providerIdentity = providerKey ? ['id', providerKey] : ['name', provider]
    // The legacy model field is the API/definition name, NOT the ModelLink nickname.
    const modelName = event.modelName || start?.modelName || event.model || start?.model || ''
    const modelId = event.modelId || start?.modelId
    const specificModel = event.modelLabel || start?.modelLabel || modelName
    const key = JSON.stringify(dimension === 'provider' ? providerIdentity
      : dimension === 'modelName' ? [modelName]
        : [providerIdentity, modelId ? ['id', modelId] : ['legacy', modelName]])
    const samples = groups.get(key) ?? []
    samples.push({
      provider, modelName, specificModel,
      phase: event.phase as 'finished' | 'failed', durationMs: event.durationMs,
      ...(validDuration(event.firstTokenMs) && event.firstTokenMs <= event.durationMs ? { firstTokenMs: event.firstTokenMs } : {}),
    })
    groups.set(key, samples)
  }
  const rows: PerformanceAnalyticsRow[] = [...groups].map(([key, samples]) => {
    const success = samples.filter((sample) => sample.phase === 'finished')
    const durations = success.map((sample) => sample.durationMs).sort((a, b) => a - b)
    const firstTokens = success.flatMap((sample) => sample.firstTokenMs === undefined ? [] : [sample.firstTokenMs])
    const latest = samples[samples.length - 1]!
    return {
      key,
      provider: dimension === 'modelName' ? '' : latest.provider,
      modelName: dimension === 'provider' ? '' : latest.modelName,
      specificModel: dimension === 'specificModel' ? latest.specificModel : '',
      sampleCount: samples.length, successCount: success.length, failureCount: samples.length - success.length,
      averageDurationMs: average(durations), p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95), averageFirstTokenMs: average(firstTokens),
    }
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.modelName.localeCompare(b.modelName)
    || a.specificModel.localeCompare(b.specificModel) || a.key.localeCompare(b.key))
  return {
    generatedAt: new Date().toISOString(), dimension,
    ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}),
    totalCalls: rows.reduce((sum, row) => sum + row.sampleCount, 0), skippedCalls, skippedJournals: 0, rows,
  }
}
