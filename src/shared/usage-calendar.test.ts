import { describe, expect, it } from 'vitest'
import { aggregateUsageEvents } from './usage-analytics'
import { buildUsageCalendar, calendarRange, localDateKey, parseLocalDate } from './usage-calendar'
import type { TaskRunEvent } from './task-run'

const now = new Date(2026, 9, 16, 12)
function event(date: string, usage?: { source: 'provider'; inputTokens?: number; outputTokens?: number; totalTokens?: number }): Extract<TaskRunEvent, { type: 'model-call' }> {
  return { version: 1, id: date, runId: 'run', sequence: 1, type: 'model-call', phase: 'finished', callId: date,
    model: 'model', requestIndex: 1, at: parseLocalDate(date).toISOString(), usage }
}
describe('usage calendar', () => {
  it('defaults ordinary queries to today, separately supports a rolling year and full historical leap years', () => {
    expect(aggregateUsageEvents([], {}, now).daily.map((day) => day.date)).toEqual(['2026-10-16'])
    const data = aggregateUsageEvents([event('2024-02-29'), event('2026-10-16')], { calendar: 'recent' }, now)
    expect(data.calendarRange).toEqual({ from: '2025-10-17', to: '2026-10-16', firstRecordedDate: '2024-02-29' })
    expect(data.daily).toHaveLength(365)
    expect(data.totals.calls).toBe(1)
    const leap = aggregateUsageEvents([event('2024-02-29'), event('2025-01-01')], { calendar: 2024 }, now)
    expect(leap.daily).toHaveLength(366)
    expect(leap.totals.calls).toBe(1)
    expect(leap.daily.some((day) => day.date === '2024-02-29')).toBe(true)
    expect(localDateKey(calendarRange('recent', new Date(2024, 1, 28)).from)).toBe('2023-02-28')
  })
  it('queries exactly one local date and retains failed calls, cross-midnight start metadata and deduplication', () => {
    const terminal = { ...event('2026-10-15', { source: 'provider', inputTokens: 2, outputTokens: 3 }), phase: 'failed' as const }
    const start = { ...terminal, phase: 'started' as const, at: new Date(2026, 9, 14, 23, 59).toISOString(), providerId: 'p', provider: 'Provider' }
    const result = aggregateUsageEvents([start, terminal, terminal, event('2026-10-16')], { date: '2026-10-15' }, now)
    expect(result.daily).toHaveLength(1)
    expect(result.totals).toMatchObject({ calls: 1, totalTokens: 5 })
    expect(result.rows[0]?.provider).toBe('Provider')
    expect(aggregateUsageEvents([], { date: '2026-10-15' }, now).daily).toHaveLength(1)
  })
  it.each([{ calendar: 2027 }, { calendar: 1969 }, { calendar: 'all' }, { calendar: 2024.5 },
    { date: '2026-02-30' }, { date: '2026-10-17' }, { date: '2026-1-1' }, { date: '' },
    { calendar: 'recent', days: 1 }, { date: '2026-10-15', calendar: 2026 }, { date: '2026-10-15', days: 'all' }])('rejects invalid or conflicting query %j', (query) => {
    expect(() => aggregateUsageEvents([], query as never, now)).toThrow('analytics')
  })
  it('starts weeks on Monday, includes each day once, and never assigns usage to future dates', () => {
    const data = aggregateUsageEvents([event('2026-10-17')], { calendar: 2026 }, now)
    const { weeks } = buildUsageCalendar(data)
    expect(parseLocalDate(weeks[0]![0]!.date).getDay()).toBe(1)
    expect(weeks.every((week) => week.length === 7)).toBe(true)
    const cells = weeks.flat().filter((cell) => cell.state !== 'outside')
    expect(cells).toHaveLength(365)
    expect(new Set(cells.map((cell) => cell.date)).size).toBe(365)
    expect(cells.find((cell) => cell.date === '2026-10-17')).toMatchObject({ state: 'future', level: 0 })
    expect(data.totals.calls).toBe(0)
  })
  it('distinguishes absent, zero, unknown and partial usage; cache/reasoning are not extra totals', () => {
    const data = aggregateUsageEvents([
      event('2026-10-10', { source: 'provider', inputTokens: 0, outputTokens: 0 }), event('2026-10-11'),
      event('2026-10-12', { source: 'provider', totalTokens: 25 }),
      event('2026-10-13', { source: 'provider', inputTokens: 10, outputTokens: 20 }),
      { ...event('2026-10-13'), callId: 'unknown-extra' },
      event('2026-10-14', { source: 'provider', inputTokens: 7 }),
    ], { calendar: 'recent' }, now)
    const cells = buildUsageCalendar(data).weeks.flat()
    const state = (date: string) => cells.find((cell) => cell.date === date)?.state
    expect(state('2026-10-09')).toBe('empty')
    expect(state('2026-10-10')).toBe('zero')
    expect(state('2026-10-11')).toBe('unknown')
    expect(state('2026-10-12')).toBe('partial')
    expect(state('2026-10-13')).toBe('partial')
    expect(state('2026-10-14')).toBe('unknown')
    expect(data.totals.totalTokens).toBe(55)
  })
  it('uses discrete quantiles so an outlier does not wash out ordinary days', () => {
    const input = Array.from({ length: 8 }, (_, i) => event(`2026-10-${String(i + 1).padStart(2, '0')}`,
      { source: 'provider', inputTokens: 0, outputTokens: i === 7 ? 10000000 : i + 1 }))
    const result = buildUsageCalendar(aggregateUsageEvents(input, { calendar: 'recent' }, now))
    expect(result.thresholds).toEqual([2, 4, 6, 10000000])
    expect(result.weeks.flat().find((cell) => cell.date === '2026-10-06')?.level).toBe(3)
    const same = buildUsageCalendar(aggregateUsageEvents(input.map((call) => ({ ...call, usage: { source: 'provider', totalTokens: 5 } })), { calendar: 2026 }, now))
    expect(same.thresholds).toEqual([5])
    expect(new Set(same.weeks.flat().filter((cell) => cell.day?.calls).map((cell) => cell.level)).size).toBe(1)
    expect(buildUsageCalendar(aggregateUsageEvents([], { calendar: 'recent' }, now)).thresholds).toEqual([])
  })
})
