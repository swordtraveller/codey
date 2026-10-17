import { UsageAnalyticsPanel } from './UsageAnalyticsPanel'
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  Field, Select, Tab, TabList,
} from '@fluentui/react-components'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PerformanceAnalytics, PerformanceDimension } from '../../../shared/analytics'

type AnalyticsTab = 'quality' | 'performance' | 'behavior' | 'cost'
type Props = { open: boolean; onOpenChange: (open: boolean) => void }

function formatDuration(value: number | null): string {
  if (value === null) return '-'
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`
}

export function AnalyticsDialog({ open, onOpenChange }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<AnalyticsTab>('performance')
  const [dimension, setDimension] = useState<PerformanceDimension>('provider')
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<PerformanceAnalytics | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => { if (open) setTab('performance') }, [open])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setFailed(false)
    setData(null)
    void window.codey.getPerformanceAnalytics({ dimension }).then((result) => {
      if (!cancelled) setData(result)
    }).catch(() => {
      if (!cancelled) setFailed(true)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, dimension, revision])

  return (
    <Dialog open={open} onOpenChange={(_, state) => onOpenChange(state.open)}>
      <DialogSurface className="analytics-dialog-surface">
        <DialogBody className="analytics-dialog-body">
          <DialogTitle>{t('analytics')}</DialogTitle>
          <DialogContent className="analytics-dialog-content">
            <TabList className="analytics-tabs" selectedValue={tab} onTabSelect={(_, state) => setTab(state.value as AnalyticsTab)}>
              <Tab value="quality">{t('analyticsQuality')}</Tab>
              <Tab value="performance">{t('analyticsPerformance')}</Tab>
              <Tab value="behavior">{t('analyticsBehavior')}</Tab>
              <Tab value="cost">{t('analyticsCost')}</Tab>
            </TabList>
            {tab === 'performance' ? (
              <section className="analytics-panel" aria-label={t('analyticsPerformance')} aria-busy={loading}>
                <div className="analytics-toolbar">
                  <Field label={t('analyticsDimension')}>
                    <Select value={dimension} onChange={(_, state) => setDimension(state.value as PerformanceDimension)}>
                      <option value="provider">{t('analyticsProvider')}</option>
                      <option value="modelName">{t('analyticsModelName')}</option>
                      <option value="specificModel">{t('analyticsSpecificModel')}</option>
                    </Select>
                  </Field>
                  <Button appearance="subtle" size="small" onClick={() => setRevision((value) => value + 1)} disabled={loading}>
                    {loading ? t('loading') : t('refresh')}
                  </Button>
                </div>
                <p className="analytics-summary">{t('analyticsPerformanceDescription')}</p>
                <p className="analytics-summary">{t('analyticsTimingDescription')}</p>
                {failed ? <p className="dialog-error" role="alert">{t('unableLoadPerformanceAnalytics')}</p>
                  : loading ? <p className="analytics-empty" role="status">{t('loading')}</p> : data && (
                    <>
                      <p className="analytics-summary">{t('analyticsTotalCalls', { count: data.totalCalls })}</p>
                      {data.excludedQuotaCalls > 0 && <p className="analytics-summary">{t('analyticsExcludedQuotaCalls', { count: data.excludedQuotaCalls })}</p>}
                      {data.skippedCalls > 0 && <p className="analytics-summary">{t('analyticsSkippedCalls', { count: data.skippedCalls })}</p>}
                      {data.skippedJournals > 0 && <p className="dialog-error" role="status">{t('analyticsSkippedJournals', { count: data.skippedJournals })}</p>}
                      {data.rows.length ? (
                        <div className="analytics-table-wrap" tabIndex={0} role="region" aria-label={t('analyticsPerformance')}>
                          <table className="analytics-table">
                            <thead><tr>
                              {dimension !== 'modelName' && <th scope="col">{t('analyticsProvider')}</th>}
                              {dimension !== 'provider' && <th scope="col">{t('analyticsModelName')}</th>}
                              {dimension === 'specificModel' && <th scope="col">{t('analyticsSpecificModel')}</th>}
                              <th scope="col" className="analytics-number">{t('analyticsSamples')}</th><th scope="col" className="analytics-number">{t('analyticsSuccessRate')}</th><th scope="col" className="analytics-number">{t('analyticsSuccess')}</th>
                              <th scope="col" className="analytics-number">{t('analyticsFailure')}</th><th scope="col" className="analytics-number">{t('analyticsFirstToken')}</th>
                              <th scope="col" className="analytics-number">{t('analyticsAverage')}</th><th scope="col" className="analytics-number">{t('analyticsP50')}</th><th scope="col" className="analytics-number">{t('analyticsP95')}</th>
                            </tr></thead>
                            <tbody>{data.rows.map((row) => (
                              <tr key={row.key}>
                                {dimension !== 'modelName' && <td>{row.provider || t('analyticsUnknown')}</td>}
                                {dimension !== 'provider' && <td>{row.modelName || t('analyticsUnknown')}</td>}
                                {dimension === 'specificModel' && <td>{row.specificModel || t('analyticsUnknown')}</td>}
                                <td className="analytics-number">{row.sampleCount.toLocaleString()}</td>
                                <td className="analytics-number">{row.sampleCount > 0 ? `${(100 * row.successCount / row.sampleCount).toFixed(1)}%` : '—'}</td>
                                <td className="analytics-number">{row.successCount.toLocaleString()}</td>
                                <td className="analytics-number">{row.failureCount.toLocaleString()}</td>
                                <td className="analytics-number">{formatDuration(row.averageFirstTokenMs)}</td>
                                <td className="analytics-number">{formatDuration(row.averageDurationMs)}</td>
                                <td className="analytics-number">{formatDuration(row.p50DurationMs)}</td>
                                <td className="analytics-number">{formatDuration(row.p95DurationMs)}</td>
                              </tr>
                            ))}</tbody>
                          </table>
                        </div>
                      ) : <p className="analytics-empty">{t('analyticsNoData')}</p>}
                    </>
                  )}
              </section>
            ) : tab === 'cost' ? (open ? <UsageAnalyticsPanel /> : null) : <section className="analytics-panel analytics-empty-panel" aria-label={t(`analytics${tab === 'quality' ? 'Quality' : tab === 'behavior' ? 'Behavior' : 'Cost'}`)}><p className="analytics-empty">{t('analyticsUnderDevelopment')}</p></section>}
          </DialogContent>
          <DialogActions><Button appearance="secondary" onClick={() => onOpenChange(false)}>{t('close')}</Button></DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
