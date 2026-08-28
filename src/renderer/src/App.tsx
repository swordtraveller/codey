import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Select,
  Switch,
  FluentProvider,
  Input,
  Textarea,
  webLightTheme,
} from '@fluentui/react-components'
import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type ClipboardEvent, type ErrorInfo, type FormEvent, type ReactNode, type RefObject } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { setAppLanguage } from './i18n'
import type { BridgeChannelStatus } from '../../shared/bridge'
import type {
  AgentLimitsConfig,
  AppLanguage,
  AssistantMessageBlock,
  ChatMessage,
  ContextCompressionNotice,
  ContextManagementConfig,
  ConversationRuntimeState,
  ConversationTurnRecord,
  ImageAttachment,
  ImageMediaType,
  PerformanceTraceFile,
  PerformanceTraceStatus,
} from '../../shared/types'
import { maximumImageAttachmentBytes, maximumImageAttachments, supportedImageMediaTypes } from '../../shared/image-attachments'
import {
  clearDevelopmentProgress,
  getDevelopmentProgress,
  replaceDevelopmentProgress,
  resetDevelopmentProgress,
  subscribeDevelopmentProgress,
  updateDevelopmentProgress,
} from './development-progress-store'
import {
  conversationHistoryBatchSize,
  expandConversationWindowStart,
  initialConversationWindowStart,
} from '../../shared/conversation-window'
import {
  defaultAgentLimitsConfig,
  defaultAppConfig,
  defaultContextManagementConfig,
  defaultModelConfig,
  maximumAgentLimit,
  type ModelConfig,
  type Project,
} from '../../shared/types'

const markdownPlugins = [remarkGfm]

function readImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve({
      id: crypto.randomUUID(),
      name: file.name || `clipboard-${crypto.randomUUID()}.${file.type.split('/')[1] ?? 'png'}`,
      mediaType: file.type as ImageMediaType,
      dataUrl: String(reader.result),
    })
    reader.readAsDataURL(file)
  })
}

function formatToolOutput(parameters: string): string {
  try {
    return JSON.stringify(JSON.parse(parameters), null, 2)
  } catch {
    return parameters
  }
}

function looksLikeMarkdown(content: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s)|\*\*[^*]+\*\*|`[^`]+`|\[[^]]+\]\([^)]+\)|(^|\n)\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?/.test(content)
}

class MarkdownErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {}

  render(): ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}

function copyText(content: string): void {
  void navigator.clipboard?.writeText(content)
}

function formatMessageTime(createdAt: string | undefined): string {
  if (!createdAt) return ''
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function isValidContextConfig(value: ContextManagementConfig): boolean {
  return Number.isInteger(value.safeOutputMargin) && value.safeOutputMargin >= 1 &&
    Number.isInteger(value.recentKeepRounds) && value.recentKeepRounds >= 1 && value.recentKeepRounds <= 20 &&
    Number.isInteger(value.hotTokenBudget) && value.hotTokenBudget >= 1_000 &&
    Number.isInteger(value.warmTokenBudget) && value.warmTokenBudget >= 0 &&
    Number.isInteger(value.coldRecallTokenBudget) && value.coldRecallTokenBudget >= 0
}
function isValidAgentLimits(value: AgentLimitsConfig): boolean {
  return Number.isInteger(value.modelRequestsPerRound) &&
    value.modelRequestsPerRound >= 1 && value.modelRequestsPerRound <= maximumAgentLimit &&
    Number.isInteger(value.toolCallsPerRequest) &&
    value.toolCallsPerRequest >= 1 && value.toolCallsPerRequest <= maximumAgentLimit
}

type ConversationTurn = ConversationTurnRecord & {
  projectId: string
  conversationId: string
  userMessageId: string
}

function ConversationStopwatch({ turn }: { turn: ConversationTurnRecord }): React.JSX.Element {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (turn.result !== 'processing') {
      return
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [turn.result])

  const totalMinutes = Math.floor(Math.max(0, (turn.endedAt ?? now) - turn.startedAt) / 60000)
  const duration = t('duration', {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  })
  const result = turn.result === 'processing'
    ? ''
    : turn.result === 'stopped'
      ? t('stopped')
      : turn.result === 'normal'
        ? t('normal')
        : turn.result === 'timeout'
          ? t('timeout')
          : t('otherError', { error: turn.error ?? 'Unknown' })

  return (
    <p className="turn-stopwatch">
      {turn.result === 'processing'
        ? t('processing', { duration })
        : t('completed', { duration, result })}
    </p>
  )
}
function CompressionMessage({ compression }: { compression: ContextCompressionNotice }): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="compression-message">
      <p>
        {t('contextCompressed', {
          original: compression.originalTokens.toLocaleString(),
          compressed: compression.compressedTokens.toLocaleString(),
          ratio: compression.compressionRatio.toFixed(2),
        })}
      </p>
      <p>{t('method', { method: compression.method })}</p>
    </div>
  )
}

function AssistantContent({ content, createdAt }: { content: string; createdAt?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const fallback = <p>{content}</p>
  const timestamp = formatMessageTime(createdAt)

  return (
    <div className="message-card">
      <div className="message-card-header">
        {timestamp && <time>{timestamp}</time>}
        <Button
          aria-label={t('copyMessage')}
          appearance="subtle"
          size="small"
          title={t('copyMessage')}
          onClick={() => copyText(content)}
        >
          {t('copy')}
        </Button>
      </div>
      {looksLikeMarkdown(content) ? (
        <MarkdownErrorBoundary fallback={fallback}>
          <div className="markdown-content">
            <Markdown remarkPlugins={markdownPlugins}>{content}</Markdown>
          </div>
        </MarkdownErrorBoundary>
      ) : (
        fallback
      )}
    </div>
  )
}
type FrontendServerToolResult = {
  serverId?: string
  status?: string
}

function parseFrontendServerResult(block: Extract<AssistantMessageBlock, { type: 'function_call' }>): FrontendServerToolResult | null {
  if (!block.result || block.resultError || !block.name.startsWith('frontend_')) return null
  try {
    return JSON.parse(block.result) as FrontendServerToolResult
  } catch {
    return null
  }
}

type NodeValidationStatus = 'passed' | 'failed' | 'timed_out' | 'cancelled'

type NodeValidationResult = {
  status: NodeValidationStatus
  summary: {
    total: number
    passed: number
    duration_ms: number
  }
  checks: Array<{
    script: string
    status: NodeValidationStatus
    exit_code: number
    duration_ms: number
    stdout: string
    stderr: string
  }>
}

function parseNodeValidationResult(block: Extract<AssistantMessageBlock, { type: 'function_call' }>): NodeValidationResult | null {
  if (block.name !== 'node_validate' || !block.result || block.resultError) return null
  try {
    const result = JSON.parse(block.result) as NodeValidationResult
    return result && Array.isArray(result.checks) && result.summary ? result : null
  } catch {
    return null
  }
}

function formatValidationDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`
}

function ValidationResultView({ result }: { result: NodeValidationResult }): React.JSX.Element {
  const { t } = useTranslation()
  const statusLabel = (status: NodeValidationStatus): string => t(`validationStatus_${status}`)

  return (
    <div className="validation-result">
      <div className="validation-summary">
        <span className={`validation-status validation-${result.status}`}>{statusLabel(result.status)}</span>
        <span>{t('validationSummary', {
          passed: result.summary.passed,
          total: result.summary.total,
          duration: formatValidationDuration(result.summary.duration_ms),
        })}</span>
      </div>
      {result.checks.map((check, index) => (
        <div className="validation-check" key={`${check.script}-${index}`}>
          <div className="validation-check-heading">
            <strong>{check.script}</strong>
            <span>{statusLabel(check.status)} · {formatValidationDuration(check.duration_ms)} · {t('exitCode')} {check.exit_code}</span>
          </div>
          {(check.stdout || check.stderr) && (
            <details className="validation-logs">
              <summary>{t('validationLogs')}</summary>
              {check.stdout && <pre><strong>{t('standardOutput')}</strong>{'\n'}{check.stdout}</pre>}
              {check.stderr && <pre><strong>{t('standardError')}</strong>{'\n'}{check.stderr}</pre>}
            </details>
          )}
        </div>
      ))}
    </div>
  )
}
function FunctionCallMessage({
  block,
  projectId,
  conversationId,
}: {
  block: Extract<AssistantMessageBlock, { type: 'function_call' }>
  projectId?: string
  conversationId?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [previewError, setPreviewError] = useState('')
  const server = parseFrontendServerResult(block)
  const validation = parseNodeValidationResult(block)
  const canPreview = (server?.status === 'starting' || server?.status === 'running') && Boolean(server.serverId && projectId && conversationId)
  const openPreview = async (): Promise<void> => {
    if (!projectId || !conversationId || !server?.serverId) return
    setPreviewError('')
    try {
      const result = await window.codey.openFrontendPreview(projectId, conversationId, server.serverId)
      if (result.status !== 'opened') setPreviewError(t(`preview.${result.status}`))
    } catch {
      setPreviewError(t('unableOpenPreview'))
    }
  }

  return (
    <details className={`function-call${block.resultError ? ' tool-error' : ''}`}>
      <summary>{block.name}{validation ? ` · ${t(`validationStatus_${validation.status}`)}` : ''}</summary>
      <div className="tool-output-section">
        <span>{t('toolParameters')}</span>
        <pre>{formatToolOutput(block.parameters)}</pre>
      </div>
      {block.result !== undefined && (
        <div className="tool-output-section">
          <span>{block.resultError ? t('toolError') : t('toolResult')}</span>
          {validation ? <ValidationResultView result={validation} /> : <pre>{formatToolOutput(block.result)}</pre>}
        </div>
      )}
      {canPreview && (
        <Button
          appearance="secondary"
          size="small"
          onClick={() => void openPreview()}
        >
          {t('openPreview')}
        </Button>
      )}
      {previewError && <p className="tool-preview-error">{previewError}</p>}
    </details>
  )
}

const MemoCompressionMessage = memo(CompressionMessage)
const MemoAssistantContent = memo(AssistantContent)
const MemoFunctionCallMessage = memo(FunctionCallMessage)

const ConversationMessage = memo(function ConversationMessage({
  message,
  projectId,
  conversationId,
  conversationTurn,
}: {
  message: ChatMessage
  projectId: string
  conversationId: string
  conversationTurn?: ConversationTurn
}): React.JSX.Element {
  const { t } = useTranslation()
  const messageTurn = message.turn ?? (
    conversationTurn && conversationTurn.userMessageId === message.id
      ? conversationTurn
      : undefined
  )

  return (
    <>
      <div className={`message ${message.role}`}>
        {message.compression ? (
          <MemoCompressionMessage compression={message.compression} />
        ) : message.role === 'assistant' && message.blocks?.length ? (
          message.blocks.map((block, index) =>
            block.type === 'content' ? (
              <MemoAssistantContent content={block.content} createdAt={message.createdAt} key={`${message.id}-${index}`} />
            ) : (
              <MemoFunctionCallMessage
                block={block}
                projectId={projectId}
                conversationId={conversationId}
                key={block.id}
              />
            ),
          )
        ) : message.role === 'assistant' ? (
          <MemoAssistantContent content={message.content} createdAt={message.createdAt} />
        ) : (
          <div className="user-message-content">
            <div className="message-card-header">
              {formatMessageTime(message.createdAt) && <time>{formatMessageTime(message.createdAt)}</time>}
              <Button
                aria-label={t('copyMessage')}
                appearance="subtle"
                size="small"
                title={t('copyMessage')}
                onClick={() => copyText(message.content)}
              >
                {t('copy')}
              </Button>
            </div>
            {message.images?.length ? (
              <div className="message-images">
                {message.images.map((image) => (
                  <img alt={image.name} key={image.id} src={image.dataUrl} />
                ))}
              </div>
            ) : null}
            {message.content && <p>{message.content}</p>}
          </div>
        )}
      </div>
      {messageTurn && <ConversationStopwatch turn={messageTurn} />}
    </>
  )
})

type VirtualWindow = { start: number; end: number }

const conversationEstimatedRowHeight = 180
const conversationVirtualOverscan = 5

function updateVirtualWindow(
  current: VirtualWindow,
  offsets: number[],
  scrollTop: number,
  viewportHeight: number,
): VirtualWindow {
  const total = offsets.length - 1
  if (total <= 0) return { start: 0, end: 0 }
  const lowerBound = (value: number): number => {
    let low = 0
    let high = total
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (offsets[middle + 1] <= value) low = middle + 1
      else high = middle
    }
    return Math.min(low, total - 1)
  }
  const start = Math.max(0, lowerBound(Math.max(0, scrollTop)) - conversationVirtualOverscan)
  const end = Math.min(total, lowerBound(Math.max(0, scrollTop + viewportHeight)) + conversationVirtualOverscan + 1)
  return current.start === start && current.end === end ? current : { start, end }
}

