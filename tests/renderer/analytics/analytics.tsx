import { localDateKey } from '../../../src/shared/usage-calendar'
import { aggregateUsageEvents, type UsageAnalytics, type UsageAnalyticsQuery } from '../../../src/shared/usage-analytics'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { FluentProvider, webLightTheme, webDarkTheme } from '@fluentui/react-components'
import i18n from '../../../src/renderer/src/i18n'
import { AnalyticsDialog } from '../../../src/renderer/src/components/AnalyticsDialog'
import { aggregateModelCallEvents, type PerformanceAnalytics, type PerformanceAnalyticsQuery, type PerformanceDimension } from '../../../src/shared/analytics'
import type { TaskRunEvent } from '../../../src/shared/task-run'
import '../../../src/renderer/src/styles.css'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message) }
const events: TaskRunEvent[] = [0, 1, 2].map((index) => ({
  version: 1, id: `event-${index}`, runId: 'run', sequence: index + 1, at: '2026-10-16T08:00:00Z',
  type: 'model-call', phase: 'finished', callId: `call-${index}`, requestIndex: index,
  model: 'shared-model', modelName: 'shared-model', modelLabel: index === 2 ? 'Fast B' : 'Fast A',
  modelId: index === 2 ? 'link-b' : 'link-a', providerId: index === 2 ? 'b' : 'a',
  provider: index === 2 ? 'Provider B' : 'Provider A', durationMs: 100 + index * 100, firstTokenMs: 20 + index * 20,
}))
events.push({ ...events[0], id: 'quota-event', sequence: 4, type: 'model-call', phase: 'failed', callId: 'quota-call',
  requestIndex: 4, model: 'shared-model', reason: '用户额度不足, 剩余额度: ＄-1.093766', durationMs: 10 })
