import { Button } from '@fluentui/react-components'
import { Component, memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ErrorInfo, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantMessageBlock,
  ChatMessage,
  ContextCompressionNotice,
  ConversationTurnRecord,
  ModelRequestEvent,
} from '../../../shared/types'
import { getDevelopmentProgress, subscribeDevelopmentProgress } from '../development-progress-store'
import { ConversationHistory } from '../ConversationHistory'
import { conversationHistoryRows, conversationLiveRows, mergeConversationRows, type ConversationRenderRow } from '../conversation-render-rows'
import type { ConversationTurn } from '../hooks/useConversationRuntime'
import { CodeReadMarkdown } from './CodeReadMarkdown'
import { LazyDetails } from './LazyDetails'
import { PlanCardsProvider } from './PlanCardsProvider'
import { renderSpecializedToolCard } from './ToolCards'
import { latestPlanCardId } from './todo-card-state'

function formatToolOutput(parameters: string): string {
  try {
    return JSON.stringify(JSON.parse(parameters), null, 2)
  } catch {
    return parameters
  }
}

function looksLikeMarkdown(content: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```|~~~|>\s)|\*\*[^*]+\*\*|`[^`]+`|\[[^]]+\]\([^)]+\)|(^|\n)\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?/.test(content)
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

/** Formats one completed conversation turn as a log-style event stream for
 *  sharing with another model for evaluation. One event per line header
 *  (timestamp + role), payload verbatim — no markdown nesting conflicts. */
function formatTurnForCopy(
  userMessage: ChatMessage,
  turn: ConversationTurn,
  messages: ChatMessage[],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const startedIndex = messages.findIndex((message) => message.id === userMessage.id)
  const turnMessages: ChatMessage[] = []
  if (startedIndex >= 0) {
    for (let index = startedIndex + 1; index < messages.length; index += 1) {
      const message = messages[index]
      if (message.role !== 'assistant' && !message.compression) break
      turnMessages.push(message)
    }
  }
  const durationLabel = t('duration', {
    hours: Math.floor(Math.max(0, (turn.endedAt ?? turn.startedAt) - turn.startedAt) / 3_600_000),
    minutes: Math.floor(Math.max(0, (turn.endedAt ?? turn.startedAt) - turn.startedAt) / 60_000) % 60,
  })
  const resultLabel = turn.result === 'stopped'
    ? t('stopped')
    : turn.result === 'normal'
      ? t('normal')
      : turn.result === 'timeout'
        ? t('timeout')
        : t('otherError', { error: turn.error ?? 'Unknown' })
  const lines: string[] = [
    `# turn.duration: ${durationLabel}`,
    `# turn.result: ${resultLabel}`,
    '',
    `# ${formatMessageTime(userMessage.createdAt)} [user]`,
    userMessage.content || '',
  ]
  if (userMessage.images?.length) {
    lines.push(t('copyTurnImages'))
    for (const image of userMessage.images) {
      lines.push(`[${image.name} (${image.mediaType})]`)
    }
  }
  if (userMessage.attachments?.length) {
    lines.push(t('copyTurnAttachments'))
    for (const attachment of userMessage.attachments) {
      lines.push(`[${attachment.name} (${attachment.mediaType})]`)
    }
  }
  for (const message of turnMessages) {
    if (message.compression) continue
    if (message.modelRequest) {
      lines.push('', `# ${formatMessageTime(message.createdAt)} [model] ${message.modelRequest.kind}: ${message.modelRequest.model} ${message.modelRequest.reason ?? message.modelRequest.nextModel ?? ''}`)
      continue
    }
    const toolCalls = (message.blocks ?? []).filter((block): block is Extract<AssistantMessageBlock, { type: 'function_call' }> => block.type === 'function_call')
    // Text first regardless of raw block order: content is finalized output
    // for the reader, while tool calls are pending requests awaiting results.
    if (blockHasContent(message)) {
      lines.push('', `# ${formatMessageTime(message.createdAt)} [assistant]`, message.content || '')
    }
    let toolIndex = 0
    for (const block of message.blocks ?? []) {
      if (block.type === 'function_call') {
        toolIndex += 1
        const toolLabel = toolCalls.length > 1 ? ` #${toolIndex}` : ''
        lines.push('', `# ${formatMessageTime(message.createdAt)} [tool] ${block.name}${toolLabel}`, t('copyTurnToolParameters'), block.parameters)
        if (block.result !== undefined) {
          lines.push(block.resultError ? t('copyTurnToolError') : t('copyTurnToolResultLabel'), block.result)
        }
      }
    }
  }
  return lines.join('\n')
}

