import { describe, expect, it } from 'vitest'
import { isModelUsage, parseModelUsage } from './model-usage'
import { aggregateUsageEvents } from './usage-analytics'
import { isTaskRunEvent, type TaskRunEvent } from './task-run'

type Call = Extract<TaskRunEvent, { type: 'model-call' }>
const now = new Date(2026, 9, 16, 12)
let id = 0
function call(patch: Partial<Call> = {}): Call {
  id += 1
  return { version: 1, id: `e-${id}`, runId: 'run', sequence: id, type: 'model-call', callId: `c-${id}`,
    at: now.toISOString(), phase: 'finished', requestIndex: 1, providerId: 'p1', provider: 'Provider A',
    model: 'shared', modelName: 'shared', modelId: 'link1', modelLabel: 'Model A',
    usage: { source: 'provider', inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningOutputTokens: 5 }, ...patch }
}
describe('provider token usage', () => {
  it('normalizes reported counters without inventing missing fields or adding subsets', () => {
    expect(parseModelUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 125,
      prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } })).toEqual({
      source: 'provider', inputTokens: 100, outputTokens: 20, totalTokens: 125, cachedInputTokens: 40, reasoningOutputTokens: 5,
    })
    expect(parseModelUsage({ completion_tokens: 0 })).toEqual({ source: 'provider', outputTokens: 0 })
  })
  it.each([null, undefined, [], {}, { prompt_tokens: -1 }, { total_tokens: '12' }, { completion_tokens: 1.5 },
    { prompt_tokens: Infinity }, { total_tokens: Number.MAX_SAFE_INTEGER + 1 }])('rejects unusable usage %j', (value) => {
    expect(parseModelUsage(value)).toBeUndefined()
  })
  it('validates journals compatibly and rejects invalid persisted usage', () => {
    expect(isTaskRunEvent(call({ usage: undefined }))).toBe(true)
    expect(isTaskRunEvent(call())).toBe(true)
    expect(isTaskRunEvent(call({ usage: { source: 'provider', inputTokens: -1 } }))).toBe(false)
    expect(isModelUsage({ source: 'estimated', inputTokens: 10 })).toBe(false)
  })
  it('counts failed, unknown and partial attempts, without applying performance exclusions', () => {
    const result = aggregateUsageEvents([call(), call({ phase: 'failed', reason: '用户额度不足' }),
      call({ usage: undefined }), call({ usage: { source: 'provider', inputTokens: 7 } }),
      call({ usage: { source: 'provider', inputTokens: 0, outputTokens: 0, totalTokens: 0 } }),
    ], { days: 1 }, now)
    expect(result.totals).toEqual({ calls: 5, completeCalls: 3, partialCalls: 1, unknownCalls: 1,
      inputTokens: 207, outputTokens: 40, totalTokens: 240, cachedInputTokens: 80, reasoningOutputTokens: 10 })
    expect(result.daily).toEqual([{ date: '2026-10-16', ...result.totals }])
  })
  it('keeps reported total separate, including total-only reports', () => {
    expect(aggregateUsageEvents([call({ usage: { source: 'provider', inputTokens: 2, outputTokens: 3, totalTokens: 8 } }),
      call({ usage: { source: 'provider', totalTokens: 10 } })], {}, now).totals).toMatchObject({ totalTokens: 18, completeCalls: 1, partialCalls: 1 })
  })
  it('keeps unknown usage distinct from real zero and retains historical calls without timings', () => {
    expect(aggregateUsageEvents([call({ usage: undefined, durationMs: undefined })], {}, now).totals).toMatchObject({
      calls: 1, unknownCalls: 1, inputTokens: null, outputTokens: null, totalTokens: null,
    })
  })
  it('deduplicates by run and call, ignores starts and preserves retry attempts', () => {
    const end = call()
    const events = [end, end, call({ phase: 'started' }), { ...end, runId: 'another-run' }]
    const original = structuredClone(events)
    expect(aggregateUsageEvents(events, {}, now).totals).toMatchObject({ calls: 2, inputTokens: 200 })
    expect(events).toEqual(original)
  })
  it('supports the three dimensions and recovers identity from starts', () => {
    const events = [call(), call({ provider: 'Provider B', providerId: 'p2', modelId: 'link2' })]
    expect(aggregateUsageEvents(events, { dimension: 'provider' }, now).rows).toHaveLength(2)
    expect(aggregateUsageEvents(events, { dimension: 'modelName' }, now).rows).toMatchObject([{ provider: '', calls: 2, inputTokens: 200 }])
    expect(aggregateUsageEvents(events, { dimension: 'specificModel' }, now).rows).toHaveLength(2)
    const end = call({ provider: undefined, providerId: undefined, modelLabel: undefined, modelId: undefined })
    const start = call({ callId: end.callId, phase: 'started' })
    expect(aggregateUsageEvents([end, start], { dimension: 'specificModel' }, now).rows[0]).toMatchObject({ provider: 'Provider A', specificModel: 'Model A' })
  })
  it('uses local calendar boundaries, fills recent days and filters future records', () => {
    const events = [call({ at: new Date(2026, 9, 15, 23, 59, 59).toISOString() }),
      call({ at: new Date(2026, 9, 16, 0).toISOString() }), call({ at: new Date(2026, 9, 17, 0).toISOString() }),
      call({ at: new Date(2026, 8, 1).toISOString() })]
    expect(aggregateUsageEvents(events, { days: 1 }, now).totals.calls).toBe(1)
    const week = aggregateUsageEvents(events, { days: 7 }, now)
    expect(week.totals.calls).toBe(2)
    expect(week.daily).toHaveLength(7)
    expect(week.daily.at(-1)?.date).toBe('2026-10-10')
    expect(aggregateUsageEvents(events, { days: 30 }, now).daily).toHaveLength(30)
    expect(aggregateUsageEvents(events, { days: 'all' }, now).totals.calls).toBe(3)
    expect(aggregateUsageEvents([], { days: 'all' }, now).daily).toEqual([])
  })
  it('validates query values', () => {
    expect(() => aggregateUsageEvents([], { days: 2 as never }, now)).toThrow('days')
    expect(() => aggregateUsageEvents([], { dimension: 'wrong' as never }, now)).toThrow('dimension')
  })
})