const VirtualizedConversationHistory = memo(function VirtualizedConversationHistory({
  messages,
  projectId,
  conversationId,
  conversationTurn,
  scrollContainerRef,
  shouldStickToBottom,
}: {
  messages: ChatMessage[]
  projectId: string
  conversationId: string
  conversationTurn?: ConversationTurn
  scrollContainerRef: RefObject<HTMLDivElement | null>
  shouldStickToBottom: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const latestInitialStart = initialConversationWindowStart(messages)
  const [startIndex, setStartIndex] = useState(latestInitialStart)
  const loadingOlderRef = useRef(false)
  const pendingAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const historyExpandedRef = useRef(false)
  const heightCacheRef = useRef(new Map<string, number>())
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const observedRowsRef = useRef(new Map<string, HTMLDivElement>())
  const rowRefCallbacksRef = useRef(new Map<string, (node: HTMLDivElement | null) => void>())
  const [heightVersion, setHeightVersion] = useState(0)
  const initialVisibleMessageCount = messages.length - latestInitialStart
  const [virtualWindow, setVirtualWindow] = useState<VirtualWindow>(() => ({
    start: latestInitialStart + Math.max(0, initialVisibleMessageCount - 12),
    end: messages.length,
  }))
  const scrollFrameRef = useRef<number | null>(null)
  const visibleStartIndex = historyExpandedRef.current
    ? Math.min(startIndex, latestInitialStart)
    : latestInitialStart
  const hasOlderMessages = visibleStartIndex > 0
  const historyFoldHeight = hasOlderMessages ? 36 : 0
  const visibleMessages = useMemo(() => messages.slice(visibleStartIndex), [messages, visibleStartIndex])
  const layout = useMemo(() => {
    const offsets = [0]
    for (const message of visibleMessages) {
      offsets.push(offsets.at(-1)! + (heightCacheRef.current.get(message.id) ?? conversationEstimatedRowHeight))
    }
    return { offsets, totalHeight: offsets.at(-1) ?? 0 }
  }, [visibleMessages, heightVersion])

  const updateWindow = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const next = updateVirtualWindow(
      { start: 0, end: 0 },
      layout.offsets,
      Math.max(0, container.scrollTop - historyFoldHeight),
      container.clientHeight,
    )
    setVirtualWindow({
      start: visibleStartIndex + next.start,
      end: visibleStartIndex + next.end,
    })
  }, [historyFoldHeight, layout.offsets, scrollContainerRef, visibleStartIndex])

  const scheduleWindowUpdate = useCallback(() => {
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      updateWindow()
    })
  }, [updateWindow])

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const id = entry.target.getAttribute('data-message-id')
        if (!id) continue
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
        if (height > 0 && heightCacheRef.current.get(id) !== height) {
          heightCacheRef.current.set(id, height)
          changed = true
        }
      }
      if (changed) setHeightVersion((version) => version + 1)
    })
    resizeObserverRef.current = observer
    return () => {
      observer.disconnect()
      observedRowsRef.current.clear()
      rowRefCallbacksRef.current.clear()
      resizeObserverRef.current = null
    }
  }, [])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const onScroll = (): void => {
      scheduleWindowUpdate()
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [scheduleWindowUpdate, scrollContainerRef])

  // Stream progress is rendered outside this component, so this effect only runs for
  // history changes and never performs layout work for individual stream deltas.
  useEffect(() => {
    if (!shouldStickToBottom) return
    const container = scrollContainerRef.current
    if (!container) return
    const frame = window.requestAnimationFrame(() => {
      container.scrollTo({ top: Number.MAX_SAFE_INTEGER })
      scheduleWindowUpdate()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages.length, scheduleWindowUpdate, scrollContainerRef, shouldStickToBottom])

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current
    const container = scrollContainerRef.current
    if (!anchor || !container) return
    container.scrollTop = anchor.scrollTop + (container.scrollHeight - anchor.scrollHeight)
    pendingAnchorRef.current = null
    loadingOlderRef.current = false
    scheduleWindowUpdate()
  }, [scheduleWindowUpdate, scrollContainerRef, visibleStartIndex])

  const previousMessageCountRef = useRef(messages.length)
  useLayoutEffect(() => {
    if (previousMessageCountRef.current === messages.length) return
    previousMessageCountRef.current = messages.length
    if (!shouldStickToBottom) return
    const nextStart = historyExpandedRef.current
      ? visibleStartIndex
      : initialConversationWindowStart(messages)
    const nextLength = messages.length - nextStart
    setVirtualWindow({
      start: nextStart + Math.max(0, nextLength - 12),
      end: messages.length,
    })
  }, [messages.length, shouldStickToBottom, visibleStartIndex])

  const loadOlderMessages = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container || !hasOlderMessages || loadingOlderRef.current) return
    loadingOlderRef.current = true
    historyExpandedRef.current = true
    pendingAnchorRef.current = {
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    }
    setStartIndex((current) => expandConversationWindowStart(
      messages,
      Math.min(current, initialConversationWindowStart(messages)),
      conversationHistoryBatchSize,
    ))
  }, [hasOlderMessages, messages, scrollContainerRef])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || !hasOlderMessages) return
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0 && container.scrollTop <= 1) loadOlderMessages()
    }
    container.addEventListener('wheel', onWheel, { passive: true })
    return () => container.removeEventListener('wheel', onWheel)
  }, [hasOlderMessages, loadOlderMessages, scrollContainerRef])

  useEffect(() => {
    scheduleWindowUpdate()
  }, [layout.offsets, scheduleWindowUpdate])

  const getRowRef = useCallback((id: string) => {
    const existing = rowRefCallbacksRef.current.get(id)
    if (existing) return existing
    const callback = (node: HTMLDivElement | null): void => {
      const previous = observedRowsRef.current.get(id)
      if (previous && previous !== node) {
        resizeObserverRef.current?.unobserve(previous)
        observedRowsRef.current.delete(id)
      }
      if (!node) {
        rowRefCallbacksRef.current.delete(id)
        return
      }
      observedRowsRef.current.set(id, node)
      resizeObserverRef.current?.observe(node)
    }
    rowRefCallbacksRef.current.set(id, callback)
    return callback
  }, [])
  const renderedStart = Math.min(
    Math.max(0, virtualWindow.start - visibleStartIndex),
    visibleMessages.length,
  )
  const renderedEnd = Math.min(
    Math.max(renderedStart, virtualWindow.end - visibleStartIndex),
    visibleMessages.length,
  )
  const topHeight = layout.offsets[renderedStart] ?? 0
  const bottomHeight = Math.max(0, layout.totalHeight - (layout.offsets[renderedEnd] ?? layout.totalHeight))

  return (
    <>
      {hasOlderMessages && (
        <div className="conversation-history-fold">
          <Button appearance="subtle" size="small" onClick={loadOlderMessages}>
            {t('loadOlderConversationRounds', {
              count: Math.min(
                conversationHistoryBatchSize,
                messages.slice(0, visibleStartIndex).filter((message) => message.role === 'user').length,
              ),
            })}
          </Button>
        </div>
      )}
      <div aria-hidden="true" className="conversation-virtual-spacer" style={{ height: topHeight }} />
      {visibleMessages.slice(renderedStart, renderedEnd).map((message) => (
        <div className="conversation-message-row" data-message-id={message.id} key={message.id} ref={getRowRef(message.id)}>
          <ConversationMessage
            message={message}
            projectId={projectId}
            conversationId={conversationId}
            conversationTurn={conversationTurn}
          />
        </div>
      ))}
      <div aria-hidden="true" className="conversation-virtual-spacer" style={{ height: bottomHeight }} />
    </>
  )
})


