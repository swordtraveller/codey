import {
  Button,
  FluentProvider,
  Input,
  Spinner,
  webLightTheme,
} from '@fluentui/react-components'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { setAppLanguage } from './i18n'
import type {
  ColdIndexItem,
  ColdStorageFile,
  ContextDebugMessage,
  ContextDebugOverview,
  ContextLayerItem,
  TokenLimitSimulation,
} from '../../shared/types'

type Props = { projectId: string; conversationId: string }
type Layer = 'hot' | 'warm'

function VisibilityIcon({ visible }: { visible: boolean }): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2.2 10s2.8-4 7.8-4 7.8 4 7.8 4-2.8 4-7.8 4-7.8-4-7.8-4Z" />
      <circle cx="10" cy="10" r="2" />
      {!visible && <path d="m3 3 14 14" />}
    </svg>
  )
}

function formatTime(value: string): string {
  return value ? new Date(value).toLocaleString() : '—'
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value.toLocaleString()} B`
  const units = ['KB', 'MB', 'GB']
  let size = value
  let unit = -1
  do {
    size /= 1024
    unit += 1
  } while (size >= 1024 && unit < units.length - 1)
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`
}

function messageText(message: ContextDebugMessage): string {
  const tools = message.toolCalls?.length ? `\n\n${JSON.stringify(message.toolCalls, null, 2)}` : ''
  return `${message.content ?? ''}${tools}`.trim() || '—'
}

