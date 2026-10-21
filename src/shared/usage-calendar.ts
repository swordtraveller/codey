import type { UsageAnalytics, UsageTotals } from './usage-analytics'

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function parseLocalDate(value: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid analytics date')
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year!, month! - 1, day)
  if (year! < 1970 || localDateKey(date) !== value) throw new Error('Invalid analytics date')
  return date
}
/** Exclusive end; calendar arithmetic avoids DST-length assumptions. */
export function calendarRange(value: 'recent' | number, now: Date): { from: Date; to: Date } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (value !== 'recent' && (!Number.isInteger(value) || value < 1970 || value > today.getFullYear())) {
    throw new Error('Invalid analytics calendar year')
  }
  if (value !== 'recent') return { from: new Date(value, 0, 1), to: new Date(value + 1, 0, 1) }
  const to = new Date(today); to.setDate(to.getDate() + 1)
  const from = new Date(to); from.setFullYear(from.getFullYear() - 1)
  // Feb 29 has no counterpart in a non-leap year: use Feb 28.
  if (from.getMonth() !== to.getMonth()) from.setDate(0)
  return { from, to }
}
export type UsageCalendarCell = {
  date: string
  day?: UsageTotals
  level: number
  state: 'empty' | 'zero' | 'known' | 'unknown' | 'partial' | 'future' | 'outside'
}
export function buildUsageCalendar(data: UsageAnalytics): { weeks: UsageCalendarCell[][]; thresholds: number[] } {
  const range = data.calendarRange
  if (!range) return { weeks: [], thresholds: [] }
  const from = parseLocalDate(range.from), to = parseLocalDate(range.to)
  const today = localDateKey(new Date(data.generatedAt))
  const days = new Map(data.daily.map((day) => [day.date, day]))
  const values = data.daily.map((day) => day.totalTokens).filter((value): value is number => value !== null && value > 0).sort((a, b) => a - b)
  // Discrete quartile upper bounds; equal values always use the same color.
  const thresholds = [...new Set([0.25, 0.5, 0.75, 1].map((p) => values[Math.max(0, Math.ceil(values.length * p) - 1)]).filter((value): value is number => value !== undefined))]
  const cursor = new Date(from); cursor.setDate(cursor.getDate() - (cursor.getDay() + 6) % 7)
  const weeks: UsageCalendarCell[][] = []
  while (cursor <= to) {
    const week: UsageCalendarCell[] = []
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = localDateKey(cursor), day = days.get(date)
      const value = day?.totalTokens
      const band = value != null && value > 0 ? thresholds.findIndex((limit) => value <= limit) : -1
      const level = band < 0 ? 0 : thresholds.length === 1 ? 4 : 1 + Math.round(3 * band / (thresholds.length - 1))
      const state = cursor < from || cursor > to ? 'outside' : date > today ? 'future' : !day?.calls ? 'empty'
        : value == null ? 'unknown' : day.completeCalls < day.calls ? 'partial' : value === 0 ? 'zero' : 'known'
      week.push({ date, day, level, state })
      cursor.setDate(cursor.getDate() + 1)
    }
    weeks.push(week)
  }
  return { weeks, thresholds }
}