function LiveAssistantContent({ content, createdAt }: { content: string; createdAt?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const timestamp = formatMessageTime(createdAt)

  return (
    <div className="message-card">
      <div className="message-card-header">
        {timestamp && <time>{timestamp}</time>}
        <Button
          aria-label={t('copyMessage')}
          appearance="subtle"
          size="small"
          title={t('copyMessage')}
          onClick={() => copyText(content)}
        >
          {t('copy')}
        </Button>
      </div>
      <p className="live-response-text">{content}</p>
    </div>
  )
}

function LiveFunctionCallMessage({
  block,
}: {
  block: Extract<AssistantMessageBlock, { type: 'function_call' }>
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <details className="function-call">
      <summary>{block.name}</summary>
      <div className="tool-output-section">
        <span>{t('toolParameters')}</span>
        <pre>{block.parameters}</pre>
      </div>
    </details>
  )
}

function LiveDevelopmentResponse({
  conversationKey,
  projectId,
  conversationId,
  createdAt,
}: {
  conversationKey: string
  projectId: string
  conversationId: string
  createdAt?: string
}): React.JSX.Element | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeDevelopmentProgress(conversationKey, listener),
    [conversationKey],
  )
  const getSnapshot = useCallback(() => getDevelopmentProgress(conversationKey), [conversationKey])
  const progress = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (progress.timeline.length === 0 && progress.streamingBlocks.length === 0) return null

  return (
    <div className="message assistant live-response">
      {progress.timeline.map((item, index) =>
        item.type === 'compression' ? (
          <MemoCompressionMessage compression={item.compression} key={`live-compression-${index}`} />
        ) : item.block.type === 'content' ? (
          <MemoAssistantContent content={item.block.content} createdAt={createdAt} key={`live-block-${index}`} />
        ) : (
          <MemoFunctionCallMessage
            block={item.block}
            projectId={projectId}
            conversationId={conversationId}
            key={item.block.id || `live-block-${index}`}
          />
        ),
      )}
      {progress.streamingBlocks.map((block, index) =>
        block.type === 'content' ? (
          <LiveAssistantContent content={block.content} createdAt={createdAt} key={`stream-block-${index}`} />
        ) : (
          <LiveFunctionCallMessage block={block} key={block.id || `stream-block-${index}`} />
        ),
      )}
    </div>
  )
}

type ContextStrategyMode = 'default' | 'layered' | 'custom'

function contextStrategyMode(value: ContextManagementConfig, customStrategyAvailable: boolean): ContextStrategyMode {
  if (customStrategyAvailable && value.customStrategyEnabled) return 'custom'
  return value.layeredEnabled ? 'layered' : 'default'
}

