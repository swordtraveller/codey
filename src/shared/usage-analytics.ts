import type { PerformanceDimension } from './analytics'
import { isModelUsage, type ModelUsage } from './model-usage'
import type { TaskRunEvent } from './task-run'

export type UsageAnalyticsQuery = { dimension?: PerformanceDimension; days?: 1 | 7 | 30 | 'all' }
export type UsageTotals = {
  calls: number
  completeCalls: number
  partialCalls: number
  unknownCalls: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cachedInputTokens: number | null
  reasoningOutputTokens: number | null
}
export type UsageAnalyticsRow = UsageTotals & { key: string; provider: string; modelName: string; specificModel: string }
export type UsageAnalytics = {
  generatedAt: string
  timeZone: string
  dimension: PerformanceDimension
  days: 1 | 7 | 30 | 'all'
  totals: UsageTotals
  daily: Array<UsageTotals & { date: string }>
  rows: UsageAnalyticsRow[]
  skippedJournals: number
}
const tokenFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens'] as const
const empty = (): UsageTotals => ({ calls: 0, completeCalls: 0, partialCalls: 0, unknownCalls: 0,
  inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningOutputTokens: null })
const dayKey = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
function add(totals: UsageTotals, usage?: ModelUsage): void {
  totals.calls += 1
  if (!usage) { totals.unknownCalls += 1; return }
  const complete = usage.inputTokens !== undefined && usage.outputTokens !== undefined
  if (complete) totals.completeCalls += 1
  else totals.partialCalls += 1
  // Cache/reasoning details are already included in their parent counters.
  const values = { ...usage, totalTokens: usage.totalTokens ?? (complete ? usage.inputTokens! + usage.outputTokens! : undefined) }
  for (const field of tokenFields) if (values[field] !== undefined) totals[field] = (totals[field] ?? 0) + values[field]!
}

/** Uses local calendar days (including DST), with each attempt assigned to its terminal event. */
export function aggregateUsageEvents(events: readonly TaskRunEvent[], query: UsageAnalyticsQuery = {}, now = new Date()): UsageAnalytics {
  const dimension = query.dimension ?? 'provider'
  const days = query.days ?? 30
  if (!['provider', 'modelName', 'specificModel'].includes(dimension)) throw new Error('Invalid analytics dimension')
  if (![1, 7, 30, 'all'].includes(days)) throw new Error('Invalid analytics days')
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1)
  const from = new Date(today)
  if (days !== 'all') from.setDate(today.getDate() - days + 1)
  const totals = empty()
  const daily = new Map<string, UsageTotals & { date: string }>()
  if (days !== 'all') {
    for (const day = new Date(from); day < tomorrow; day.setDate(day.getDate() + 1)) {
      const date = dayKey(day)
      daily.set(date, { date, ...empty() })
    }
  }
  type Call = Extract<TaskRunEvent, { type: 'model-call' }>
  const starts = new Map<string, Call>()
  const terminals = new Map<string, Call>()
  for (const event of events) {
    if (event.type !== 'model-call') continue
    const key = JSON.stringify([event.runId, event.callId])
    if (event.phase === 'started') starts.set(key, event)
    else terminals.set(key, event)
  }
  const groups = new Map<string, UsageAnalyticsRow>()
  for (const [id, event] of terminals) {
    const at = new Date(event.at)
    if (!Number.isFinite(at.getTime()) || at > now || (days !== 'all' && at < from)) continue
    const start = starts.get(id)
    const provider = event.provider || start?.provider || ''
    const providerId = event.providerId || start?.providerId
    const identity = providerId ? ['id', providerId] : ['name', provider]
    const modelName = event.modelName || start?.modelName || event.model || start?.model || ''
    const modelId = event.modelId || start?.modelId
    const specificModel = event.modelLabel || start?.modelLabel || modelName
    const key = JSON.stringify(dimension === 'provider' ? identity : dimension === 'modelName' ? [modelName]
      : [identity, modelId ? ['id', modelId] : ['legacy', modelName]])
    const group = groups.get(key) ?? { key, provider: '', modelName: '', specificModel: '', ...empty() }
    group.provider = dimension === 'modelName' ? '' : provider
    group.modelName = dimension === 'provider' ? '' : modelName
    group.specificModel = dimension === 'specificModel' ? specificModel : ''
    const date = dayKey(at)
    const day = daily.get(date) ?? { date, ...empty() }
    const usage = isModelUsage(event.usage) ? event.usage : undefined
    add(totals, usage); add(group, usage); add(day, usage)
    groups.set(key, group); daily.set(date, day)
  }
  return { generatedAt: now.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dimension, days, totals, daily: [...daily.values()].sort((a, b) => b.date.localeCompare(a.date)),
    rows: [...groups.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.modelName.localeCompare(b.modelName)
      || a.specificModel.localeCompare(b.specificModel) || a.key.localeCompare(b.key)), skippedJournals: 0 }
}
