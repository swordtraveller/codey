import { describe, expect, it } from 'vitest'
import { aggregateModelCallEvents } from './analytics'
import { isTaskRunEvent, type TaskRunEvent } from './task-run'

type ModelCall = Extract<TaskRunEvent, { type: 'model-call' }>
let sequence = 0
function event(overrides: Partial<ModelCall> = {}): ModelCall {
  sequence += 1
  return {
    version: 1, id: `event-${sequence}`, runId: 'run-1', sequence,
    at: '2026-10-16T08:00:00.000Z', type: 'model-call', callId: `call-${sequence}`,
    phase: 'finished', model: 'model-a', modelName: 'model-a', modelLabel: 'Fast A', modelId: 'link-a',
    provider: 'Provider A', providerId: 'provider-a', requestIndex: 1, durationMs: 100, firstTokenMs: 20,
    ...overrides,
  }
}
const fixtures = (): TaskRunEvent[] => [
  event(), event({ durationMs: 200, firstTokenMs: 40 }),
  event({ provider: 'Provider B', providerId: 'provider-b', modelId: 'link-b', modelLabel: 'Fast B', durationMs: 600, firstTokenMs: 60 }),
  event({ phase: 'failed', durationMs: 10, firstTokenMs: undefined }),
]

describe('performance analytics', () => {
  it('aggregates all models by stable provider identity', () => {
    const result = aggregateModelCallEvents(fixtures(), { dimension: 'provider' })
    expect(result.totalCalls).toBe(4)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toMatchObject({ provider: 'Provider A', modelName: '', specificModel: '',
      sampleCount: 3, successCount: 2, failureCount: 1, averageDurationMs: 150,
      p50DurationMs: 150, p95DurationMs: 195, averageFirstTokenMs: 30 })
  })
  it('merges the same model name across providers and different link nicknames', () => {
    const result = aggregateModelCallEvents(fixtures(), { dimension: 'modelName' })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ provider: '', modelName: 'model-a', specificModel: '',
      sampleCount: 4, successCount: 3, failureCount: 1, averageDurationMs: 300, p50DurationMs: 200, p95DurationMs: 560 })
  })
  it('keeps configured specific models linked to their provider', () => {
    const result = aggregateModelCallEvents(fixtures(), { dimension: 'specificModel' })
    expect(result.rows.map(({ provider, modelName, specificModel }) => ({ provider, modelName, specificModel }))).toEqual([
      { provider: 'Provider A', modelName: 'model-a', specificModel: 'Fast A' },
      { provider: 'Provider B', modelName: 'model-a', specificModel: 'Fast B' },
    ])
  })
  it('survives renames without merging distinct IDs with the same display name', () => {
    const events = [event(), event({ provider: 'Renamed', modelLabel: 'New nickname' }),
      event({ provider: 'Renamed', providerId: 'provider-b' })]
    expect(aggregateModelCallEvents(events).rows.map((row) => row.sampleCount).sort()).toEqual([1, 2])
    expect(aggregateModelCallEvents(events, { dimension: 'specificModel' }).rows).toHaveLength(2)
  })
  it('does not merge two model links under one provider or two distinct model names', () => {
    const events = [event(), event({ modelId: 'another-link' }), event({ model: 'model-b', modelName: 'model-b', modelId: 'link-b' })]
    expect(aggregateModelCallEvents(events, { dimension: 'provider' }).rows).toHaveLength(1)
    expect(aggregateModelCallEvents(events, { dimension: 'modelName' }).rows).toHaveLength(2)
    expect(aggregateModelCallEvents(events, { dimension: 'specificModel' }).rows).toHaveLength(3)
  })
  it('deduplicates terminals, scopes call IDs to runs, and tolerates out-of-order starts', () => {
    const end = event({ callId: 'same', modelName: undefined, modelLabel: undefined })
    const start = event({ callId: 'same', phase: 'started', modelLabel: 'From start', durationMs: undefined })
    const result = aggregateModelCallEvents([end, end, start, event({ callId: 'same', runId: 'run-2' })], { dimension: 'specificModel' })
    expect(result.totalCalls).toBe(2)
    expect(aggregateModelCallEvents([end, start], { dimension: 'specificModel' }).rows[0].specificModel).toBe('From start')
  })
  it('uses legacy model and provider labels without consulting current configuration', () => {
    const result = aggregateModelCallEvents([event({ modelName: undefined, modelLabel: undefined, modelId: undefined, providerId: undefined })], { dimension: 'specificModel' })
    expect(result.rows[0]).toMatchObject({ modelName: 'model-a', specificModel: 'model-a', provider: 'Provider A' })
  })
  it('does not fabricate durations for old or invalid records, or for in-flight calls', () => {
    const result = aggregateModelCallEvents([event({ durationMs: undefined }), event({ durationMs: -1 }),
      event({ durationMs: NaN }), event({ durationMs: Infinity }), event({ phase: 'started' })])
    expect(result).toMatchObject({ totalCalls: 0, skippedCalls: 4, rows: [] })
  })
  it('does not treat fast failures as successful response times', () => {
    expect(aggregateModelCallEvents([event({ phase: 'failed' })]).rows[0]).toMatchObject({
      sampleCount: 1, successCount: 0, failureCount: 1, averageDurationMs: null,
      p50DurationMs: null, p95DurationMs: null, averageFirstTokenMs: null,
    })
  })
  it('preserves zero latency and does not invent first response measurements', () => {
    const result = aggregateModelCallEvents([event({ durationMs: 0, firstTokenMs: undefined }), event({ firstTokenMs: 200 })])
    expect(result.rows[0]).toMatchObject({ averageDurationMs: 50, averageFirstTokenMs: null })
  })
  it('filters terminal timestamps with inclusive bounds', () => {
    const result = aggregateModelCallEvents([event(), event({ at: '2026-10-15T00:00:00Z' })], {
      from: '2026-10-16T08:00:00.000Z', to: '2026-10-16T08:00:00.000Z',
    })
    expect(result.totalCalls).toBe(1)
    expect(() => aggregateModelCallEvents([], { from: 'invalid' })).toThrow('timestamp')
    expect(() => aggregateModelCallEvents([], { from: '2026-10-17', to: '2026-10-16' })).toThrow('must not be after')
    expect(() => aggregateModelCallEvents([], { dimension: 'invalid' as never })).toThrow('dimension')
  })
  it('validates optional metadata while accepting old journal events', () => {
    expect(isTaskRunEvent(event({ modelName: undefined, modelLabel: undefined, providerId: undefined, modelId: undefined,
      durationMs: undefined, firstTokenMs: undefined }))).toBe(true)
    expect(isTaskRunEvent(event())).toBe(true)
    expect(isTaskRunEvent(event({ durationMs: -1 }))).toBe(false)
    expect(isTaskRunEvent(event({ firstTokenMs: Infinity }))).toBe(false)
    expect(isTaskRunEvent(event({ modelLabel: 3 as never }))).toBe(false)
  })
})
