import { Button, Field, Select } from '@fluentui/react-components'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UsageAnalytics } from '../../../shared/usage-analytics'
import { buildUsageCalendar, parseLocalDate, type UsageCalendarCell } from '../../../shared/usage-calendar'

type Props = { revision: number; selectedDate?: string; onSelectDate: (date: string) => void }
const format = (value: number | null): string => value === null ? '—' : value.toLocaleString()

/** Separate query lifecycle: a collapsed calendar never starts a history read. */
export function UsageCalendar({ revision, selectedDate, onSelectDate }: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [firstYear, setFirstYear] = useState(() => new Date().getFullYear())
  const [period, setPeriod] = useState<'recent' | number>('recent')
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState<UsageAnalytics | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [active, setActive] = useState<UsageCalendarCell | null>(null)
  // Retain both pending and completed requests for this mounted panel only.
  const cache = useRef(new Map<string, Promise<UsageAnalytics>>())
  const generation = useRef('')
  useEffect(() => {
    const version = `${revision}:${refresh}`
    if (generation.current !== version) { cache.current.clear(); generation.current = version }
    if (!expanded) return
    let cancelled = false
    const key = `${version}:${period}`
    setLoading(true); setFailed(false); setData(null); setActive(null)
    let request = cache.current.get(key)
    if (!request) {
      cache.current.clear()
      request = window.codey.getUsageAnalytics({ calendar: period })
      cache.current.set(key, request)
    }
    void request.then((result) => {
      if (!cancelled) {
        setData(result)
        if (result.calendarRange?.firstRecordedDate) setFirstYear(Number(result.calendarRange.firstRecordedDate.slice(0, 4)))
      }
    }).catch(() => {
      if (cache.current.get(key) === request) cache.current.delete(key)
      if (!cancelled) setFailed(true)
    }).finally(() => { if (!cancelled) setLoading(false) })
    // IPC journal reads cannot currently be aborted; never apply a stale result.
    return () => { cancelled = true }
  }, [expanded, period, revision, refresh])
  const calendar = useMemo(() => data ? buildUsageCalendar(data) : null, [data])
  const year = new Date().getFullYear()
  const years = Array.from({ length: Math.max(1, year - Math.max(1970, firstYear) + 1) }, (_, index) => year - index)
  const weekdayFormat = new Intl.DateTimeFormat(i18n.language, { weekday: 'short' })
  const monthFormat = new Intl.DateTimeFormat(i18n.language, { month: 'short' })
  const describe = (cell: UsageCalendarCell): string => {
    const day = cell.day
    const state = t(`usageCalendarState_${cell.state}`)
    if (cell.state === 'empty') return `${cell.date} · ${state}`
    if (!day || cell.state === 'future') return `${cell.date} · ${state}`
    return t('usageCalendarDay', { date: cell.date, state, total: format(day.totalTokens), input: format(day.inputTokens), output: format(day.outputTokens),
      calls: day.calls, coverage: day.calls ? `${(100 * day.completeCalls / day.calls).toFixed(1)}%` : '—' })
  }
  const cells = calendar?.weeks.flat() ?? []
  const navigable = cells.filter((cell) => cell.state !== 'outside' && cell.state !== 'future')
  const focusDate = active?.date ?? (navigable.some((cell) => cell.date === selectedDate) ? selectedDate : navigable.at(-1)?.date)
  const navigate = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const offsets: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }
    let target = event.key === 'Home' ? cells.indexOf(navigable[0]!) : event.key === 'End' ? cells.indexOf(navigable.at(-1)!) : index + (offsets[event.key] ?? 0)
    if (!(event.key in offsets) && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    target = Math.max(0, Math.min(cells.length - 1, target))
    const next = cells[target]
    if (!next || next.state === 'future' || next.state === 'outside') return
    event.currentTarget.closest('.usage-calendar-grid')?.querySelector<HTMLButtonElement>(`[data-date="${next.date}"]`)?.focus()
  }
  return <section className="usage-calendar">
    <Button appearance="subtle" className="usage-calendar-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {t('usageCalendarTitle')}
    </Button>
    {!expanded && <p className="analytics-summary">{t('usageCalendarLazy')}</p>}
    {expanded && <div id={id} aria-busy={loading}>
      <div className="analytics-toolbar">
        <Field label={t('usageCalendarPeriod')}><Select aria-label={t('usageCalendarPeriod')} value={String(period)} onChange={(_, value) => setPeriod(value.value === 'recent' ? 'recent' : Number(value.value))}>
          <option value="recent">{t('usageCalendarRecent')}</option>
          {years.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select></Field>
        <Button appearance="subtle" size="small" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{t('usageCalendarRefresh')}</Button>
      </div>
      {loading ? <p role="status" className="analytics-empty">{t('usageCalendarLoading')}</p>
        : failed ? <p role="alert" className="dialog-error">{t('usageCalendarError')}</p>
          : data && calendar && <>
            <p className="analytics-summary">{t('usageCalendarSummary', { tokens: format(data.totals.totalTokens),
              active: data.daily.filter((day) => day.calls > 0).length,
              peak: data.daily.some((day) => day.totalTokens !== null) ? format(Math.max(...data.daily.map((day) => day.totalTokens ?? 0))) : '—' })}</p>
            <p className="analytics-summary">{t('usageTiming', { zone: data.timeZone })}</p>
            {data.skippedJournals > 0 && <p className="dialog-error" role="status">{t('analyticsSkippedJournals', { count: data.skippedJournals })}</p>}
            <div className="usage-calendar-scroll" role="region" aria-label={t('usageCalendarTitle')} tabIndex={0}>
              <div className="usage-calendar-grid" style={{ gridTemplateColumns: `44px repeat(${calendar.weeks.length}, 14px)` }}>
                {[0, 2, 4, 6].map((day) => <span className="usage-calendar-weekday" key={day} style={{ gridColumn: 1, gridRow: day + 2 }}>{weekdayFormat.format(new Date(2024, 0, 1 + day))}</span>)}
                {calendar.weeks.map((week, column) => {
                  const monthDay = week.find((cell) => cell.state !== 'outside' && cell.date.endsWith('-01'))
                  return <span key={`month-${column}`} className="usage-calendar-month" style={{ gridColumn: column + 2, gridRow: 1 }}>{monthDay ? monthFormat.format(parseLocalDate(monthDay.date)) : ''}</span>
                })}
                {cells.map((cell, index) => cell.state === 'outside' ? null : <button key={cell.date} type="button"
                  className={`usage-calendar-cell usage-level-${cell.level} usage-state-${cell.state}`}
                  data-date={cell.date} data-state={cell.state} disabled={cell.state === 'future'}
                  style={{ gridColumn: Math.floor(index / 7) + 2, gridRow: index % 7 + 2 }}
                  title={describe(cell)} aria-label={describe(cell)} aria-pressed={selectedDate === cell.date}
                  tabIndex={cell.date === focusDate ? 0 : -1}
                  onMouseEnter={() => setActive(cell)} onFocus={() => setActive(cell)}
                  onKeyDown={(event) => navigate(event, index)} onClick={() => onSelectDate(cell.date)} />)}
              </div>
            </div>
            <div className="usage-calendar-legend">
              <span>{t('usageCalendarState_empty')}</span><span className="usage-calendar-swatch usage-level-0" />
              {calendar.thresholds.map((limit, index) => <span className="usage-calendar-band" key={limit}>
                <span className={`usage-calendar-swatch usage-level-${calendar.thresholds.length === 1 ? 4 : 1 + Math.round(3 * index / (calendar.thresholds.length - 1))}`} />
                {index === 0 ? '1' : format(calendar.thresholds[index - 1]! + 1)}–{format(limit)}
              </span>)}
              <span className="usage-calendar-swatch usage-level-0 usage-state-zero" /><span>{t('usageCalendarState_zero')}</span>
              <span className="usage-calendar-swatch usage-level-0 usage-state-unknown" /><span>{t('usageCalendarState_unknown')}</span>
              <span className="usage-calendar-swatch usage-level-2 usage-state-partial" /><span>{t('usageCalendarState_partial')}</span>
            </div>
            <p className="analytics-summary">{t('usageCalendarScale')}</p>
            <p className="usage-calendar-detail" role="status">{active ? describe(active) : t('usageCalendarHint')}</p>
          </>}
    </div>}
  </section>
}
