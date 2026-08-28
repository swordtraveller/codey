import { useEffect, useMemo, useState } from 'react'
import type { PerformanceTraceEvent } from '../../shared/types'

const scopeColors: Record<PerformanceTraceEvent['scope'], string> = {
  renderer: '#0f6cbd',
  main: '#107c10',
  agent: '#c239b3',
}

type TraceRecord = PerformanceTraceEvent & { timestamp: string }

function parseTrace(content: string): TraceRecord[] {
  return content.split('\n').flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line) as TraceRecord
      return value && typeof value.timestamp === 'string' && typeof value.phase === 'string' ? [value] : []
    } catch {
      return []
    }
  })
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return '—'
  return value < 1 ? '<1 ms' : value.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ms'
}

export function PerformanceTraceApp({ fileName }: { fileName: string }): React.JSX.Element {
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void window.codey.readPerformanceTraceFile(fileName).then((value) => {
      if (!cancelled) setContent(value)
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to read trace file')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [fileName])

  const records = useMemo(() => parseTrace(content), [content])
  const groups = useMemo(() => {
    const grouped = new Map<string, TraceRecord[]>()
    for (const record of records) grouped.set(record.traceId, [...(grouped.get(record.traceId) ?? []), record])
    return [...grouped.entries()].map(([traceId, events]) => ({ traceId, events }))
      .sort((a, b) => b.events[0].timestamp.localeCompare(a.events[0].timestamp))
  }, [records])
  const maxDuration = Math.max(1, ...records.map((record) => record.durationMs ?? 0))

  return (
    <main className="performance-trace-app">
      <header className="performance-trace-header">
        <div>
          <h1>Performance trace</h1>
          <p>{fileName} · {records.length.toLocaleString()} events</p>
        </div>
        <span>{records.length ? formatTime(records[0].timestamp) + ' – ' + formatTime(records[records.length - 1].timestamp) : ''}</span>
      </header>
      {loading && <p className="trace-empty">Loading…</p>}
      {!loading && error && <p className="trace-error">{error}</p>}
      {!loading && !error && records.length === 0 && <p className="trace-empty">No trace events in this file.</p>}
      {!loading && !error && groups.map((group) => (
        <section className="trace-group" key={group.traceId}>
          <h2>{group.traceId}</h2>
          <div className="trace-events">
            {group.events.map((record, index) => {
              const duration = record.durationMs ?? 0
              return (
                <div className="trace-event" key={record.timestamp + '-' + record.phase + '-' + index}>
                  <time>{formatTime(record.timestamp)}</time>
                  <span className="trace-scope" style={{ color: scopeColors[record.scope] }}>{record.scope}</span>
                  <strong title={record.phase}>{record.phase}</strong>
                  <div className="trace-bar-track"><div className="trace-bar" style={{ background: scopeColors[record.scope], width: Math.max(duration ? 2 : 0, duration / maxDuration * 100) + '%' }} /></div>
                  <span className="trace-duration">{formatDuration(record.durationMs)}</span>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </main>
  )
}
