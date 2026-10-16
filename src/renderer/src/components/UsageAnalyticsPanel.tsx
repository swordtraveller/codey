import { Button, Field, Select } from '@fluentui/react-components'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PerformanceDimension } from '../../../shared/analytics'
import type { UsageAnalytics, UsageAnalyticsQuery, UsageTotals } from '../../../shared/usage-analytics'

const tokenFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens'] as const
const tokenLabels = ['usageInput', 'usageOutput', 'usageTotal', 'usageCache', 'usageReasoning'] as const
const format = (value: number | null): string => value === null ? '—' : value.toLocaleString()
const coverage = (value: UsageTotals): string => value.calls ? `${(100 * value.completeCalls / value.calls).toFixed(1)}%` : '—'
function UsageCells({ value }: { value: UsageTotals }): React.JSX.Element {
  return <><td className="analytics-number">{format(value.calls)}</td>
    <td className="analytics-number">{coverage(value)}</td>
    {tokenFields.map((field) => <td key={field} className="analytics-number">{format(value[field])}</td>)}
  </>
}

export function UsageAnalyticsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [dimension, setDimension] = useState<PerformanceDimension>('provider')
  const [days, setDays] = useState<NonNullable<UsageAnalyticsQuery['days']>>(30)
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<UsageAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    setLoading(true); setFailed(false); setData(null)
    void window.codey.getUsageAnalytics({ dimension, days }).then((result) => {
      if (!cancelled) setData(result)
    }).catch(() => { if (!cancelled) setFailed(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [dimension, days, revision])
  const headings = <><th scope="col" className="analytics-number">{t('usageCalls')}</th>
    <th scope="col" className="analytics-number">{t('usageCoverage')}</th>
    {tokenLabels.map((key) => <th key={key} scope="col" className="analytics-number">{t(key)}</th>)}
  </>
  return <section className="analytics-panel usage-panel" aria-label={t('analyticsCost')} aria-busy={loading}>
    <div className="analytics-toolbar">
      <Field label={t('usagePeriod')}><Select aria-label={t('usagePeriod')} value={String(days)} onChange={(_, state) => setDays(state.value === 'all' ? 'all' : Number(state.value) as 1 | 7 | 30)}>
        <option value="1">{t('usageToday')}</option><option value="7">{t('usageWeek')}</option>
        <option value="30">{t('usageMonth')}</option><option value="all">{t('usageAll')}</option>
      </Select></Field>
      <Field label={t('analyticsDimension')}><Select aria-label={t('analyticsDimension')} value={dimension} onChange={(_, state) => setDimension(state.value as PerformanceDimension)}>
        <option value="provider">{t('analyticsProvider')}</option><option value="modelName">{t('analyticsModelName')}</option>
        <option value="specificModel">{t('analyticsSpecificModel')}</option>
      </Select></Field>
      <Button appearance="subtle" size="small" disabled={loading} onClick={() => setRevision((value) => value + 1)}>{loading ? t('loading') : t('refresh')}</Button>
    </div>
    <p className="analytics-summary">{t('usageDescription')}</p>
    {failed ? <p className="dialog-error" role="alert">{t('usageLoadError')}</p>
      : loading ? <p className="analytics-empty" role="status">{t('loading')}</p> : data && <>
        <p className="analytics-summary">{t('usageSummary', { calls: data.totals.calls, complete: data.totals.completeCalls,
          partial: data.totals.partialCalls, unknown: data.totals.unknownCalls, coverage: coverage(data.totals) })}</p>
        <p className="analytics-summary">{t('usageTotals', { input: format(data.totals.inputTokens), output: format(data.totals.outputTokens), total: format(data.totals.totalTokens) })}</p>
        <p className="analytics-summary">{t('usageTiming', { zone: data.timeZone })}</p>
        <p className="analytics-summary">{t('usageCoverageDescription')}</p>
        {data.skippedJournals > 0 && <p className="dialog-error" role="status">{t('analyticsSkippedJournals', { count: data.skippedJournals })}</p>}
        {data.totals.calls === 0 ? <p className="analytics-empty">{t('usageNoData')}</p> : <>
          <h3 className="usage-heading">{t('usageDaily')}</h3>
          <div className="analytics-table-wrap" tabIndex={0} role="region" aria-label={t('usageDaily')}>
            <table className="analytics-table usage-daily-table"><thead><tr><th scope="col">{t('usageDate')}</th>{headings}</tr></thead>
              <tbody>{data.daily.map((day) => <tr key={day.date}><td>{day.date}</td><UsageCells value={day} /></tr>)}</tbody>
            </table>
          </div>
          <h3 className="usage-heading">{t('usageBreakdown')}</h3>
          <div className="analytics-table-wrap" tabIndex={0} role="region" aria-label={t('usageBreakdown')}>
            <table className="analytics-table usage-breakdown-table"><thead><tr>
              {dimension !== 'modelName' && <th scope="col">{t('analyticsProvider')}</th>}
              {dimension !== 'provider' && <th scope="col">{t('analyticsModelName')}</th>}
              {dimension === 'specificModel' && <th scope="col">{t('analyticsSpecificModel')}</th>}{headings}
            </tr></thead><tbody>{data.rows.map((row) => <tr key={row.key}>
              {dimension !== 'modelName' && <td>{row.provider || t('analyticsUnknown')}</td>}
              {dimension !== 'provider' && <td>{row.modelName || t('analyticsUnknown')}</td>}
              {dimension === 'specificModel' && <td>{row.specificModel || t('analyticsUnknown')}</td>}<UsageCells value={row} />
            </tr>)}</tbody></table>
          </div>
        </>}
      </>}
  </section>
}
