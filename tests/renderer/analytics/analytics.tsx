import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
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
const result = (dimension: PerformanceDimension = 'provider') => aggregateModelCallEvents(events, { dimension })
let requests: PerformanceAnalyticsQuery[] = []
let query: (value: PerformanceAnalyticsQuery) => Promise<PerformanceAnalytics> = async (value) => result(value.dimension)
Object.assign(window, { codey: { getPerformanceAnalytics: (value: PerformanceAnalyticsQuery) => { requests.push(value); return query(value) } } })
const root = createRoot(document.getElementById('root')!)
async function render(open = true): Promise<void> {
  await act(async () => { root.render(<FluentProvider theme={webLightTheme}><AnalyticsDialog open={open} onOpenChange={() => { void render(false) }} /></FluentProvider>) })
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
  assert(document.querySelectorAll('[role="tab"]').length === 4, 'four analytics tabs')
  await dimension('modelName')
  assert(rows().length === 1 && rows()[0].textContent?.includes('shared-model'), 'model names merge across providers')
  assert(!rows()[0].textContent?.includes('Provider A'), 'model name dimension does not split providers')
  await dimension('specificModel')
  assert(rows().length === 2 && text().includes('Fast B') && text().includes('Provider B'), 'specific models retain provider and nickname')
  for (const name of ['质量监控', '行为分析', '成本统计']) {
    await click(name)
    assert(document.querySelector('.analytics-empty-panel')?.textContent === '开发中', `${name} shows development placeholder`)
    assert(!document.querySelector('table'), 'no performance table in unimplemented tabs')
  }
  await click('性能追踪')
  query = async () => { throw new Error('IPC failed') }
  await click('刷新')
  assert(document.querySelector('[role="alert"]')?.textContent === '无法读取性能统计数据', 'read failure is visible')
  assert(!text().includes('暂时没有'), 'failure is not presented as no data')
  query = async (value) => aggregateModelCallEvents([], value)
  await click('刷新')
  assert(text().includes('暂时没有可统计'), 'empty state is visible')
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
  assert(i18n.t('performanceDiagnostics') === 'Performance diagnostics', 'diagnostics rename in English')
  for (const name of ['Quality monitoring', 'Behavior analysis', 'Cost statistics']) {
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
  return { passed: 12, checks: ['closed dialog', 'provider dimension', 'model-name merge', 'specific-model split', 'four tabs and development placeholders', 'read errors', 'empty data', 'partial-history warnings', 'request race', 'English and Chinese', 'diagnostics rename', 'refresh on reopen'] }
}
function runLayoutTests(): object {
  const surface = document.querySelector<HTMLElement>('.analytics-dialog-surface')!
  const viewport = document.querySelector<HTMLElement>('.analytics-table-wrap')!
  const rect = surface.getBoundingClientRect()
  assert(rect.left >= -1 && rect.right <= window.innerWidth + 1, 'dialog fits narrow window')
  assert(viewport.clientWidth > 0 && viewport.scrollWidth > viewport.clientWidth, 'table has real horizontal overflow')
  viewport.scrollLeft = 150
  assert(viewport.scrollLeft > 0, 'table can actually scroll horizontally')
  viewport.scrollLeft = 0
  return { width: window.innerWidth, dialogWidth: rect.width, tableViewport: viewport.clientWidth, tableWidth: viewport.scrollWidth }
}
Object.assign(window, { runTests, runLayoutTests })