export function ContextDebugApp({ projectId, conversationId }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [overview, setOverview] = useState<ContextDebugOverview | null>(null)
  const [expanded, setExpanded] = useState<Record<string, ContextDebugMessage>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ColdIndexItem[]>([])
  const [simulationTokens, setSimulationTokens] = useState('')
  const [simulation, setSimulation] = useState<TokenLimitSimulation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [storagePathVisible, setStoragePathVisible] = useState(false)
  const revisionRef = useRef<string | null>(null)
  const refreshInFlightRef = useRef(false)

  useEffect(() => {
    void window.codey.getConfig().then((config) => setAppLanguage(config.language))
  }, [])

  const refresh = useCallback(async () => {
    if (!projectId || !conversationId || refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    try {
      const next = await window.codey.getContextDebugOverview(projectId, conversationId)
      revisionRef.current = next.revision
      setOverview(next)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('unableLoadContextDebugger'))
    } finally {
      refreshInFlightRef.current = false
    }
  }, [conversationId, projectId, t])

  const checkForChanges = useCallback(async () => {
    if (!projectId || !conversationId || refreshInFlightRef.current) return
    try {
      const revision = await window.codey.getContextDebugRevision(projectId, conversationId)
      if (revision !== revisionRef.current) await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('unableLoadContextDebugger'))
    }
  }, [conversationId, projectId, refresh, t])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void checkForChanges(), 1000)
    return () => window.clearInterval(timer)
  }, [checkForChanges, refresh])

  async function run(operation: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await operation()
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('debugOperationFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function readMessage(id: string, layer: Layer | 'cold'): Promise<void> {
    if (expanded[id]) {
      setExpanded((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      return
    }
    await run(async () => {
      const message = layer === 'cold'
        ? await window.codey.readColdMessage(projectId, conversationId, id)
        : await window.codey.readContextLayerMessage(projectId, conversationId, id)
      setExpanded((current) => ({ ...current, [id]: message }))
    })
  }

  const idle = overview?.runtimeState === 'idle'
  const snapshot = overview?.snapshot
  const requestStatus = !snapshot
    ? 'normal'
    : snapshot.requestTokens >= snapshot.modelMaxContext
      ? 'exceeded'
      : snapshot.requestTokens >= snapshot.triggerThreshold
        ? 'warning'
        : 'normal'

  function layerCard(item: ContextLayerItem, layer: Layer): React.JSX.Element {
    const full = expanded[item.id]
    const immutable = item.source === 'system'
    return (
      <article className="context-debug-message" key={item.id}>
        <div className="context-debug-message-head">
          <strong>{item.role}</strong>
          <span>{item.tokenCount.toLocaleString()} {t('tokens')}</span>
        </div>
        <div className="context-debug-tags">
          <span>{t(item.source)}</span>
          <span>{t(`region_${item.region}`)}</span>
          <span>{t(`representation_${item.representation}`)}</span>
          {item.pinnedToHot && <span>{t('pinnedToHot')}</span>}
          {item.pendingDemotion && <span>{t('pendingDemotion')}</span>}
        </div>
        <time>{formatTime(item.createdAt)}</time>
        <p>{item.preview || '—'}</p>
        {item.truthRefs.length > 0 && <code className="context-debug-pointer">{t('truthReferences')}: {item.truthRefs.join(', ')}</code>}
        {full && <pre className="context-debug-full">{messageText(full)}</pre>}
        <div className="context-debug-actions">
          <Button appearance="subtle" size="small" onClick={() => void readMessage(item.id, layer)}>
            {full ? t('collapse') : t(item.representation === 'summary' ? 'readSummary' : 'readOriginal')}
          </Button>
          {!immutable && (
            <Button
              size="small"
              disabled={!idle || busy || item.representation === 'summary'}
              onClick={() => void run(() => window.codey.setContextPin(projectId, conversationId, item.id, !item.pinnedToHot))}
            >
              {t(item.pinnedToHot ? 'unpinFromHot' : 'pinToHot')}
            </Button>
          )}
          {layer === 'hot' && !immutable && (
            <Button
              disabled={!idle || busy || item.pinnedToHot || item.representation === 'summary'}
              size="small"
              onClick={() => void run(() => window.codey.demoteContext(projectId, conversationId, item.id))}
            >
              {t('demoteToWarm')}
            </Button>
          )}
        </div>
      </article>
    )
  }

  function storageFileRow(label: string, file: ColdStorageFile): React.JSX.Element {
    return (
      <div className="context-debug-storage-file" key={label}>
        <div>
          <strong>{label}</strong>
          <span>{file.exists
            ? `${formatBytes(file.sizeBytes)} · ${formatTime(file.modifiedAt ?? '')}`
            : t('fileMissing')}</span>
        </div>
        {storagePathVisible
          ? <code title={file.path}>{file.path}</code>
          : <span className="context-debug-storage-hidden">{t('storageFolderHidden')}</span>}
      </div>
    )
  }

  function coldCard(item: ColdIndexItem): React.JSX.Element {
    const full = expanded[item.id]
    return (
      <article className="context-debug-message" key={item.id}>
        <div className="context-debug-message-head">
          <strong>{item.role}</strong>
          <span>{item.tokenCount.toLocaleString()} {t('tokens')}</span>
        </div>
        <div className="context-debug-tags">
          <span>{t(`coldKind_${item.kind}`)}</span>
          {item.kind === 'summary' && <span>{t('representation_summary')}</span>}
        </div>
        <time>{formatTime(item.createdAt)}</time>
        <p>{item.preview || '—'}</p>
        <code className="context-debug-pointer">{item.logicalPointer}</code>
        {item.truthRefs.length > 0 && <code className="context-debug-pointer">{t('truthReferences')}: {item.truthRefs.join(', ')}</code>}
        {full && <pre className="context-debug-full">{messageText(full)}</pre>}
        <div className="context-debug-actions">
          <Button appearance="subtle" size="small" onClick={() => void readMessage(item.id, 'cold')}>
            {full ? t('collapse') : t(item.kind === 'summary' ? 'readSummary' : 'readOriginal')}
          </Button>
        </div>
      </article>
    )
  }

  return (
    <FluentProvider className="context-debug-app" theme={webLightTheme}>
      <header className="context-debug-header">
        <div>
          <h1>{t('contextDebugger')}</h1>
          <p>{overview?.conversationTitle ?? t('loading')}</p>
        </div>
        <div className="context-debug-state">
          <span className={`context-debug-state-${overview?.runtimeState ?? 'running'}`}>
            {t(`state_${overview?.runtimeState ?? 'running'}`)}
          </span>
          <Button disabled={busy} onClick={() => void refresh()}>{t('refresh')}</Button>
        </div>
      </header>

      {error && <p className="context-debug-error" role="alert">{error}</p>}
      {!overview ? <Spinner label={t('loading')} /> : (
        <>
          <section className="context-debug-metrics">
            <div><span>{t('hot')}</span><strong>{snapshot?.hotTokens.toLocaleString() ?? 0} / {snapshot?.hotTokenBudget.toLocaleString() ?? 0}</strong></div>
            <div><span>{t('warm')}</span><strong>{snapshot?.warmTokens.toLocaleString() ?? 0} / {snapshot?.warmTokenBudget.toLocaleString() ?? 0}</strong></div>
            <div><span>{t('pinnedHotTokens')}</span><strong>{(snapshot?.pinnedHotTokens ?? 0).toLocaleString()}</strong></div>
            <div><span>{t('systemTokens')}</span><strong>{snapshot?.systemTokens.toLocaleString() ?? 0}</strong></div>
            <div><span>{t('toolDefinitionTokens')}</span><strong>{snapshot?.toolDefinitionTokens.toLocaleString() ?? 0}</strong></div>
            <div className={`context-debug-metric-${requestStatus}`}>
              <span>{t('requestTokens')}</span>
              <strong>{snapshot?.requestTokens.toLocaleString() ?? 0} · {t(requestStatus)}</strong>
            </div>
          </section>
          <p className="context-debug-note">
            {snapshot ? t('snapshotAt', { time: formatTime(snapshot.createdAt) }) : t('noSnapshot')}
            {!idle && ` · ${t('idleOnly')}`}
          </p>

          <main className="context-debug-layers">
            <section>
              <h2>{t('hot')} <small>{snapshot?.hot.length ?? 0}</small></h2>
              <p>{t('hotDescription')}</p>
              <div className="context-debug-list">{snapshot?.hot.map((item) => layerCard(item, 'hot'))}</div>
            </section>
            <section>
              <h2>{t('warm')} <small>{snapshot?.warm.length ?? 0}</small></h2>
              <p>{t('warmDescription')}</p>
              <div className="context-debug-list">{snapshot?.warm.map((item) => layerCard(item, 'warm'))}</div>
            </section>
            <section>
              <h2>{t('cold')} <small>{overview.coldTotal}</small></h2>
              <p>{t('coldDescription')}</p>
              <div className="context-debug-cold-index">
                <div className="context-debug-cold-index-head">
                  <strong>{t('coldIndex')}</strong>
                  <span className={`context-debug-index-${overview.coldStorage.indexStatus}`}>
                    {t(`indexStatus_${overview.coldStorage.indexStatus}`)}
                  </span>
                </div>
                <dl>
                  <div><dt>{t('persistedRecords')}</dt><dd>{overview.coldStorage.recordCount.toLocaleString()}</dd></div>
                  <div><dt>{t('summaryRecords')}</dt><dd>{overview.coldStorage.summaryCount.toLocaleString()}</dd></div>
                  <div><dt>{t('indexedData')}</dt><dd>{formatBytes(overview.coldStorage.indexedBytes)}</dd></div>
                  <div><dt>{t('lastPersisted')}</dt><dd>{formatTime(overview.coldStorage.lastPersistedAt ?? '')}</dd></div>
                </dl>
                <div className="context-debug-storage-head">
                  <span className="context-debug-storage-label">{t('storageFolder')}</span>
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<VisibilityIcon visible={storagePathVisible} />}
                    aria-label={t(storagePathVisible ? 'hideStorageFolder' : 'showStorageFolder')}
                    title={t(storagePathVisible ? 'hideStorageFolder' : 'showStorageFolder')}
                    onClick={() => setStoragePathVisible((visible) => !visible)}
                  />
                </div>
                {storagePathVisible
                  ? <code className="context-debug-storage-folder" title={overview.coldStorage.folderPath}>
                      {overview.coldStorage.folderPath}
                    </code>
                  : <span className="context-debug-storage-hidden">{t('storageFolderHidden')}</span>}
                <div className="context-debug-storage-files">
                  {storageFileRow('messages.jsonl', overview.coldStorage.messages)}
                  {storageFileRow('index.json', overview.coldStorage.index)}
                  {storageFileRow('overrides.json', overview.coldStorage.overrides)}
                  {storageFileRow('summaries.jsonl', overview.coldStorage.summaries)}
                  {storageFileRow('summary-index.json', overview.coldStorage.summaryIndex)}
                </div>
              </div>
              <div className="context-debug-list">{overview.cold.map(coldCard)}</div>
            </section>
          </main>

          <section className="context-debug-tools">
            <div>
              <h2>{t('coldSearch')}</h2>
              <div className="context-debug-inline">
                <Input value={searchQuery} onChange={(_, data) => setSearchQuery(data.value)} />
                <Button
                  disabled={!idle || busy || !searchQuery.trim()}
                  onClick={() => void run(async () => {
                    const result = await window.codey.searchColdContext(projectId, conversationId, searchQuery.trim())
                    setSearchResults(result.matches)
                  })}
                >{t('search')}</Button>
              </div>
              <div className="context-debug-search-results">{searchResults.map(coldCard)}</div>
            </div>
            <div>
              <h2>{t('tokenSimulation')}</h2>
              <div className="context-debug-inline">
                <Input type="number" min={0} value={simulationTokens} onChange={(_, data) => setSimulationTokens(data.value)} />
                <Button
                  disabled={!idle || busy || Number(simulationTokens) < 0 || !simulationTokens}
                  onClick={() => void run(async () => setSimulation(
                    await window.codey.simulateTokenLimit(projectId, conversationId, Number(simulationTokens)),
                  ))}
                >{t('simulate')}</Button>
              </div>
              {simulation && <p>{simulation.requestTokens.toLocaleString()} · {t(simulation.status)}</p>}
            </div>
          </section>

          <section className="context-debug-audit">
            <h2>{t('auditLog')}</h2>
            {overview.audit.length === 0 ? <p>{t('noAuditEvents')}</p> : (
              <ol>{[...overview.audit].reverse().map((event) => (
                <li key={event.id}>
                  <time>{formatTime(event.timestamp)}</time>
                  <strong>{t(`audit_${event.type}`)}</strong>
                  <span>{event.description}</span>
                </li>
              ))}</ol>
            )}
          </section>
        </>
      )}
    </FluentProvider>
  )
}