const result = (dimension: PerformanceDimension = 'provider') => aggregateModelCallEvents(events, { dimension })
const usageEvents: TaskRunEvent[] = events.map((event, index) => ({ ...event, at: new Date().toISOString(),
  usage: index < 2 ? { source: 'provider' as const, inputTokens: 100, outputTokens: 20 } : index === 3 ? { source: 'provider' as const, totalTokens: 7 } : undefined,
}))
let usageRequests: UsageAnalyticsQuery[] = []
let usageQuery: (value: UsageAnalyticsQuery) => Promise<UsageAnalytics> = async (value) => aggregateUsageEvents(usageEvents, value)
let requests: PerformanceAnalyticsQuery[] = []
let query: (value: PerformanceAnalyticsQuery) => Promise<PerformanceAnalytics> = async (value) => result(value.dimension)
Object.assign(window, { codey: { getUsageAnalytics: (value: UsageAnalyticsQuery) => { usageRequests.push(value); return usageQuery(value) }, getPerformanceAnalytics: (value: PerformanceAnalyticsQuery) => { requests.push(value); return query(value) } } })
let theme = webLightTheme
const root = createRoot(document.getElementById('root')!)
async function render(open = true): Promise<void> {
  await act(async () => { root.render(<FluentProvider theme={theme}><AnalyticsDialog open={open} onOpenChange={() => { void render(false) }} /></FluentProvider>) })
}
async function click(text: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button, [role="tab"]')].find((entry) => entry.textContent?.trim() === text
    || (entry.getAttribute('role') === 'tab' && entry.textContent?.includes(text)))
  assert(button, `missing button: ${text}`)
  await act(async () => { button.click() })
}
async function dimension(value: PerformanceDimension): Promise<void> {
  const select = document.querySelector('select')!
  assert(select, 'dimension select is visible')
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
const rows = () => document.querySelectorAll('tbody tr')
const text = () => document.body.textContent ?? ''
async function runTests(): Promise<object> {
  await i18n.changeLanguage('zh-CN')
  await render(false)
  assert(requests.length === 0, 'closed dialog must not load history')
  await render()
  assert(text().includes('统计分析') && rows().length === 2, 'Chinese provider view loads two providers')
  assert(text().includes('有效模型调用：3 次') && text().includes('已排除 1 次计费额度不足'), 'Chinese effective count and quota notice')
  assert(rows()[0].querySelector('.analytics-number')?.textContent === '2', 'quota failures excluded from table counts')
  assert(document.querySelectorAll('[role="tab"]').length === 4, 'four analytics tabs')
  await dimension('modelName')
  assert(rows().length === 1 && rows()[0].textContent?.includes('shared-model'), 'model names merge across providers')
  assert(!rows()[0].textContent?.includes('Provider A'), 'model name dimension does not split providers')
  await dimension('specificModel')
  assert(rows().length === 2 && text().includes('Fast B') && text().includes('Provider B'), 'specific models retain provider and nickname')
  for (const name of ['质量监控', '行为分析']) {
    await click(name)
    assert(document.querySelector('.analytics-empty-panel')?.textContent === '开发中', `${name} shows development placeholder`)
    assert(!document.querySelector('table'), 'no performance table in unimplemented tabs')
  }
  await click('性能追踪')
  await runUsageTests()
  await runCalendarTests()
  query = async () => { throw new Error('IPC failed') }
  await click('刷新')
  assert(document.querySelector('[role="alert"]')?.textContent === '无法读取性能统计数据', 'read failure is visible')
  assert(!text().includes('暂时没有'), 'failure is not presented as no data')
  query = async (value) => aggregateModelCallEvents([], value)
  await click('刷新')
  assert(text().includes('暂时没有可统计'), 'empty state is visible')
  query = async (value) => aggregateModelCallEvents(events.filter((event) => event.type === 'model-call' && event.phase === 'failed'), value)
  await click('刷新')
  assert(text().includes('有效模型调用：0 次') && text().includes('已排除 1 次计费额度不足') && !document.querySelector('table'), 'quota-only history explains excluded data')
  query = async (value) => ({ ...result(value.dimension), skippedCalls: 2, skippedJournals: 1 })
  await click('刷新')
  assert(text().includes('当前统计不完整') && text().includes('缺少有效耗时'), 'missing history warnings are visible')
  let finishOld!: (value: PerformanceAnalytics) => void
  query = () => new Promise((resolve) => { finishOld = resolve })
  await dimension('provider')
  assert(document.querySelector('.analytics-panel')?.getAttribute('aria-busy') === 'true', 'pending read is marked busy')
  query = async (value) => result(value.dimension)
  await dimension('modelName')
  await act(async () => { finishOld(result('provider')) })
  assert(rows().length === 1, 'late reply cannot overwrite newer dimension')
  await act(async () => { await i18n.changeLanguage('en') })
  assert(text().includes('Statistics & analytics') && text().includes('Model name'), 'English analytics translations work')
  assert(text().includes('Effective model calls: 3') && text().includes('Calls excluded due to insufficient billing quota: 1'), 'English quota notice')
  assert(i18n.t('performanceDiagnostics') === 'Performance diagnostics', 'diagnostics rename in English')
  for (const name of ['Quality monitoring', 'Behavior analysis']) {
    await click(name)
    assert(document.querySelector('.analytics-empty-panel')?.textContent === 'Under development', `${name} shows English development placeholder`)
  }
  await click('Performance tracking')
  await act(async () => { await i18n.changeLanguage('zh-CN') })
  assert(i18n.t('performanceDiagnostics') === '性能诊断', 'diagnostics rename in Chinese')
  await dimension('specificModel')
  const wideSurface = document.querySelector<HTMLElement>('.analytics-dialog-surface')!
  assert(wideSurface.getBoundingClientRect().width > 900, 'wide dialog is not capped by the Fluent default width')
  const wideTable = document.querySelector<HTMLElement>('.analytics-table-wrap')!
  assert(wideTable.scrollWidth <= wideTable.clientWidth + 1, 'wide window shows all timing columns without scrolling')
  const count = requests.length
  await render(false)
  await render()
  assert(requests.length === count + 1, 'reopening refreshes saved data')
  return { passed: 24 + calendarChecks.length, checks: [...calendarChecks, 'usage period', 'usage dimensions', 'usage coverage', 'usage unknown values', 'usage errors', 'usage race', 'usage empty state', 'usage localization', 'usage refresh', 'quota counts', 'quota-only history', 'localized quota notices', 'closed dialog', 'provider dimension', 'model-name merge', 'specific-model split', 'four tabs and development placeholders', 'read errors', 'empty data', 'partial-history warnings', 'request race', 'English and Chinese', 'diagnostics rename', 'refresh on reopen'] }
}
async function runLayoutTests(): Promise<object> {
  // Keep layout checks independent of the screenshot preview's sample data.
  usageQuery = async (value) => aggregateUsageEvents(usageEvents, value)
  const surface = document.querySelector<HTMLElement>('.analytics-dialog-surface')!
  const viewport = document.querySelector<HTMLElement>('.analytics-table-wrap')!
  const rect = surface.getBoundingClientRect()
  assert(rect.left >= -1 && rect.right <= window.innerWidth + 1, 'dialog fits narrow window')
  assert(viewport.clientWidth > 0 && viewport.scrollWidth > viewport.clientWidth, 'table has real horizontal overflow')
  viewport.scrollLeft = 150
  assert(viewport.scrollLeft > 0, 'table can actually scroll horizontally')
  viewport.scrollLeft = 0
  const performanceViewport = viewport.clientWidth
  const performanceWidth = viewport.scrollWidth
  await click('成本统计')
  const usageTable = document.querySelector<HTMLElement>('.usage-panel .analytics-table-wrap')!
  assert(usageTable, 'usage table is present for today')
  assert(usageTable.scrollWidth > usageTable.clientWidth, 'usage table overflows narrow window')
  usageTable.scrollLeft = 150
  assert(usageTable.scrollLeft > 0, 'usage table scrolls horizontally')
  usageTable.scrollLeft = 0
  await toggleCalendar()
  const calendarViewport = document.querySelector<HTMLElement>('.usage-calendar-scroll')!
  assert(calendarViewport.scrollWidth > calendarViewport.clientWidth, 'calendar overflows narrow window')
  calendarViewport.scrollLeft = 120
  assert(calendarViewport.scrollLeft > 0, 'calendar scrolls horizontally')
  calendarViewport.scrollLeft = 0
  return { calendarViewport: calendarViewport.clientWidth, calendarWidth: calendarViewport.scrollWidth, width: window.innerWidth, dialogWidth: rect.width, tableViewport: performanceViewport, tableWidth: performanceWidth, usageViewport: usageTable.clientWidth, usageWidth: usageTable.scrollWidth }
}
Object.assign(window, { runTests, runLayoutTests, showCalendarPreview, showCalendar: () => toggleCalendar(), showUsage: () => click('成本统计'), showPerformance: () => click('性能追踪') })

async function chooseUsage(label: string, value: string): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>('.usage-panel select[aria-label="' + label + '"]')!
  assert(select, 'usage select: ' + label)
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function runUsageTests(): Promise<void> {
  assert(usageRequests.length === 0, 'usage loads only when cost tab opens')
  await click('成本统计')
  assert(text().includes('调用 4 次') && text().includes('输入输出均已报告 2 次') && text().includes('部分用量 1 次')
    && text().includes('用量未知 1 次') && text().includes('覆盖率 50.0%'), 'usage coverage explains missing reports')
  assert(text().includes('输入：200') && text().includes('总计：247'), 'known totals include reported failed usage')
  assert(document.querySelectorAll('.usage-daily-table tbody tr').length === 1, 'default daily window includes today only')
  await chooseUsage('时间范围', '1')
  assert(document.querySelectorAll('.usage-daily-table tbody tr').length === 1, 'today shows one date')
  await chooseUsage('统计维度', 'modelName')
  assert(document.querySelectorAll('.usage-breakdown-table tbody tr').length === 1, 'usage model names merge')
  await chooseUsage('统计维度', 'specificModel')
  assert(document.querySelectorAll('.usage-breakdown-table tbody tr').length === 2 && text().includes('Fast B'), 'usage specific models split')
  usageQuery = async (value) => aggregateUsageEvents(usageEvents.map((event) => ({ ...event, usage: undefined })), value)
  await click('刷新')
  assert(text().includes('用量未知 4 次') && text().includes('输入：—'), 'unknown historical usage is not zero')
  usageQuery = async () => { throw new Error('read failed') }
  await click('刷新')
  assert(document.querySelector('[role="alert"]')?.textContent === '无法读取 token 用量统计', 'usage read errors shown')
  usageQuery = async (value) => aggregateUsageEvents([], value)
  await click('刷新')
  assert(text().includes('该时间范围内暂无已记录的模型调用'), 'usage empty state')
  let resolveOld!: (value: UsageAnalytics) => void
  usageQuery = () => new Promise((resolve) => { resolveOld = resolve })
  await chooseUsage('时间范围', '7')
  usageQuery = async (value) => ({ ...aggregateUsageEvents(usageEvents, value), skippedJournals: 1 })
  await chooseUsage('时间范围', '30')
  await act(async () => { resolveOld(aggregateUsageEvents([], { days: 7 })) })
  assert(document.querySelectorAll('.usage-daily-table tbody tr').length === 30, 'late usage response cannot overwrite latest query')
  assert(text().includes('当前统计不完整'), 'usage skipped journal notice')
  await act(async () => { await i18n.changeLanguage('en') })
  assert(text().includes('Daily token usage') && text().includes('Unknown: 1') && text().includes('Coverage: 50.0%'), 'usage English translations')
  usageQuery = async (value) => aggregateUsageEvents(usageEvents, value)
  await act(async () => { await i18n.changeLanguage('zh-CN') })
  await click('性能追踪')
}

const calendarChecks = ['calendar lazy load', 'calendar completed cache', 'calendar pending reuse', 'calendar refresh invalidation',
  'calendar year and stale replies', 'calendar date drilldown', 'calendar errors and retry', 'calendar missing usage styles',
  'calendar keyboard navigation', 'calendar localization', 'calendar closed panel ignores replies', 'calendar collapsed on reopen']
async function toggleCalendar(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>('.usage-calendar-toggle')!
  assert(button, 'calendar toggle exists')
  await act(async () => { button.click() })
}
async function chooseCalendar(value: string): Promise<void> {
  await chooseUsage(i18n.t('usageCalendarPeriod'), value)
}
async function runCalendarTests(): Promise<void> {
  const today = localDateKey(new Date())
  const year = new Date().getFullYear()
  const oldDate = `${year - 1}-01-02`
  const oldEvent = { ...usageEvents[0]!, id: 'old-calendar', callId: 'old-calendar', at: new Date(year - 1, 0, 2).toISOString() }
  const sample = [...usageEvents, oldEvent]
  const calendarCount = () => usageRequests.filter((request) => request.calendar !== undefined).length
  usageQuery = async (value) => aggregateUsageEvents(sample, value)
  await click('成本统计')
  const before = calendarCount()
  assert(document.querySelector('.usage-calendar-toggle')?.getAttribute('aria-expanded') === 'false', 'calendar initially collapsed')
  assert(!document.querySelector('.usage-calendar-grid') && before === 0, 'collapsed calendar does not compute or request')
  await click('刷新')
  assert(calendarCount() === before, 'collapsed refresh does not request calendar')
  await toggleCalendar()
  assert(calendarCount() === before + 1 && document.querySelectorAll('.usage-calendar-cell').length >= 365, 'expand requests a year once')
  assert(usageRequests.at(-1)?.calendar === 'recent', 'calendar has an independent recent year query')
  assert(document.querySelector('.usage-panel select[aria-label="时间范围"]')?.getAttribute('aria-label') === '时间范围'
    && (document.querySelector('.usage-panel select[aria-label="时间范围"]') as HTMLSelectElement).value === '1', 'expanding calendar preserves today details')
  const todayCell = document.querySelector<HTMLButtonElement>(`[data-date="${today}"]`)!
  assert(todayCell.dataset.state === 'partial' && todayCell.title.includes('50.0%'), 'partial usage has an explicit state and coverage')
  await act(async () => { todayCell.focus(); todayCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
  const previousWeek = new Date(); previousWeek.setDate(previousWeek.getDate() - 7)
  assert((document.activeElement as HTMLElement).dataset.date === localDateKey(previousWeek), 'left arrow navigates one week')
  await toggleCalendar(); await toggleCalendar()
  assert(calendarCount() === before + 1, 'collapse and reopen reuse completed request')
  await chooseCalendar(String(year - 1))
  assert(document.querySelector(`[data-date="${oldDate}"]`), 'historical year renders')
  await act(async () => { document.querySelector<HTMLButtonElement>(`[data-date="${oldDate}"]`)!.click() })
  assert(usageRequests.at(-1)?.date === oldDate && document.querySelectorAll('.usage-breakdown-table tbody tr').length === 1, 'click selects exact local day and loads breakdown')
  await chooseUsage('统计维度', 'specificModel')
  assert(usageRequests.at(-1)?.date === oldDate && usageRequests.at(-1)?.dimension === 'specificModel', 'dimension preserves selected day')
  await chooseUsage('时间范围', '1')
  assert(usageRequests.at(-1)?.days === 1 && usageRequests.at(-1)?.date === undefined, 'ordinary range exits selected day')
  const requested = calendarCount()
  await toggleCalendar(); await click('刷新')
  assert(calendarCount() === requested, 'refresh invalidates without loading collapsed calendar')
  await toggleCalendar()
  assert(calendarCount() === requested + 1, 'next expand refreshes invalidated cache')
  let resolveOld!: (value: UsageAnalytics) => void
  usageQuery = (value) => value.calendar !== undefined ? new Promise((resolve) => { resolveOld = resolve }) : Promise.resolve(aggregateUsageEvents(sample, value))
  await click('刷新日历')
  const pendingCount = calendarCount()
  await toggleCalendar(); await toggleCalendar()
  assert(calendarCount() === pendingCount, 'reopen pending calendar reuses in-flight request')
  usageQuery = async (value) => aggregateUsageEvents(sample, value)
  await chooseCalendar(String(year))
  await act(async () => { resolveOld(aggregateUsageEvents([], { calendar: year - 1 })) })
  assert(document.querySelector(`[data-date="${year}-01-01"]`) && !document.querySelector(`[data-date="${oldDate}"]`), 'old year reply cannot overwrite active year')
  usageQuery = async (value) => { if (value.calendar !== undefined) throw new Error('calendar read failed'); return aggregateUsageEvents(sample, value) }
  await click('刷新日历')
  assert(text().includes('无法读取用量日历') && document.querySelector('.usage-breakdown-table'), 'calendar error does not break details')
  usageQuery = async (value) => ({ ...aggregateUsageEvents(sample, value), skippedJournals: 1 })
  await click('刷新日历')
  assert(document.querySelector('.usage-calendar-grid') && document.querySelector('.usage-calendar')?.textContent?.includes('当前统计不完整'), 'calendar retry and corruption notice')
  await act(async () => { await i18n.changeLanguage('en') })
  assert(text().includes('Token usage calendar') && text().includes('Refresh calendar') && text().includes('Incomplete usage'), 'calendar English strings')
  await act(async () => { await i18n.changeLanguage('zh-CN') })
  usageQuery = (value) => value.calendar !== undefined ? new Promise((resolve) => { resolveOld = resolve }) : Promise.resolve(aggregateUsageEvents(sample, value))
  await click('刷新日历')
  const closingCount = calendarCount()
  await render(false)
  await act(async () => { resolveOld(aggregateUsageEvents(sample, { calendar: year })) })
  await render()
  usageQuery = async (value) => aggregateUsageEvents(usageEvents, value)
  await click('成本统计')
  assert(calendarCount() === closingCount && document.querySelector('.usage-calendar-toggle')?.getAttribute('aria-expanded') === 'false'
    && !document.querySelector('.usage-calendar-grid'), 'reopening panel stays collapsed and ignores closed request')
  await click('性能追踪')
}

async function showCalendarPreview(dark = false): Promise<void> {
  theme = dark ? webDarkTheme : webLightTheme
  await render()
  await click('成本统计')
  const previewEvents = Array.from({ length: 365 }, (_, index) => {
    const date = new Date(); date.setDate(date.getDate() - index); date.setHours(0, 0, 0, 0)
    return { ...usageEvents[0]!, id: 'preview-' + index, callId: 'preview-' + index, at: date.toISOString(),
      usage: index % 17 === 0 ? undefined : index % 19 === 0 ? { source: 'provider' as const, inputTokens: 0, outputTokens: 0 }
        : index % 13 === 0 ? { source: 'provider' as const, totalTokens: 150 }
          : { source: 'provider' as const, inputTokens: (index % 11 + 1) * 450, outputTokens: (index % 7) * 100 } }
  }).filter((_, index) => index % 5 !== 0)
  usageQuery = async (value) => aggregateUsageEvents(previewEvents, value)
  if (document.querySelector('.usage-calendar-toggle')?.getAttribute('aria-expanded') === 'true') await click('刷新日历')
  else await toggleCalendar()
  document.querySelector('.usage-calendar')?.scrollIntoView({ block: 'start' })
}