function ContextSettingsFields({
  value,
  disabled = false,
  showCustomStrategy = false,
  onChange,
}: {
  value: ContextManagementConfig
  disabled?: boolean
  showCustomStrategy?: boolean
  onChange: (patch: Partial<ContextManagementConfig>) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const strategyMode = contextStrategyMode(value, showCustomStrategy)

  function setStrategyMode(mode: ContextStrategyMode): void {
    if (mode === 'custom') {
      onChange({ layeredEnabled: false, customStrategyEnabled: true })
      return
    }
    onChange({
      layeredEnabled: mode === 'layered',
      customStrategyEnabled: false,
    })
  }

  return (
    <div className="context-settings-fields">
      <Field label={t('contextStrategyMode')}>
        <Select
          disabled={disabled}
          value={strategyMode}
          onChange={(_, data) => setStrategyMode(data.value as ContextStrategyMode)}
        >
          <option value="default">{t('contextStrategyDefault')}</option>
          <option value="layered">{t('contextStrategyLayered')}</option>
          {showCustomStrategy && <option value="custom">{t('contextStrategyCustom')}</option>}
        </Select>
      </Field>

      {strategyMode === 'custom' ? (
        <>
          <Field label={t('customContextStrategyScript')}>
            <Textarea
              disabled={disabled}
              resize="vertical"
              value={value.customStrategyScript ?? ''}
              onChange={(_, data) => onChange({ customStrategyScript: data.value })}
              placeholder={t('customContextStrategyPlaceholder')}
              rows={12}
              onKeyDown={(event) => {
                if (event.key !== 'Tab') return
                event.preventDefault()
                const textarea = event.currentTarget
                const start = textarea.selectionStart
                const end = textarea.selectionEnd
                const current = value.customStrategyScript ?? ''
                const next = `${current.slice(0, start)}\t${current.slice(end)}`
                onChange({ customStrategyScript: next })
                window.requestAnimationFrame(() => {
                  textarea.selectionStart = start + 1
                  textarea.selectionEnd = start + 1
                })
              }}
            />
          </Field>
          <Field label={t('outputTokenMargin')} required>
            <Input
              disabled={disabled}
              min={1}
              step={1000}
              type="number"
              value={String(value.safeOutputMargin)}
              onChange={(_, data) => onChange({ safeOutputMargin: Number(data.value) })}
            />
          </Field>
        </>
      ) : (
        <>
          <Switch
            checked={value.filterEnabled}
            disabled={disabled}
            label={t('contextFilter')}
            onChange={(_, data) => onChange({ filterEnabled: data.checked })}
          />
          <Switch
            checked={value.rewriteEnabled}
            disabled={disabled}
            label={t('contextRewrite')}
            onChange={(_, data) => onChange({ rewriteEnabled: data.checked })}
          />
          <Switch
            checked={value.truncateEnabled}
            disabled={disabled}
            label={t('contextTruncate')}
            onChange={(_, data) => onChange({ truncateEnabled: data.checked })}
          />
          <Field label={t('outputTokenMargin')} required>
            <Input
              disabled={disabled}
              min={1}
              step={1000}
              type="number"
              value={String(value.safeOutputMargin)}
              onChange={(_, data) => onChange({ safeOutputMargin: Number(data.value) })}
            />
          </Field>
          <Field label={t('recentRounds')} required>
            <Input
              disabled={disabled}
              max={20}
              min={1}
              type="number"
              value={String(value.recentKeepRounds)}
              onChange={(_, data) => onChange({ recentKeepRounds: Number(data.value) })}
            />
          </Field>
          {strategyMode === 'layered' && (
            <div className="context-budgets">
              <Field label={t('hotTokenBudget')} required>
                <Input
                  disabled={disabled}
                  min={1000}
                  step={1000}
                  type="number"
                  value={String(value.hotTokenBudget)}
                  onChange={(_, data) => onChange({ hotTokenBudget: Number(data.value) })}
                />
              </Field>
              <Field label={t('warmTokenBudget')} required>
                <Input
                  disabled={disabled}
                  min={0}
                  step={1000}
                  type="number"
                  value={String(value.warmTokenBudget)}
                  onChange={(_, data) => onChange({ warmTokenBudget: Number(data.value) })}
                />
              </Field>
              <Field label={t('coldRecallTokenBudget')} required>
                <Input
                  disabled={disabled}
                  min={0}
                  step={1000}
                  type="number"
                  value={String(value.coldRecallTokenBudget)}
                  onChange={(_, data) => onChange({ coldRecallTokenBudget: Number(data.value) })}
                />
              </Field>
            </div>
          )}
        </>
      )}
    </div>
  )
}
type ComposerProps = {
  canSend: boolean
  configured: boolean
  conversationWorking: boolean
  hasActiveConversation: boolean
  hasProjectFolders: boolean
  interactionLocked: boolean
  networkAccessEnabled: boolean
  stopping: boolean
  onError: (message: string) => void
  onNetworkAccessChange: (enabled: boolean) => void
  onStop: () => void
  onSubmit: (content: string, images: ImageAttachment[]) => boolean
}

const Composer = memo(function Composer({
  canSend,
  configured,
  conversationWorking,
  hasActiveConversation,
  hasProjectFolders,
  interactionLocked,
  networkAccessEnabled,
  stopping,
  onError,
  onNetworkAccessChange,
  onStop,
  onSubmit,
}: ComposerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const [draftImages, setDraftImages] = useState<ImageAttachment[]>([])
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const attachmentMenuRef = useRef<HTMLDivElement>(null)
  const draftImagesRef = useRef<ImageAttachment[]>([])
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!attachmentMenuOpen) return
    function closeAttachmentMenu(event: MouseEvent): void {
      if (!attachmentMenuRef.current?.contains(event.target as Node)) setAttachmentMenuOpen(false)
    }
    function closeAttachmentMenuOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setAttachmentMenuOpen(false)
    }
    document.addEventListener('mousedown', closeAttachmentMenu)
    document.addEventListener('keydown', closeAttachmentMenuOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeAttachmentMenu)
      document.removeEventListener('keydown', closeAttachmentMenuOnEscape)
    }
  }, [attachmentMenuOpen])

  function replaceDraftImages(images: ImageAttachment[]): void {
    draftImagesRef.current = images
    setDraftImages(images)
  }

  function appendImageAttachments(attachments: ImageAttachment[]): void {
    const current = draftImagesRef.current
    if (current.length + attachments.length > maximumImageAttachments) {
      onError(t('tooManyImages', { count: maximumImageAttachments }))
      return
    }
    replaceDraftImages([...current, ...attachments])
    onError('')
  }

  async function addImageFiles(files: File[]): Promise<void> {
    if (files.length === 0) return
    if (draftImagesRef.current.length + files.length > maximumImageAttachments) {
      onError(t('tooManyImages', { count: maximumImageAttachments }))
      return
    }
    if (files.some((file) => !supportedImageMediaTypes.includes(file.type as ImageMediaType))) {
      onError(t('unsupportedImage'))
      return
    }
    if (files.some((file) => file.size > maximumImageAttachmentBytes)) {
      onError(t('imageTooLarge', { size: maximumImageAttachmentBytes / 1024 / 1024 }))
      return
    }

    try {
      const attachments = await Promise.all(files.map(readImage))
      if (mountedRef.current) appendImageAttachments(attachments)
    } catch {
      if (mountedRef.current) onError(t('imageReadFailed'))
    }
  }

  async function selectImages(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    await addImageFiles(files)
  }

  async function captureScreen(hideWindow: boolean): Promise<void> {
    if (!canSend || interactionLocked) return
    try {
      const attachment = await window.codey.screenshot(hideWindow)
      if (attachment && mountedRef.current) appendImageAttachments([attachment])
    } catch {
      if (mountedRef.current) onError(t('screenshotFailed'))
    }
  }

  async function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const image = [...event.clipboardData.items]
      .find((item) => item.kind === 'file' && supportedImageMediaTypes.includes(item.type as ImageMediaType))
      ?.getAsFile()
    if (!image) return

    event.preventDefault()
    await addImageFiles([image])
  }

  function submitMessage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const content = draft.trim()
    const images = draftImages
    if ((!content && images.length === 0) || !canSend || interactionLocked) return
    if (!onSubmit(content, images)) return
    setDraft('')
    replaceDraftImages([])
    setAttachmentMenuOpen(false)
  }

  return (
    <form className="composer" onSubmit={submitMessage}>
      <input
        accept={supportedImageMediaTypes.join(',')}
        hidden
        multiple
        onChange={(event) => void selectImages(event)}
        ref={imageInputRef}
        type="file"
      />
      {draftImages.length > 0 && (
        <div className="draft-images">
          {draftImages.map((image) => (
            <div className="draft-image" key={image.id}>
              <img alt={image.name} src={image.dataUrl} />
              <Button
                aria-label={t('removeImage')}
                appearance="subtle"
                onClick={() => replaceDraftImages(draftImagesRef.current.filter((item) => item.id !== image.id))}
                shape="circular"
                size="small"
                title={t('removeImage')}
                type="button"
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-side-controls">
        <div className="attachment-menu" ref={attachmentMenuRef}>
          <Button
            appearance="secondary"
            aria-expanded={attachmentMenuOpen}
            aria-haspopup="menu"
            disabled={!canSend || interactionLocked}
            onClick={() => setAttachmentMenuOpen((open) => !open)}
            title={t('addAttachment')}
            type="button"
          >
            +
          </Button>
          {attachmentMenuOpen && (
            <div className="attachment-menu-popover" role="menu">
              <Button
                appearance="subtle"
                className="attachment-menu-item"
                onClick={() => {
                  setAttachmentMenuOpen(false)
                  void captureScreen(false)
                }}
                role="menuitem"
                type="button"
              >
                {t('captureScreenshot')}
              </Button>
              <Button
                appearance="subtle"
                className="attachment-menu-item"
                onClick={() => {
                  setAttachmentMenuOpen(false)
                  void captureScreen(true)
                }}
                role="menuitem"
                type="button"
              >
                {t('captureScreenshotHideWindow')}
              </Button>
              <Button
                appearance="subtle"
                className="attachment-menu-item"
                onClick={() => {
                  setAttachmentMenuOpen(false)
                  imageInputRef.current?.click()
                }}
                role="menuitem"
                type="button"
              >
                {t('uploadImage')}
              </Button>
            </div>
          )}
        </div>
        <Switch
          checked={networkAccessEnabled}
          className="network-access-switch"
          disabled={interactionLocked}
          label={t('networkAccess')}
          onChange={(_, data) => onNetworkAccessChange(data.checked)}
          title={t('networkAccessWarning')}
        />
      </div>
      <Textarea
        aria-label={t('developmentRequest')}
        className="message-input"
        disabled={!canSend || interactionLocked}
        size="large"
        value={draft}
        onChange={(_, data) => setDraft(data.value)}
        onPaste={(event) => void handlePaste(event)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
        placeholder={
          !configured
            ? t('configureModel')
            : !hasProjectFolders
              ? t('addFolderFirst')
              : t('describeTask')
        }
      />
      {conversationWorking ? (
        <Button
          appearance="primary"
          disabled={stopping || !hasActiveConversation}
          onClick={onStop}
          size="large"
          type="button"
        >
          {t('stop')}
        </Button>
      ) : (
        <Button
          appearance="primary"
          disabled={!canSend || (!draft.trim() && draftImages.length === 0) || interactionLocked}
          size="large"
          type="submit"
        >
          {t('send')}
        </Button>
      )}
    </form>
  )
})

export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState('')
  const [activeConversationId, setActiveConversationId] = useState('')
  const [config, setConfig] = useState(defaultAppConfig)
  const [configDraft, setConfigDraft] = useState(defaultAppConfig)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [contextDialogOpen, setContextDialogOpen] = useState(false)
  const [contextScope, setContextScope] = useState<'project' | 'conversation'>('conversation')
  const [contextProjectId, setContextProjectId] = useState('')
  const [contextOverrideEnabled, setContextOverrideEnabled] = useState(false)
  const [contextDraft, setContextDraft] = useState(defaultContextManagementConfig)
  const [bridgeDialogOpen, setBridgeDialogOpen] = useState(false)
  const [bridgeUrl, setBridgeUrl] = useState('http://127.0.0.1:8787')
  const [bridgeChannels, setBridgeChannels] = useState<BridgeChannelStatus[]>([])
  const [bridgeError, setBridgeError] = useState('')
  const [bridgeBusy, setBridgeBusy] = useState(false)
  const [agentLimitsDialogOpen, setAgentLimitsDialogOpen] = useState(false)
  const [agentLimitsProjectId, setAgentLimitsProjectId] = useState('')
  const [agentLimitsConversationId, setAgentLimitsConversationId] = useState('')
  const [agentLimitsDraft, setAgentLimitsDraft] = useState(defaultAgentLimitsConfig)
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [conversationStates, setConversationStates] = useState<Record<string, ConversationRuntimeState>>({})
  const [stoppingConversations, setStoppingConversations] = useState<Record<string, boolean>>({})
  const [conversationTurns, setConversationTurns] = useState<Record<string, ConversationTurn>>({})
  const [saving, setSaving] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [error, setError] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [performanceDialogOpen, setPerformanceDialogOpen] = useState(false)
  const [performanceStatus, setPerformanceStatus] = useState<PerformanceTraceStatus | null>(null)
  const [performanceFiles, setPerformanceFiles] = useState<PerformanceTraceFile[]>([])
  const [performanceError, setPerformanceError] = useState('')
  const [projectError, setProjectError] = useState('')
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const conversationRef = useRef<HTMLDivElement>(null)
  const conversationEndRef = useRef<HTMLDivElement>(null)
  const activeConversationKeyRef = useRef('')
  const activeTraceIdsRef = useRef<Record<string, string>>({})
  const lastProgressTraceAtRef = useRef<Record<string, number>>({})

  const activeProject = projects.find((project) => project.id === activeProjectId)
  const activeConversation = activeProject?.conversations.find(
    (conversation) => conversation.id === activeConversationId,
  )
  const projectModelConfigId = activeProject?.defaultModelConfigId ?? config.activeModelConfigId
  const effectiveModelConfigId = activeConversation?.modelConfigId ?? projectModelConfigId
  const effectiveModelConfig = config.modelConfigs.find((model) => model.id === effectiveModelConfigId)
  const effectiveContextConfig = activeConversation?.contextConfigOverride ??
    activeProject?.contextConfigOverride ?? config.contextManagement
  const outputMarginError = effectiveModelConfig &&
    effectiveContextConfig.safeOutputMargin >= effectiveModelConfig.modelMaxContext
    ? t('outputMarginContextError', {
        margin: effectiveContextConfig.safeOutputMargin.toLocaleString(),
        context: effectiveModelConfig.modelMaxContext.toLocaleString(),
        model: effectiveModelConfig.name,
      })
    : ''
  const effectiveContextStrategyLabel = effectiveContextConfig.customStrategyEnabled
    ? t('contextStrategyCustom')
    : effectiveContextConfig.layeredEnabled
      ? t('contextStrategyLayeredShort')
      : t('contextStrategyDefault')
  const configured = Boolean(effectiveModelConfig?.baseUrl && effectiveModelConfig.apiKey && effectiveModelConfig.modelName)
  const conversationRoundCount = activeConversation?.messages.filter((message) => message.role === 'user').length ?? 0
  const context = activeConversation?.context
  const contextStatus = context
    ? `${Math.round((context.compressedTokens / context.modelMaxContext) * 100)}% context / ${Math.round((context.compressedTokens / context.triggerThreshold) * 100)}% input`
    : ''
  const activeConversationKey = activeProject && activeConversation
    ? `${activeProject.id}:${activeConversation.id}`
    : ''
  const activeConversationState = activeConversationKey
    ? conversationStates[activeConversationKey] ?? 'idle'
    : 'idle'
  const interactionLocked = activeConversationState !== 'idle'
  const conversationWorking = activeConversationState === 'running'
  const stopping = activeConversationKey ? stoppingConversations[activeConversationKey] === true : false
  const conversationTurn = activeConversationKey ? conversationTurns[activeConversationKey] : undefined
  const canSend = Boolean(configured && activeProject?.folders.length && activeConversation && !interactionLocked)
  activeConversationKeyRef.current = activeConversationKey

  useEffect(() => {
    void window.codey
      .getConfig()
      .then((saved) => {
        setConfig(saved)
        setConfigDraft(saved)
        setAppLanguage(saved.language)
      })
      .catch(() => setError(t('unableLoadConfig')))

    void window.codey
      .getProjects()
      .then((savedProjects) => {
        setProjects(savedProjects)
        const firstProject = savedProjects[0]
        if (firstProject) {
          setActiveProjectId(firstProject.id)
          setActiveConversationId(firstProject.conversations[0]?.id ?? '')
        }
      })
      .catch(() => setError(t('unableLoadProjects')))
  }, [])

  useEffect(() => {
    void window.codey.getPerformanceTraceStatus().then(setPerformanceStatus).catch(() => undefined)
  }, [])

  useEffect(() => window.codey.onDevelopmentProgress((progress) => {
    const key = `${progress.projectId}:${progress.conversationId}`
    const now = performance.now()
    if (now - (lastProgressTraceAtRef.current[key] ?? 0) >= 1_000) {
      lastProgressTraceAtRef.current[key] = now
      window.codey.recordPerformanceTrace({
        traceId: activeTraceIdsRef.current[key] ?? 'renderer-session', scope: 'renderer', phase: 'progress-received',
        projectId: progress.projectId, conversationId: progress.conversationId,
      })
    }
    updateDevelopmentProgress(progress)
  }), [])

  useEffect(() => {
    let cancelled = false
    const projectId = activeProjectId || null
    const conversationId = activeConversationId || null
    const key = projectId && conversationId ? `${projectId}:${conversationId}` : ''
    void window.codey
      .subscribeDevelopmentProgress(projectId, conversationId)
      .then((state) => {
        if (!cancelled && key && activeConversationKeyRef.current === key) {
          replaceDevelopmentProgress(key, state)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeConversationId, activeProjectId])

  useEffect(() => () => {
    void window.codey.subscribeDevelopmentProgress(null, null)
  }, [])

  useEffect(() => window.codey.onConversationStateChange((change) => {
    setConversationStates((current) => ({
      ...current,
      [`${change.projectId}:${change.conversationId}`]: change.state,
    }))
  }), [])

  useEffect(() => window.codey.onProjectUpdated((project) => {
    window.codey.recordPerformanceTrace({ traceId: 'renderer-session', scope: 'renderer', phase: 'project-update-received', projectId: project.id })
    setProjects((current) => current.map((item) => item.id === project.id ? project : item))
  }), [])

  useEffect(() => {
    function openDebugger(event: KeyboardEvent): void {
      if (
        config.developerMode &&
        activeProjectId &&
        activeConversationId &&
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'd'
      ) {
        event.preventDefault()
        void window.codey.openContextDebug(activeProjectId, activeConversationId).catch((reason) => {
          setError(reason instanceof Error ? reason.message : t('unableOpenContextDebugger'))
        })
      }
    }

    window.addEventListener('keydown', openDebugger)
    return () => window.removeEventListener('keydown', openDebugger)
  }, [activeConversationId, activeProjectId, config.developerMode, t])

  function scrollToBottom(): void {
    setShowScrollToBottom(false)
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }

  useEffect(() => {
    const root = conversationRef.current
    const end = conversationEndRef.current
    if (!root || !end) {
      setShowScrollToBottom(false)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => setShowScrollToBottom(!entry.isIntersecting),
      { root, threshold: 0.9 },
    )
    observer.observe(end)
    return () => observer.disconnect()
  }, [activeConversationId, activeConversation?.messages.length])

  function replaceProject(updated: Project): void {
    setProjects((current) => current.map((project) =>
      project.id === updated.id ? updated : project,
    ))
  }

  function selectProject(project: Project): void {
    setActiveProjectId(project.id)
    setActiveConversationId(project.conversations[0]?.id ?? '')
    setOpenProjectMenuId(null)
    setError('')
  }

  function createSettingsDraft(): typeof defaultAppConfig {
    if (config.modelConfigs.length > 0) {
      return config
    }
    const model = { ...defaultModelConfig, id: crypto.randomUUID() }
    return { ...config, modelConfigs: [model], activeModelConfigId: model.id }
  }

  function openSettings(): void {
    setConfigDraft(createSettingsDraft())
    setSettingsError('')
    setSettingsOpen(true)
  }

  async function openPerformanceTracing(): Promise<void> {
    setPerformanceError('')
    setPerformanceDialogOpen(true)
    try {
      const [status, files] = await Promise.all([
        window.codey.getPerformanceTraceStatus(),
        window.codey.listPerformanceTraceFiles(),
      ])
      setPerformanceStatus(status)
      setPerformanceFiles(files)
    } catch {
      setPerformanceError(t('unableLoadPerformanceTrace'))
    }
  }

  async function togglePerformanceTracing(enabled: boolean): Promise<void> {
    setPerformanceError('')
    try {
      setPerformanceStatus(await window.codey.setPerformanceTracingEnabled(enabled))
      setPerformanceFiles(await window.codey.listPerformanceTraceFiles())
    } catch {
      setPerformanceError(t('unableUpdatePerformanceTrace'))
    }
  }

  async function openPerformanceTraceFile(fileName: string): Promise<void> {
    setPerformanceError('')
    try {
      await window.codey.openPerformanceTraceFile(fileName)
    } catch {
      setPerformanceError(t('unableOpenPerformanceTrace'))
    }
  }

  async function exportPerformanceTracing(): Promise<void> {
    setPerformanceError('')
    try {
      const path = await window.codey.exportPerformanceTraces()
      if (path) {
        setPerformanceError(t('performanceTraceExported'))
        setPerformanceStatus(await window.codey.getPerformanceTraceStatus())
      }
    } catch {
      setPerformanceError(t('unableExportPerformanceTrace'))
    }
  }

  async function revealPerformanceTracing(): Promise<void> {
    setPerformanceError('')
    try {
      await window.codey.revealPerformanceTraces()
    } catch {
      setPerformanceError(t('unableRevealPerformanceTrace'))
    }
  }

  async function openBridgeDialog(): Promise<void> {
    setBridgeDialogOpen(true)
    setBridgeError('')
    try {
      setBridgeChannels(await window.codey.getBridgeChannels())
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : '无法读取 Bridge 状态')
    }
  }

  async function createBridgeChannel(): Promise<void> {
    setBridgeBusy(true)
    setBridgeError('')
    try {
      await window.codey.createBridgeChannel(bridgeUrl)
      setBridgeChannels(await window.codey.getBridgeChannels())
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : '创建频道失败')
    } finally {
      setBridgeBusy(false)
    }
  }

  async function approveBridgeRequest(channelId: string, request: BridgeChannelStatus['pendingRequests'][number]): Promise<void> {
    setBridgeBusy(true)
    setBridgeError('')
    try {
      setBridgeChannels(await window.codey.approveBridgeRequest(channelId, request.id, request.devicePublicKey))
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : '审批失败')
    } finally {
      setBridgeBusy(false)
    }
  }

  async function rejectBridgeRequest(channelId: string, requestId: string): Promise<void> {
    setBridgeBusy(true)
    setBridgeError('')
    try {
      setBridgeChannels(await window.codey.rejectBridgeRequest(channelId, requestId))
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : '拒绝失败')
    } finally {
      setBridgeBusy(false)
    }
  }

  async function copyBridgeInvitation(channel: BridgeChannelStatus): Promise<void> {
    if (!channel.invitation) return
    try {
      await navigator.clipboard.writeText(channel.invitation)
      setBridgeError('配对内容已复制')
    } catch {
      setBridgeError('复制失败，请手动复制')
    }
  }

  async function syncBridgeNow(channelId?: string): Promise<void> {
    setBridgeBusy(true)
    setBridgeError('')
    try {
      setBridgeChannels(await window.codey.syncBridge(channelId))
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : '同步失败')
    } finally {
      setBridgeBusy(false)
    }
  }

  async function refreshBridgeEnrollment(channelId: string): Promise<void> {
    setBridgeBusy(true)
    setBridgeError('')
    try {
      const refreshed = await window.codey.refreshBridgeEnrollment(channelId)
      setBridgeChannels((channels) => channels.map((channel) => channel.channelId === refreshed.channelId ? refreshed : channel))
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : '刷新配对内容失败')
    } finally {
      setBridgeBusy(false)
    }
  }

  async function removeBridgeChannel(channel: BridgeChannelStatus): Promise<void> {
    if (!window.confirm(`确定要从 Codey 移除频道 ${channel.channelId} 吗？这只会停止本机同步；Bridge 上的频道和已批准设备不会被删除。`)) return
    setBridgeBusy(true)
    setBridgeError('')
    try {
      setBridgeChannels(await window.codey.removeBridgeChannel(channel.channelId))
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : '移除频道失败')
    } finally {
      setBridgeBusy(false)
    }
  }
  function updateAppContextConfig(patch: Partial<ContextManagementConfig>): void {
    setConfigDraft((current) => ({
      ...current,
      contextManagement: { ...current.contextManagement, ...patch },
    }))
  }

  function updateContextDraft(patch: Partial<ContextManagementConfig>): void {
    setContextDraft((current) => ({ ...current, ...patch }))
  }

  function openContextSettings(scope: 'project' | 'conversation', project = activeProject): void {
    if (!project || interactionLocked) {
      return
    }
    const override = scope === 'project'
      ? project.contextConfigOverride
      : activeConversation?.contextConfigOverride
    const inherited = scope === 'project'
      ? config.contextManagement
      : project.contextConfigOverride ?? config.contextManagement
    setContextScope(scope)
    setContextProjectId(project.id)
    setContextOverrideEnabled(Boolean(override))
    setContextDraft({ ...(override ?? inherited) })
    setSettingsError('')
    setContextDialogOpen(true)
    setOpenProjectMenuId(null)
  }

  async function saveContextSettings(): Promise<void> {
    const targetProject = projects.find((project) => project.id === contextProjectId)
    if (!targetProject || interactionLocked) {
      return
    }
    setSaving(true)
    setSettingsError('')
    try {
      const value = contextOverrideEnabled ? contextDraft : null
      const updated = contextScope === 'project'
        ? await window.codey.setProjectContextConfig(targetProject.id, value)
        : activeConversation
          ? await window.codey.setConversationContextConfig(targetProject.id, activeConversation.id, value)
          : null
      if (updated) {
        replaceProject(updated)
      }
      setContextDialogOpen(false)
    } catch {
      setSettingsError(t('unableChangeContextConfig'))
    } finally {
      setSaving(false)
    }
  }
  function openAgentLimitsSettings(): void {
    if (!activeProject || !activeConversation || interactionLocked) {
      return
    }
    setAgentLimitsProjectId(activeProject.id)
    setAgentLimitsConversationId(activeConversation.id)
    setAgentLimitsDraft({ ...activeConversation.agentLimits })
    setSettingsError('')
    setAgentLimitsDialogOpen(true)
  }

  async function saveAgentLimitsSettings(): Promise<void> {
    if (interactionLocked || !isValidAgentLimits(agentLimitsDraft)) {
      return
    }
    setSaving(true)
    setSettingsError('')
    try {
      const updated = await window.codey.setConversationAgentLimits(
        agentLimitsProjectId,
        agentLimitsConversationId,
        agentLimitsDraft,
      )
      replaceProject(updated)
      setAgentLimitsDialogOpen(false)
    } catch {
      setSettingsError(t('unableChangeAgentLimits'))
    } finally {
      setSaving(false)
    }
  }

  function updateSelectedModel(patch: Partial<ModelConfig>): void {
    const selectedId = configDraft.activeModelConfigId
    if (!selectedId) {
      return
    }
    setConfigDraft((current) => ({
      ...current,
      modelConfigs: current.modelConfigs.map((model) =>
        model.id === selectedId ? { ...model, ...patch } : model,
      ),
    }))
  }

  function addModelConfig(): void {
    const model = { ...defaultModelConfig, id: crypto.randomUUID() }
    setConfigDraft((current) => ({
      ...current,
      modelConfigs: [...current.modelConfigs, model],
      activeModelConfigId: model.id,
    }))
  }

  async function setNetworkAccess(enabled: boolean): Promise<void> {
    if (interactionLocked) return
    const next = { ...config, networkAccessEnabled: enabled }
    setConfig(next)
    setConfigDraft((current) => ({ ...current, networkAccessEnabled: enabled }))
    try {
      const saved = await window.codey.saveConfig(next)
      setConfig(saved)
      setConfigDraft(saved)
      setError('')
    } catch {
      setConfig(config)
      setConfigDraft((current) => ({ ...current, networkAccessEnabled: config.networkAccessEnabled }))
      setError(t('invalidModelConfig'))
    }
  }

  async function saveSettings(): Promise<void> {
    setSaving(true)
    setSettingsError('')

    try {
      const saved = await window.codey.saveConfig(configDraft)
      setConfig(saved)
      setConfigDraft(saved)
      setAppLanguage(saved.language)
      setError('')
      setSettingsOpen(false)
    } catch {
      setSettingsError(t('invalidModelConfig'))
    } finally {
      setSaving(false)
    }
  }

  function openProjectDialog(): void {
    setProjectName('')
    setProjectError('')
    setProjectDialogOpen(true)
  }

  async function createNewProject(): Promise<void> {
    if (!projectName.trim() || creatingProject) {
      return
    }

    setCreatingProject(true)
    setProjectError('')

    try {
      const project = await window.codey.createProject(projectName)
      setProjects((current) => [...current, project])
      setActiveProjectId(project.id)
      setActiveConversationId(project.conversations[0]?.id ?? '')
      setProjectName('')
      setProjectDialogOpen(false)
    } catch {
      setProjectError(t('projectNameRequired'))
    } finally {
      setCreatingProject(false)
    }
  }

  async function addFolder(): Promise<void> {
    if (!activeProject) {
      return
    }

    try {
      const updated = await window.codey.addProjectFolder(activeProject.id)
      if (updated) {
        replaceProject(updated)
      }
    } catch {
      setError(t('unableAddFolder'))
    }
  }

  async function changeProjectModelConfig(projectId: string, modelConfigId: string): Promise<void> {
    if (interactionLocked) {
      return
    }

    try {
      const updated = await window.codey.setProjectModelConfig(projectId, modelConfigId || null)
      replaceProject(updated)
    } catch {
      setError(t('unableChangeModelConfig'))
    }
  }

  async function changeConversationModelConfig(modelConfigId: string): Promise<void> {
    if (!activeProject || !activeConversation || interactionLocked) {
      return
    }

    try {
      const updated = await window.codey.setConversationModelConfig(
        activeProject.id,
        activeConversation.id,
        modelConfigId || null,
      )
      replaceProject(updated)
    } catch {
      setError(t('unableChangeModelConfig'))
    }
  }

  async function startNewConversation(): Promise<void> {
    if (!activeProject) {
      return
    }

    try {
      const updated = await window.codey.createConversation(activeProject.id)
      replaceProject(updated)
      setActiveConversationId(updated.conversations.at(-1)?.id ?? '')
      setError('')
    } catch {
      setError(t('unableCreateConversation'))
    }
  }

  async function sendMessage(content: string, images: ImageAttachment[]): Promise<void> {
    if ((!content && images.length === 0) || !canSend || !activeProject || !activeConversation || interactionLocked) {
      return
    }

    const projectId = activeProject.id
    const conversationId = activeConversation.id
    const conversationKey = `${projectId}:${conversationId}`
    const traceId = crypto.randomUUID()
    activeTraceIdsRef.current[conversationKey] = traceId
    const sendStartedAt = performance.now()
    setError('')
    const userMessageId = crypto.randomUUID()
    const optimisticProject: Project = {
      ...activeProject,
      conversations: activeProject.conversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              messages: [
                ...conversation.messages,
                { id: userMessageId, role: 'user', content, images, createdAt: new Date().toISOString() },
              ],
            }
          : conversation,
      ),
    }
    replaceProject(optimisticProject)
    window.codey.recordPerformanceTrace({
      traceId, scope: 'renderer', phase: 'user-message-published', projectId, conversationId,
      durationMs: performance.now() - sendStartedAt, data: { contentChars: content.length, imageCount: images.length },
    })
    resetDevelopmentProgress(conversationKey)
    setConversationStates((current) => ({ ...current, [conversationKey]: 'running' }))
    setStoppingConversations((current) => ({ ...current, [conversationKey]: false }))
    setConversationTurns((current) => ({
      ...current,
      [conversationKey]: {
        projectId,
        conversationId,
        userMessageId,
        startedAt: Date.now(),
        result: 'processing',
      },
    }))

    try {
      window.codey.recordPerformanceTrace({ traceId, scope: 'renderer', phase: 'develop-ipc', projectId, conversationId })
      const result = await window.codey.develop(projectId, conversationId, content, images, traceId)
      if (result.project) {
        const updatedConversation = result.project.conversations.find(
          (conversation) => conversation.id === conversationId,
        )
        const updatedUserMessage = [...(updatedConversation?.messages ?? [])]
          .reverse()
          .find((message) => message.role === 'user' && message.content === content &&
            (images.length === 0 || message.images?.[0]?.id === images[0].id))
        setConversationTurns((current) => ({
          ...current,
          [conversationKey]: {
            ...current[conversationKey],
            userMessageId: updatedUserMessage?.id ?? current[conversationKey]?.userMessageId ?? userMessageId,
          },
        }))
        replaceProject(result.project)
      }
      setConversationTurns((current) => ({
        ...current,
        [conversationKey]: {
          ...current[conversationKey],
          endedAt: Date.now(),
          result: result.stopped
            ? 'stopped'
            : result.error
              ? /timed out/i.test(result.error) ? 'timeout' : 'other'
              : 'normal',
          error: result.stopped ? undefined : result.error,
        },
      }))
      setConversationStates((current) => ({ ...current, [conversationKey]: 'idle' }))
      if (result.error && conversationKey === activeConversationKeyRef.current) {
        const files = result.writtenFiles.length
          ? t('filesWritten', { count: result.writtenFiles.length })
          : ''
        setError(`${result.error}${files}`)
      }
    } catch {
      setConversationTurns((current) => ({
        ...current,
        [conversationKey]: {
          ...current[conversationKey],
          endedAt: Date.now(),
          result: 'other',
          error: t('requestFailed'),
        },
      }))
      setConversationStates((current) => ({ ...current, [conversationKey]: 'idle' }))
      if (conversationKey === activeConversationKeyRef.current) setError(t('unableProcessRequest'))
    } finally {
      delete activeTraceIdsRef.current[conversationKey]
      clearDevelopmentProgress(conversationKey)
      setStoppingConversations((current) => {
        if (!current[conversationKey]) return current
        const next = { ...current }
        delete next[conversationKey]
        return next
      })
    }
  }
  async function stopMessage(): Promise<void> {
    if (!activeProject || !activeConversation || !conversationWorking || stopping) {
      return
    }

    const conversationKey = `${activeProject.id}:${activeConversation.id}`
    setStoppingConversations((current) => ({ ...current, [conversationKey]: true }))
    try {
      const accepted = await window.codey.stopDevelopment(activeProject.id, activeConversation.id)
      if (!accepted) {
        setStoppingConversations((current) => ({ ...current, [conversationKey]: false }))
      }
    } catch {
      setStoppingConversations((current) => ({ ...current, [conversationKey]: false }))
      if (conversationKey === activeConversationKeyRef.current) setError(t('unableStopRequest'))
    }
  }

  const emptyTitle = !activeProject
    ? t('createProject')
    : activeProject.folders.length === 0
      ? t('addProjectFolder')
      : t('whatBuild')
  const emptyDescription = !activeProject
    ? t('projectDescription')
    : activeProject.folders.length === 0
      ? t('folderDescription')
      : t('conversationDescription')
  const selectedModel = configDraft.modelConfigs.find(
    (model) => model.id === configDraft.activeModelConfigId,
  ) ?? configDraft.modelConfigs[0]
  const invalidModelConfig = configDraft.modelConfigs.length === 0 || configDraft.modelConfigs.some((model) =>
    !model.name.trim() ||
    !model.baseUrl.trim() ||
    !model.apiKey.trim() ||
    !model.modelName.trim() ||
    model.modelMaxContext < 1_000,
  )
  const minimumModelContext = Math.min(...configDraft.modelConfigs.map((model) => model.modelMaxContext))
  const invalidAppContextConfig = !isValidContextConfig(configDraft.contextManagement) ||
    configDraft.contextManagement.safeOutputMargin >= minimumModelContext
  const invalidContextOverride = contextOverrideEnabled && !isValidContextConfig(contextDraft)

  return (
    <FluentProvider className="app" theme={webLightTheme}>
      <main className="shell">
        <aside className="sidebar">

          <Button appearance="primary" onClick={openProjectDialog}>
            {t('newProject')}
          </Button>

          <section className="sidebar-section">
            <p className="section-label">{t('projects')}</p>
            <nav className="nav-list" aria-label={t('projects')}>
              {projects.map((project) => (
                <div className="project-nav-item" key={project.id}>
                  <div className="project-nav-row">
                    <Button
                      appearance={project.id === activeProjectId ? 'secondary' : 'subtle'}
                      onClick={() => selectProject(project)}
                    >
                      {project.name}
                    </Button>
                    <Button
                      appearance="subtle"
                      size="small"
                      aria-expanded={openProjectMenuId === project.id}
                      aria-label={t('projectOptions')}
                      onClick={() => setOpenProjectMenuId((current) =>
                        current === project.id ? null : project.id
                      )}
                    >
                      …
                    </Button>
                  </div>
                  {openProjectMenuId === project.id && (
                    <div className="project-menu-panel">
                      <label>
                        <span>{t('projectDefaultModel')}</span>
                        <Select
                          aria-label={t('projectDefaultModel')}
                          disabled={interactionLocked || config.modelConfigs.length === 0}
                          value={project.defaultModelConfigId ?? ''}
                          onChange={(_, data) => {
                            setOpenProjectMenuId(null)
                            void changeProjectModelConfig(project.id, data.value)
                          }}
                        >
                          <option value="">{t('applicationDefault')}</option>
                          {config.modelConfigs.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.name || model.modelName || t('unnamedModel')}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => openContextSettings('project', project)}>
                        {t('contextSettings')}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </nav>
          </section>

          {activeProject && (
            <section className="sidebar-section conversations-section">
              <div className="section-heading">
                <p className="section-label">{t('conversations')}</p>
                <Button
                  appearance="subtle"
                  size="small"
                  onClick={() => void startNewConversation()}
                >
                  {t('new')}
                </Button>
              </div>
              <nav className="nav-list" aria-label={t('conversations')}>
                {activeProject.conversations.map((conversation) => (
                  <Button
                    appearance={
                      conversation.id === activeConversationId ? 'secondary' : 'subtle'
                    }
                    key={conversation.id}
                    onClick={() => {
                      setActiveConversationId(conversation.id)
                      setError('')
                    }}
                  >
                    {conversation.title}
                  </Button>
                ))}
              </nav>
            </section>
          )}

          <Button className="settings-button" appearance="subtle" onClick={openSettings}>
            {t('settings')}
          </Button>
          <div className="performance-nav-row">
            <Button appearance="subtle" disabled={!config.developerMode} onClick={() => void openPerformanceTracing()}>
              {t('performanceTracing')}
            </Button>
            <Button
              appearance="subtle"
              className="performance-toggle-button"
              aria-label={performanceStatus?.enabled ? t('stopPerformanceTracing') : t('startPerformanceTracing')}
              title={performanceStatus?.enabled ? t('stopPerformanceTracing') : t('startPerformanceTracing')}
              disabled={!config.developerMode || !performanceStatus}
              onClick={() => void togglePerformanceTracing(!performanceStatus?.enabled)}
            >
              <span aria-hidden="true" className={performanceStatus?.enabled ? 'performance-toggle-icon stop' : 'performance-toggle-icon play'} />
            </Button>
          </div>
          <Button appearance="subtle" onClick={() => void openBridgeDialog()}>
            Handover
          </Button>
        </aside>

        <section className="workspace">
          <header className="topbar">
            <div>
              <strong>{activeProject?.name ?? 'Codey'}</strong>
              {activeConversation && <span>{activeConversation.title}</span>}
            </div>
            <div className="topbar-controls">
              {activeConversation && config.modelConfigs.length > 0 ? (
                <div className="topbar-row topbar-model-row">
                  <label className="topbar-field-label">
                    <span>{t('configuration')}:</span>
                    <span className="conversation-model-picker">
                      <span>
                        {effectiveModelConfig?.name || effectiveModelConfig?.modelName || t('notConfigured')}
                      </span>
                      <select
                        aria-label={t('conversationModel')}
                        disabled={interactionLocked}
                        value={activeConversation.modelConfigId ?? ''}
                        onChange={(event) => void changeConversationModelConfig(event.target.value)}
                      >
                        <option value="">{t('followProjectDefault')}</option>
                        {config.modelConfigs.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name || model.modelName || t('unnamedModel')}
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                  <span className="topbar-model-name">
                    <span>{t('modelLabel')}:</span>
                    <strong>{configured ? effectiveModelConfig?.modelName : t('notConfigured')}</strong>
                  </span>
                </div>
              ) : (
                <div className="topbar-row topbar-model-row">
                  <span className="status">{t('notConfigured')}</span>
                </div>
              )}
              {activeConversation && (
                <div className="topbar-row">
                  <span className="conversation-round-count">{t('conversationRoundCount', { count: conversationRoundCount })}</span>
                  <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={openAgentLimitsSettings}>
                    {t('agentLimits')}
                  </Button>
                </div>
              )}
              {activeConversation && (
                <div className="topbar-row">
                  <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => openContextSettings('conversation')}>
                    {t('contextSettings')} · {effectiveContextStrategyLabel}
                  </Button>
                  {config.developerMode && activeProject && (
                    <Button
                      appearance="subtle"
                      size="small"
                      title={t('contextDebuggerShortcut')}
                      onClick={() => void window.codey
                        .openContextDebug(activeProject.id, activeConversation.id)
                        .catch((reason) => setError(
                          reason instanceof Error ? reason.message : t('unableOpenContextDebugger'),
                        ))}
                    >
                      {t('openContextDebugger')}
                    </Button>
                  )}
                </div>
              )}
              {context && contextStatus && (
                <div className="topbar-row">
                  <span
                    className="context-status"
                    title={t('peakInputTitle', { original: context.originalTokens, compressed: context.compressedTokens })}
                  >
                    {contextStatus}
                  </span>
                </div>
              )}
            </div>
          </header>

          {activeProject && (
            <div className="folderbar">
              <div className="folder-list">
                {activeProject.folders.length === 0 ? (
                  <span>{t('noFolders')}</span>
                ) : (
                  activeProject.folders.map((folder) => (
                    <span className="folder" key={folder.id} title={folder.path}>
                      {folder.path}
                    </span>
                  ))
                )}
              </div>
              <Button disabled={interactionLocked} size="small" onClick={() => void addFolder()}>
                {t('addFolder')}
              </Button>
            </div>
          )}

          <div className="conversation-container">
            <div
              ref={conversationRef}
              className="conversation"
              aria-label={t('conversation')}
            >
            {!activeConversation || (activeConversation.messages.length === 0 && !interactionLocked) ? (
              <div className="empty-state">
                <h1>{emptyTitle}</h1>
                <p>{emptyDescription}</p>
                {!activeProject && (
                  <Button appearance="primary" onClick={openProjectDialog}>
                    {t('newProject')}
                  </Button>
                )}
                {activeProject && activeProject.folders.length === 0 && (
                  <Button appearance="primary" onClick={() => void addFolder()}>
                    {t('addFolder')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="messages" aria-live="polite">
                <VirtualizedConversationHistory
                  key={activeConversationKey}
                  messages={activeConversation.messages}
                  projectId={activeProjectId}
                  conversationId={activeConversation.id}
                  conversationTurn={conversationTurn}
                  scrollContainerRef={conversationRef}
                  shouldStickToBottom={!showScrollToBottom}
                />
                <LiveDevelopmentResponse
                  conversationKey={activeConversationKey}
                  projectId={activeProjectId}
                  conversationId={activeConversation.id}
                  createdAt={conversationTurn ? new Date(conversationTurn.startedAt).toISOString() : undefined}
                />
                <div aria-hidden="true" className="conversation-end" ref={conversationEndRef} />
              </div>
            )}
            </div>
            {showScrollToBottom && (
              <Button
                aria-label={t('scrollToBottom')}
                className="scroll-to-bottom"
                appearance="secondary"
                shape="circular"
                onClick={scrollToBottom}
                title={t('scrollToBottom')}
              >
                ↓
              </Button>
            )}
          </div>

          {error && <p className="composer-error" role="alert">{error}</p>}
          <Composer
            key={activeConversationKey || 'no-conversation'}
            canSend={canSend}
            configured={configured}
            conversationWorking={conversationWorking}
            hasActiveConversation={Boolean(activeConversation)}
            hasProjectFolders={Boolean(activeProject?.folders.length)}
            interactionLocked={interactionLocked}
            networkAccessEnabled={config.networkAccessEnabled}
            stopping={stopping}
            onError={setError}
            onNetworkAccessChange={(enabled) => void setNetworkAccess(enabled)}
            onStop={() => void stopMessage()}
            onSubmit={(content, images) => {
              if (outputMarginError) {
                setError(outputMarginError)
                return false
              }
              if (!canSend || !activeProject || !activeConversation || interactionLocked) return false
              void sendMessage(content, images)
              return true
            }}
          />
        </section>
      </main>

      <Dialog
        open={projectDialogOpen}
        onOpenChange={(_, data) => setProjectDialogOpen(data.open)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('newProject')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <Field label={t('projectName')} required>
                <Input
                  autoFocus
                  value={projectName}
                  onChange={(_, data) => setProjectName(data.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void createNewProject()
                    }
                  }}
                />
              </Field>
              {projectError && <p className="dialog-error">{projectError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setProjectDialogOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={!projectName.trim() || creatingProject}
                onClick={() => void createNewProject()}
              >
                {creatingProject ? t('creating') : t('create')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={performanceDialogOpen} onOpenChange={(_, data) => setPerformanceDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('performanceTracing')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <p className="settings-description">{t('performanceTracingDescription')}</p>
              {!config.developerMode && <p className="settings-warning">{t('performanceTracingRequiresDeveloperMode')}</p>}
              {performanceStatus && (
                <>
                  <p className="status">{performanceStatus.enabled ? t('performanceTracingEnabled') : t('performanceTracingDisabled')}</p>
                  <p className="status">{t('performanceTracePath')}: {performanceStatus.path}</p>
                  <p className="status">{t('performanceTraceSize')}: {performanceStatus.sizeBytes.toLocaleString()} B</p>
                </>
              )}
              <div className="performance-trace-files">
                <strong>{t('performanceTraceFiles')}</strong>
                {performanceFiles.length === 0 ? <p className="trace-empty">{t('noPerformanceTraceFiles')}</p> : performanceFiles.map((file) => (
                  <Button key={file.name} appearance="subtle" className="performance-trace-file" onClick={() => void openPerformanceTraceFile(file.name)}>
                    <span>{file.name}</span>
                    <small>{file.sizeBytes.toLocaleString()} B · {new Date(file.modifiedAt).toLocaleString()}</small>
                  </Button>
                ))}
              </div>
              {performanceError && <p className="dialog-error">{performanceError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => void revealPerformanceTracing()} disabled={!performanceStatus}>{t('revealPerformanceTraces')}</Button>
              <Button appearance="secondary" onClick={() => void exportPerformanceTracing()} disabled={!performanceStatus || performanceStatus.sizeBytes === 0}>{t('exportPerformanceTraces')}</Button>
              <Button appearance="secondary" onClick={() => setPerformanceDialogOpen(false)}>{t('close')}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={(_, data) => setSettingsOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('settings')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <section className="settings-group">
                <h2>{t('modelSettings')}</h2>
                <div className="model-config-toolbar">
                  <Select
                    aria-label={t('modelSettings')}
                    value={configDraft.activeModelConfigId ?? ''}
                    onChange={(_, data) => setConfigDraft((current) => ({
                      ...current,
                      activeModelConfigId: data.value || null,
                    }))}
                  >
                    {configDraft.modelConfigs.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name || model.modelName || t('unnamedModel')}
                      </option>
                    ))}
                  </Select>
                  <Button appearance="secondary" onClick={addModelConfig}>
                    {t('addModelConfig')}
                  </Button>
                </div>
                <Field label={t('modelConfigName')} required>
                  <Input
                    value={selectedModel?.name ?? ''}
                    onChange={(_, data) => updateSelectedModel({ name: data.value })}
                  />
                </Field>
                <Field label={t('baseUrl')} required>
                  <Input
                    value={selectedModel?.baseUrl ?? ''}
                    onChange={(_, data) => updateSelectedModel({ baseUrl: data.value })}
                    placeholder="https://api.example.com/v1"
                  />
                </Field>
                <Field label={t('apiKey')} required>
                  <Input
                    type="password"
                    value={selectedModel?.apiKey ?? ''}
                    onChange={(_, data) => updateSelectedModel({ apiKey: data.value })}
                  />
                </Field>
                <Field label={t('modelName')} required>
                  <Input
                    value={selectedModel?.modelName ?? ''}
                    onChange={(_, data) => updateSelectedModel({ modelName: data.value })}
                    placeholder="model-name"
                  />
                </Field>
                <Field label={t('maximumContextTokens')} required>
                  <Input
                    min={1000}
                    step={1000}
                    type="number"
                    value={String(selectedModel?.modelMaxContext ?? '')}
                    onChange={(_, data) => updateSelectedModel({ modelMaxContext: Number(data.value) })}
                  />
                </Field>
              </section>
              <section className="settings-group">
                <h2>{t('contextSettings')}</h2>
                <ContextSettingsFields
                  disabled={interactionLocked}
                  value={configDraft.contextManagement}
                  onChange={updateAppContextConfig}
                />
              </section>
              <section className="settings-group">
                <h2>{t('languageSettings')}</h2>
                <Field label={t('language')}>
                  <Select
                    value={configDraft.language}
                    onChange={(_, data) => setConfigDraft((current) => ({
                      ...current,
                      language: data.value as AppLanguage,
                    }))}
                  >
                    <option value="system">{t('followSystem')}</option>
                    <option value="en">{t('english')}</option>
                    <option value="zh-CN">{t('simplifiedChinese')}</option>
                  </Select>
                </Field>
              </section>
              <section className="settings-group">
                <h2>{t('powerSettings')}</h2>
                <Switch
                  checked={configDraft.keepAwakeEnabled}
                  label={t('keepAwakeComputer')}
                  onChange={(_, data) => setConfigDraft((current) => ({
                    ...current,
                    keepAwakeEnabled: data.checked,
                  }))}
                />
                {configDraft.keepAwakeEnabled && (
                  <p className="settings-warning" role="alert">{t('keepAwakeWarning')}</p>
                )}
                <Switch
                  checked={configDraft.keepAwakeOnlyWhileWorking}
                  className="nested-setting"
                  disabled={!configDraft.keepAwakeEnabled}
                  label={t('keepAwakeOnlyWhileWorking')}
                  onChange={(_, data) => setConfigDraft((current) => ({
                    ...current,
                    keepAwakeOnlyWhileWorking: data.checked,
                  }))}
                />
              </section>
              <section className="settings-group">
                <h2>{t('developerSettings')}</h2>
                <Switch
                  checked={configDraft.developerMode}
                  label={t('developerMode')}
                  onChange={(_, data) => setConfigDraft((current) => ({
                    ...current,
                    developerMode: data.checked,
                  }))}
                />
                <p className="settings-description">{t('developerModeDescription')}</p>
              </section>
              {settingsError && <p className="dialog-error">{settingsError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setSettingsOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={invalidModelConfig || invalidAppContextConfig || interactionLocked || saving}
                onClick={() => void saveSettings()}
              >
                {saving ? t('saving') : t('save')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={bridgeDialogOpen} onOpenChange={(_, data) => setBridgeDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Handover 频道</DialogTitle>
            <DialogContent className="dialog-fields">
              <Field label="Bridge 地址" hint="本机可用 HTTP；远程 Bridge 必须使用 HTTPS。">
                <Input value={bridgeUrl} onChange={(_, data) => setBridgeUrl(data.value)} disabled={bridgeBusy} placeholder="http://127.0.0.1:8787" />
              </Field>
              <div className="bridge-actions">
                <Button appearance="primary" disabled={bridgeBusy || !bridgeUrl.trim()} onClick={() => void createBridgeChannel()}>
                  {bridgeBusy ? '创建中…' : '创建配对频道'}
                </Button>
                {bridgeChannels.length > 0 && <Button appearance="secondary" disabled={bridgeBusy} onClick={() => void syncBridgeNow()}>同步全部频道</Button>}
              </div>
              <p className="status">每个频道有独立的配对密钥、已批准设备和同步数据。</p>
              {bridgeChannels.length === 0 ? <p className="status">尚未创建频道</p> : bridgeChannels.map((channel) => (
                <section className="bridge-channel" key={channel.channelId}>
                  <div className="bridge-channel-heading">
                    <div>
                      <strong>频道：<code>{channel.channelId}</code></strong>
                      <small>{channel.bridgeUrl} · 配对有效期：{new Date(channel.enrollmentExpiresAt).toLocaleString()}</small>
                    </div>
                    <Button size="small" appearance="secondary" disabled={bridgeBusy} onClick={() => void removeBridgeChannel(channel)}>从 Codey 移除</Button>
                  </div>
                  <Field label="配对内容" hint="仅交给要配对的 Handover 设备；过期后可刷新配对内容，无需创建新频道。">
                    <Textarea className="bridge-invitation" readOnly value={channel.invitation} rows={4} />
                  </Field>
                  <div className="bridge-actions">
                    <Button appearance="secondary" disabled={bridgeBusy} onClick={() => void copyBridgeInvitation(channel)}>复制配对内容</Button>
                    <Button appearance="secondary" disabled={bridgeBusy} onClick={() => void syncBridgeNow(channel.channelId)}>立即同步</Button>
                    <Button appearance="secondary" disabled={bridgeBusy} onClick={() => void refreshBridgeEnrollment(channel.channelId)}>刷新配对内容</Button>
                  </div>
                  <h3>待审批设备</h3>
                  <p className="status">请与 Handover 上显示的设备指纹核对后再允许。</p>
                  {channel.pendingRequests.length === 0 ? <p className="status">暂无请求</p> : channel.pendingRequests.map((request) => (
                    <div className="bridge-request" key={request.id}>
                      <span>{request.deviceName}<small>设备指纹：<code>{request.fingerprint}</code></small></span>
                      <Button size="small" appearance="primary" disabled={bridgeBusy} onClick={() => void approveBridgeRequest(channel.channelId, request)}>允许</Button>
                      <Button size="small" appearance="secondary" disabled={bridgeBusy} onClick={() => void rejectBridgeRequest(channel.channelId, request.id)}>拒绝</Button>
                    </div>
                  ))}
                  <p className="status">已批准设备：{channel.approvedDevices.length}</p>
                </section>
              ))}
              {bridgeError && <p className="dialog-error">{bridgeError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setBridgeDialogOpen(false)}>关闭</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={agentLimitsDialogOpen} onOpenChange={(_, data) => setAgentLimitsDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('conversationAgentLimits')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <Field label={t('modelRequestsPerRound')} hint={t('modelRequestsPerRoundHint')} required>
                <Input
                  disabled={interactionLocked}
                  min={1}
                  max={maximumAgentLimit}
                  type="number"
                  value={String(agentLimitsDraft.modelRequestsPerRound)}
                  onChange={(_, data) => setAgentLimitsDraft((current) => ({
                    ...current,
                    modelRequestsPerRound: Number(data.value),
                  }))}
                />
              </Field>
              <Field label={t('toolCallsPerRequest')} hint={t('toolCallsPerRequestHint')} required>
                <Input
                  disabled={interactionLocked}
                  min={1}
                  max={maximumAgentLimit}
                  type="number"
                  value={String(agentLimitsDraft.toolCallsPerRequest)}
                  onChange={(_, data) => setAgentLimitsDraft((current) => ({
                    ...current,
                    toolCallsPerRequest: Number(data.value),
                  }))}
                />
              </Field>
              {settingsError && <p className="dialog-error">{settingsError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAgentLimitsDialogOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={interactionLocked || saving || !isValidAgentLimits(agentLimitsDraft)}
                onClick={() => void saveAgentLimitsSettings()}
              >
                {saving ? t('saving') : t('save')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={contextDialogOpen} onOpenChange={(_, data) => setContextDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              {contextScope === 'project' ? t('projectContextSettings') : t('conversationContextSettings')}
            </DialogTitle>
            <DialogContent className="dialog-fields">
              <Switch
                checked={contextOverrideEnabled}
                disabled={interactionLocked}
                label={contextScope === 'project' ? t('overrideApplicationContext') : t('overrideProjectContext')}
                onChange={(_, data) => setContextOverrideEnabled(data.checked)}
              />
              <ContextSettingsFields
                disabled={interactionLocked || !contextOverrideEnabled}
                showCustomStrategy={config.developerMode && contextScope === 'conversation' && contextOverrideEnabled}
                value={contextDraft}
                onChange={updateContextDraft}
              />
              {settingsError && <p className="dialog-error">{settingsError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setContextDialogOpen(false)}>
                {t('cancel')}
              </Button>
              <Button appearance="primary" disabled={interactionLocked || saving || invalidContextOverride} onClick={() => void saveContextSettings()}>
                {saving ? t('saving') : t('save')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </FluentProvider>
  )
}