function blockHasContent(message: ChatMessage): boolean {
  return Boolean(message.content && message.content.trim())
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

function AssistantContent({ content, createdAt, projectId, conversationId, messageId }: { content: string; createdAt?: string; projectId?: string; conversationId?: string; messageId?: string }): React.JSX.Element {
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
          <CodeReadMarkdown content={content} projectId={projectId} conversationId={conversationId} messageId={messageId} />
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
            <LazyDetails stateKey={`validation-${index}`} className="validation-logs" summary={t('validationLogs')}>
              {() => <>
                {check.stdout && <pre><strong>{t('standardOutput')}</strong>{'\n'}{check.stdout}</pre>}
                {check.stderr && <pre><strong>{t('standardError')}</strong>{'\n'}{check.stderr}</pre>}
              </>}
            </LazyDetails>
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
  const server = useMemo(() => parseFrontendServerResult(block), [block.name, block.result, block.resultError])
  const validation = useMemo(() => parseNodeValidationResult(block), [block.name, block.result, block.resultError])
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

  const specialized = renderSpecializedToolCard(block)
  if (specialized) return specialized

  return (
    <LazyDetails className={`function-call${block.resultError ? ' tool-error' : ''}`} summary={<>{block.name}{validation ? ` · ${t(`validationStatus_${validation.status}`)}` : ''}</>}>
      {() => <>
        <div className="tool-output-section">
          <span>{t('toolParameters')}</span>
          <pre>{formatToolOutput(block.parameters)}</pre>
        </div>
        {block.review && block.review.length > 0 && (
          <div className="tool-output-section tool-review-section">
            <span>{t('toolReviewChain')}</span>
            <ul className="tool-review-steps">
              {block.review.map((step, index) => (
                <li key={index} className={`review-step review-${step.outcome}`}>
                  <span className="review-stage">{t(`reviewStage_${step.stage.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}`)}</span>
                  <span className={`review-outcome outcome-${step.outcome}`}>{t(`reviewOutcome_${step.outcome}`)}</span>
                  {step.detail && <span className="review-detail">{step.detail}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
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
      </>}
    </LazyDetails>
  )
}

const MemoCompressionMessage = memo(CompressionMessage)
const MemoAssistantContent = memo(AssistantContent)
const MemoFunctionCallMessage = memo(FunctionCallMessage)

function ModelRequestNotice({ event }: { event: ModelRequestEvent }): React.JSX.Element {
  const { t } = useTranslation()
  const label = event.kind === 'failure'
    ? t('modelRequestFailure', { model: event.model, reason: event.reason ?? '' })
    : event.kind === 'retry'
      ? t('modelRequestRetry', { model: event.model, attempt: event.attempt ?? 2 })
      : t('modelRequestFailover', { model: event.model, nextModel: event.nextModel ?? '' })
  return <div className="model-request-notice" role="status">{label}</div>
}

const ConversationMessage = memo(function ConversationMessage({
  message,
  block,
  messages,
  projectId,
  conversationId,
  conversationTurn,
  showContinue,
  onContinue,
}: {
  message: ChatMessage
  block?: AssistantMessageBlock
  messages: ChatMessage[]
  projectId: string
  conversationId: string
  conversationTurn?: ConversationTurn
  showContinue?: boolean
  onContinue?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const messageTurn = message.turn ?? (
    conversationTurn && conversationTurn.userMessageId === message.id
      ? conversationTurn
      : undefined
  )
  const turnCompleted = messageTurn !== undefined && messageTurn.endedAt !== undefined

  return (
    <>
      <div className={`message ${message.role}`}>
        {message.compression ? (
          <MemoCompressionMessage compression={message.compression} />
        ) : message.modelRequest ? (
          <ModelRequestNotice event={message.modelRequest} />
        ) : block ? (
          block.type === 'content' ? (
            <MemoAssistantContent content={block.content} createdAt={message.createdAt} projectId={projectId} conversationId={conversationId} messageId={message.id} />
          ) : (
            <MemoFunctionCallMessage block={block} projectId={projectId} conversationId={conversationId} />
          )
        ) : message.role === 'assistant' ? (
          <MemoAssistantContent content={message.content} createdAt={message.createdAt} projectId={projectId} conversationId={conversationId} messageId={message.id} />
        ) : (
          <div className="user-message-content">
            <div className="message-card-header">
              {formatMessageTime(message.createdAt) && <time>{formatMessageTime(message.createdAt)}</time>}
              {showContinue && onContinue && (
                <Button
                  aria-label={t('continue')}
                  appearance="subtle"
                  size="small"
                  title={t('continue')}
                  onClick={onContinue}
                >
                  {t('continue')}
                </Button>
              )}
              {turnCompleted && messageTurn && (
                <Button
                  aria-label={t('copyTurn')}
                  appearance="subtle"
                  size="small"
                  title={t('copyTurn')}
                  onClick={() => copyText(formatTurnForCopy(message, messageTurn as ConversationTurn, messages, t))}
                >
                  {t('copyTurn')}
                </Button>
              )}
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
            {message.attachments?.length ? (
              <div className="message-attachments">
                {message.attachments.map((attachment) => (
                  <span className={`message-attachment message-attachment-${attachment.kind}`} key={attachment.id}>
                    {attachment.name}
                  </span>
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

export const ConversationMessages = memo(function ConversationMessages({
  messages,
  pagination,
  onRead,
  projectId,
  conversationId,
  conversationTurn,
  scrollContainerRef,
  shouldStickToBottom,
  scrollRequest,
  lastUserMessageId,
  onContinue,
}: {
  messages: ChatMessage[]
  onRead?: (messageId: string) => Promise<void>
  pagination: { hasOlder: boolean; loading: boolean; loadOlder: () => Promise<void> }
  projectId: string
  conversationId: string
  conversationTurn?: ConversationTurn
  scrollContainerRef: RefObject<HTMLDivElement | null>
  shouldStickToBottom: boolean
  scrollRequest?: { messageId: string; requestId: number }
  lastUserMessageId?: string
  onContinue?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const conversationKey = `${projectId}:${conversationId}`
  const subscribe = useCallback(
    (listener: () => void) => subscribeDevelopmentProgress(conversationKey, listener),
    [conversationKey],
  )
  const getSnapshot = useCallback(() => getDevelopmentProgress(conversationKey), [conversationKey])
  const progress = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const historyRows = useMemo(() => conversationHistoryRows(messages), [messages])
  const rows = useMemo(() => mergeConversationRows(historyRows, conversationLiveRows(progress, messages)), [historyRows, progress, messages])
  const latestPlanId = useMemo(() => latestPlanCardId(rows), [rows])
  const createdAt = conversationTurn ? new Date(conversationTurn.startedAt).toISOString() : undefined
  return (
    <PlanCardsProvider latestId={latestPlanId}>
      <ConversationHistory
        messages={messages}
        pagination={pagination}
        onRead={onRead}
        rows={rows}
        scrollContainerRef={scrollContainerRef}
        shouldStickToBottom={shouldStickToBottom}
        scrollRequest={scrollRequest}
        renderLoadOlder={(loadOlder, count) => (
          <Button appearance="subtle" size="small" onClick={loadOlder} disabled={pagination.loading}>
            {pagination.loading ? t('loadingConversationMessages') : t('loadOlderConversationRounds', { count })}
          </Button>
        )}
        renderRow={(row) => row.kind === 'message' ? (
          <ConversationMessage
            message={row.message}
            block={row.block}
            messages={messages}
            projectId={projectId}
            conversationId={conversationId}
            conversationTurn={conversationTurn}
            showContinue={row.message.id === lastUserMessageId}
            onContinue={onContinue}
          />
        ) : (
          <LiveConversationRow row={row} projectId={projectId} conversationId={conversationId} createdAt={createdAt} />
        )}
      />
    </PlanCardsProvider>
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
  const specialized = renderSpecializedToolCard(block)
  if (specialized) return specialized
  return (
    <LazyDetails className="function-call" summary={block.name}>
      {() => <div className="tool-output-section">
        <span>{t('toolParameters')}</span>
        <pre>{block.parameters}</pre>
      </div>}
    </LazyDetails>
  )
}

const LiveConversationRow = memo(function LiveConversationRow({ row, projectId, conversationId, createdAt }: {
  row: Exclude<ConversationRenderRow, { kind: 'message' }>
  projectId: string
  conversationId: string
  createdAt?: string
}): React.JSX.Element {
  if (row.kind === 'stream') {
    return (
      <div className="message assistant live-response">
        {row.block.type === 'content'
          ? <LiveAssistantContent content={row.block.content} createdAt={createdAt} />
          : <LiveFunctionCallMessage block={row.block} />}
      </div>
    )
  }
  const item = row.item
  return (
    <div className="message assistant live-response">
      {item.type === 'compression' ? (
        <MemoCompressionMessage compression={item.compression} />
      ) : item.type === 'model-request' ? (
        <ModelRequestNotice event={item.event} />
      ) : item.block.type === 'content' ? (
        <MemoAssistantContent content={item.block.content} createdAt={createdAt} />
      ) : (
        <MemoFunctionCallMessage block={item.block} projectId={projectId} conversationId={conversationId} />
      )}
    </div>
  )
}, (previous, next) => previous.projectId === next.projectId && previous.conversationId === next.conversationId &&
  previous.createdAt === next.createdAt && previous.row.id === next.row.id &&
  (previous.row.kind === 'live' && next.row.kind === 'live' ? previous.row.item === next.row.item :
    previous.row.kind === 'stream' && next.row.kind === 'stream' && previous.row.block === next.row.block))
