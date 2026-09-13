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
  Tab,
  TabList,
  Textarea,
  webLightTheme,
} from '@fluentui/react-components'
import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type ClipboardEvent, type ErrorInfo, type FormEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { setAppLanguage } from './i18n'
import { isContextConfigValidForModel, isValidContextManagementConfig } from '../../shared/context-validation'
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
  defaultCommandExecutionConfig,
  defaultCommandReviewConfig,
  defaultContextManagementConfig,
  defaultModelConfig,
  commandExecutionSupported,
  deriveContextBudgets,
  maximumAgentLimit,
  type CommandApprovalMemory,
  type CommandApprovalRequest,
  type CommandExecutionConfig,
  type CommandReviewConfig,
  type CommandReviewRule,
  type ModelConfig,
  type Project,
  type PromptSnapshot,
  type ToolHelpSnapshot,
  type ShellDetectionResult,
  type Wsl2ManualConfig,
} from '../../shared/types'
import { findConflictingRule, isValidGlobPattern, validateCommandReviewConfig } from '../../shared/command-rules'

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

const isValidContextConfig = isValidContextManagementConfig

/** Renders text with <mark> highlights around case-insensitive keyword matches. */
function HighlightedText({ text, keyword }: { text: string; keyword: string }): React.JSX.Element {
  const trimmed = keyword.trim()
  if (!trimmed) return <>{text}</>
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'ig'))
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === trimmed.toLowerCase()
          ? <mark key={index}>{part}</mark>
          : <span key={index}>{part}</span>,
      )}
    </>
  )
}

const interpreterLabels: Record<string, string> = {  bash: 'bash',
  pwsh7: 'pwsh 7',
  pwsh51: 'pwsh 5.1',
}

const environmentLabels: Record<string, string> = {
  bare: 'bare',
  wsl2: 'wsl2',
  docker: 'docker',
  'windows-sandbox': 'Windows Sandbox',
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
  for (const message of turnMessages) {
    if (message.compression) continue
    const toolCalls = (message.blocks ?? []).filter((block): block is Extract<AssistantMessageBlock, { type: 'function_call' }> => block.type === 'function_call')
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
    if (blockHasContent(message)) {
      lines.push('', `# ${formatMessageTime(message.createdAt)} [assistant]`, message.content || '')
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
    </details>
  )
}

const MemoCompressionMessage = memo(CompressionMessage)
const MemoAssistantContent = memo(AssistantContent)
const MemoFunctionCallMessage = memo(FunctionCallMessage)

const ConversationMessage = memo(function ConversationMessage({
  message,
  messages,
  projectId,
  conversationId,
  conversationTurn,
  showContinue,
  onContinue,
}: {
  message: ChatMessage
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
            {message.content && <p>{message.content}</p>}
          </div>
        )}
      </div>
      {messageTurn && <ConversationStopwatch turn={messageTurn} />}
    </>
  )
})

function formatCommandDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${rest}s`
}

/** Shared review editor for the three settings surfaces (global, project,
 *  conversation): duration gate, reviewer checkboxes, rule list. */
function CommandReviewEditor({ value, onChange, disabled, modelConfigs, sessionModel, onOpenSyntaxHelp }: {
  value: CommandReviewConfig
  onChange: (next: CommandReviewConfig) => void
  disabled?: boolean
  modelConfigs: ModelConfig[]
  sessionModel?: ModelConfig
  onOpenSyntaxHelp?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [newPattern, setNewPattern] = useState('')
  const [newList, setNewList] = useState<'allow' | 'deny'>('deny')
  const newPatternInvalid = newPattern.trim() !== '' && !isValidGlobPattern(newPattern)
  const newPatternConflict = newPattern.trim() !== '' && Boolean(findConflictingRule(value.contentRules, { pattern: newPattern, list: newList }))
  const auditModel = value.reviewers.auditModelConfigId
    ? modelConfigs.find((model) => model.id === value.reviewers.auditModelConfigId)
    : undefined
  const updateRule = (id: string, patch: Partial<CommandReviewRule>): void => {
    onChange({ ...value, contentRules: value.contentRules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule) })
  }
  const removeRule = (id: string): void => {
    onChange({ ...value, contentRules: value.contentRules.filter((rule) => rule.id !== id) })
  }
  const addRule = (): void => {
    const pattern = newPattern.trim()
    if (!pattern || newPatternInvalid) return
    onChange({
      ...value,
      contentRules: [
        ...value.contentRules.filter((rule) => rule.pattern.trim().toLowerCase() !== pattern.toLowerCase()),
        { id: crypto.randomUUID(), pattern, patternType: 'glob', list: newList, source: 'user', enabled: true, createdAt: new Date().toISOString() },
      ],
    })
    setNewPattern('')
  }
  return (
    <div className="command-review-editor">
      <Field label={t('reviewDurationGate')} hint={t('reviewDurationGateHint')}>
        <Input
          type="number"
          min={1}
          max={1_440}
          disabled={disabled}
          value={String(Math.round(value.durationAllowSeconds / 60))}
          onChange={(_, data) => {
            const minutes = Math.floor(Number(data.value))
            if (!Number.isFinite(minutes)) return
            onChange({ ...value, durationAllowSeconds: Math.min(1_440, Math.max(1, minutes)) * 60 })
          }}
        />
      </Field>
      <p className="settings-description">{t('reviewDurationGateUnit')}</p>

      <p className="section-label">{t('reviewReviewers')}</p>
      <Switch checked disabled label={t('reviewProgramRules')} />
      <p className="settings-description">{t('reviewProgramRulesNote')}</p>
      <Switch
        checked={value.reviewers.auditModel}
        disabled={disabled}
        label={t('commandModelAudit')}
        onChange={(_, data) => onChange({ ...value, reviewers: { ...value.reviewers, auditModel: data.checked } })}
      />
      {value.reviewers.auditModel && (
        <Field label={t('commandAuditModel')} hint={t('commandAuditModelHint')}>
          <Select
            disabled={disabled}
            value={value.reviewers.auditModelConfigId ?? ''}
            onChange={(_, data) => onChange({ ...value, reviewers: { ...value.reviewers, auditModelConfigId: data.value || null } })}
          >
            <option value="">{t('notConfigured')}</option>
            {modelConfigs
              .filter((model) => model.id !== sessionModel?.id)
              .map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name || model.modelName || t('unnamedModel')}
                </option>
              ))}
          </Select>
        </Field>
      )}
      {value.reviewers.auditModel && auditModel && sessionModel &&
        auditModel.modelName.trim().toLowerCase() === sessionModel.modelName.trim().toLowerCase() && (
        <p className="settings-warning" role="alert">{t('commandAuditModelConflict')}</p>
      )}
      <Switch
        checked={value.reviewers.manualConfirmation}
        disabled={disabled}
        label={t('commandManualConfirmation')}
        onChange={(_, data) => onChange({ ...value, reviewers: { ...value.reviewers, manualConfirmation: data.checked } })}
      />
      <p className="settings-description">{t('reviewManualConfirmationNote')}</p>

      <p className="section-label">{t('reviewContentRules')}</p>
      {onOpenSyntaxHelp && (
        <Button appearance="subtle" size="small" onClick={onOpenSyntaxHelp}>
          {t('reviewSyntaxHelp')}
        </Button>
      )}
      <div className="command-rules-list">
        {value.contentRules.length === 0 && <p className="settings-description">{t('reviewNoRules')}</p>}
        {value.contentRules.map((rule) => {
          const conflict = findConflictingRule(value.contentRules, rule)
          return (
            <div className="command-rule-row" key={rule.id}>
              <input
                aria-label={t('reviewRuleEnabled')}
                type="checkbox"
                checked={rule.enabled}
                disabled={disabled}
                onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })}
              />
              <input
                aria-label={t('reviewRulePattern')}
                className="command-rule-pattern"
                type="text"
                value={rule.pattern}
                disabled={disabled}
                onChange={(event) => updateRule(rule.id, { pattern: event.target.value })}
              />
              <Select
                aria-label={t('reviewRuleList')}
                disabled={disabled}
                value={rule.list}
                onChange={(_, data) => updateRule(rule.id, { list: data.value as 'allow' | 'deny' })}
              >
                <option value="deny">{t('reviewRuleDeny')}</option>
                <option value="allow">{t('reviewRuleAllow')}</option>
              </Select>
              <span className={`command-rule-source source-${rule.source}`} title={rule.patternType === 'regex' ? t('reviewRuleRegex') : undefined}>
                {t(`reviewSource_${rule.source}`)}
              </span>
              <Button appearance="subtle" size="small" disabled={disabled} onClick={() => removeRule(rule.id)}>
                {t('reviewRuleDelete')}
              </Button>
              {conflict && <p className="settings-warning" role="alert">{t('reviewRuleConflict')}</p>}
            </div>
          )
        })}
      </div>
      {!disabled && (
        <div className="command-rule-add">
          <Input
            aria-label={t('reviewNewRulePattern')}
            placeholder="git *"
            type="text"
            value={newPattern}
            onChange={(_, data) => setNewPattern(data.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addRule()
            }}
          />
          <Select
            aria-label={t('reviewNewRuleList')}
            value={newList}
            onChange={(_, data) => setNewList(data.value as 'allow' | 'deny')}
          >
            <option value="deny">{t('reviewRuleDeny')}</option>
            <option value="allow">{t('reviewRuleAllow')}</option>
          </Select>
          <Button appearance="secondary" disabled={newPatternInvalid || newPattern.trim() === ''} onClick={addRule}>
            {t('reviewRuleAdd')}
          </Button>
        </div>
      )}
      {newPatternInvalid && <p className="settings-warning" role="alert">{t('reviewRulePatternInvalid')}</p>}
      {newPatternConflict && <p className="settings-warning" role="alert">{t('reviewRuleConflict')}</p>}
    </div>
  )
}

/** In-app approval card shown when run_command needs manual review. */
function CommandApprovalDialog({ request, onRespond, onOpenSyntaxHelp }: {
  request: CommandApprovalRequest
  onRespond: (approved: boolean, memory?: CommandApprovalMemory) => void
  onOpenSyntaxHelp: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [remember, setRemember] = useState(false)
  const [patternType, setPatternType] = useState<'exact' | 'prefix'>('exact')
  const [scope, setScope] = useState<'turn' | 'session' | 'project' | 'global'>('project')
  const [list, setList] = useState<'allow' | 'deny'>('allow')
  useEffect(() => {
    setRemember(false)
    setPatternType('exact')
    setScope('project')
    setList('allow')
  }, [request.requestId])
  const checkLabels: Record<string, string> = {
    rules: t('approvalCheckRules'),
    'model-audit': t('approvalCheckModelAudit'),
    'manual-confirmation': t('approvalCheckManual'),
  }
  const checksText = request.checks.map((check) => checkLabels[check] ?? check).join(', ')
  const respond = (approved: boolean): void => {
    onRespond(approved, remember ? { patternType, scope, list } : undefined)
  }
  return (
    <Dialog open modalType="alert" onOpenChange={(_, data) => { if (!data.open) respond(false) }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('approvalTitle')}</DialogTitle>
          <DialogContent className="dialog-fields">
            <p className="settings-description">
              {t('approvalDurationInfo', { duration: formatCommandDuration(request.timeoutSeconds) })}
            </p>
            <pre className="command-approval-command">{request.command}</pre>
            <p className="settings-description">
              {t('approvalEnvironment', { environment: request.environment, workspace: request.workspacePath })}
            </p>
            {request.auditModelName && (
              <p className="settings-description">
                {t('approvalAuditVerdict', {
                  model: request.auditModelName,
                  verdict: request.auditNote?.trim() || t('approvalNoObjection'),
                })}
              </p>
            )}
            {request.checks.length > 0 && (
              <p className="settings-description">{t('approvalChecks', { checks: checksText })}</p>
            )}
            <div className="command-approval-memory">
              <Switch checked={remember} label={t('approvalRemember')} onChange={(_, data) => setRemember(data.checked)} />
              {remember && (
                <>
                  <Field label={t('approvalMemoryPattern')}>
                    <Select value={patternType} onChange={(_, data) => setPatternType(data.value as 'exact' | 'prefix')}>
                      <option value="exact">{t('approvalMemoryExact')}</option>
                      <option value="prefix">{t('approvalMemoryPrefix')}</option>
                    </Select>
                  </Field>
                  <Field label={t('approvalMemoryScope')}>
                    <Select value={scope} onChange={(_, data) => setScope(data.value as typeof scope)}>
                      <option value="turn">{t('approvalScopeTurn')}</option>
                      <option value="session">{t('approvalScopeSession')}</option>
                      <option value="project">{t('approvalScopeProject')}</option>
                      <option value="global">{t('approvalScopeGlobal')}</option>
                    </Select>
                  </Field>
                  <Field label={t('approvalMemoryList')}>
                    <Select value={list} onChange={(_, data) => setList(data.value as 'allow' | 'deny')}>
                      <option value="allow">{t('approvalMemoryAllow')}</option>
                      <option value="deny">{t('approvalMemoryDeny')}</option>
                    </Select>
                  </Field>
                </>
              )}
            </div>
            <Button appearance="subtle" size="small" onClick={onOpenSyntaxHelp}>
              {t('reviewSyntaxHelp')}
            </Button>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => respond(false)}>
              {t('approvalDeny')}
            </Button>
            <Button appearance="primary" onClick={() => respond(true)}>
              {t('approvalApprove')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}

type VirtualWindow = { start: number; end: number }

const conversationEstimatedRowHeight = 480
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
  lastUserMessageId,
  onContinue,
}: {
  messages: ChatMessage[]
  projectId: string
  conversationId: string
  conversationTurn?: ConversationTurn
  scrollContainerRef: RefObject<HTMLDivElement | null>
  shouldStickToBottom: boolean
  lastUserMessageId?: string
  onContinue?: () => void
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
    setVirtualWindow((current) => {
      const start = visibleStartIndex + next.start
      const end = visibleStartIndex + next.end
      if (current.start === start && current.end === end) return current
      // Monotonic expansion: a stale-offsets recompute (rows still at the
      // estimated height) must never clip rows that are already rendered,
      // otherwise fast scrolling blanks the region above until the heights
      // settle. Shrinking back happens naturally once real heights land.
      return {
        start: Math.min(current.start, start),
        end: Math.max(current.end, end),
      }
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
    // Do not consume the pending growth while the user is scrolled away:
    // the effect re-runs when they return to the bottom (shouldStickToBottom
    // is a dependency) and the window resyncs then.
    if (!shouldStickToBottom) return
    previousMessageCountRef.current = messages.length
    const nextStart = historyExpandedRef.current
      ? visibleStartIndex
      : initialConversationWindowStart(messages)
    const nextLength = messages.length - nextStart
    setVirtualWindow({
      start: nextStart + Math.max(0, nextLength - 12),
      end: messages.length,
    })
  }, [messages.length, shouldStickToBottom, visibleStartIndex])

  // Self-heal a degenerate virtual window (its end at or before the visible
  // region start renders an empty slice — the conversation goes blank until
  // the component remounts). Recompute from the current scroll position so
  // content reappears in place, even when no scroll event can fire.
  useLayoutEffect(() => {
    if (visibleMessages.length === 0) return
    if (virtualWindow.end > visibleStartIndex) return
    updateWindow()
  }, [virtualWindow.end, visibleStartIndex, visibleMessages.length, updateWindow])

  const loadOlderMessages = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container || !hasOlderMessages || loadingOlderRef.current) return
    loadingOlderRef.current = true
    historyExpandedRef.current = true
    pendingAnchorRef.current = {
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    }
    const nextStartIndex = expandConversationWindowStart(
      messages,
      Math.min(startIndex, initialConversationWindowStart(messages)),
      conversationHistoryBatchSize,
    )
    setStartIndex(nextStartIndex)
    // Pre-expand the render window over the newly revealed rows: without
    // this, virtualWindow keeps its old absolute start and the freshly
    // exposed older messages stay outside the rendered slice until a later
    // recompute, which can never fire when the estimated offsets already
    // cover the viewport (the "blank above a threshold" symptom).
    setVirtualWindow((current) => ({
      start: Math.min(current.start, nextStartIndex),
      end: current.end,
    }))
    // Release the in-flight guard once the state updates are queued: the
    // anchoring effect resets it too, but when scrollTop stays at 0 the
    // anchor restore never runs (scrollHeight keeps growing) and a stuck
    // guard would reject every subsequent wheel-triggered batch.
    window.requestAnimationFrame(() => {
      loadingOlderRef.current = false
    })
  }, [hasOlderMessages, messages, scrollContainerRef, startIndex])

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
  // Rendered range hard floor: at least 16 rows or the full visible list.
  // Estimated heights compress the virtual window math on first paint
  // (a "screenful" of 180px rows is only ~2 real rows), and the self-heal
  // loop cannot widen a window whose end already exceeds the visible start —
  // fast upward scrolling then shows a long blank stretch until real heights
  // trickle in. Forcing a wide initial slice trades one cheap paint of a
  // dozen extra rows for never blanking above the fold.
  const renderedEnd = Math.max(
    Math.min(
      Math.max(renderedStart, virtualWindow.end - visibleStartIndex),
      visibleMessages.length,
    ),
    Math.min(renderedStart + 16, visibleMessages.length),
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
            messages={messages}
            projectId={projectId}
            conversationId={conversationId}
            conversationTurn={conversationTurn}
            showContinue={message.id === lastUserMessageId}
            onContinue={onContinue}
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
  modelDisabled,
  showCustomStrategy = false,
  modelConfigs,
  activeModelConfigId,
  fallbackModelId,
  emptyModelOptionLabel,
  onModelConfigChange,
  onChange,
}: {
  value: ContextManagementConfig
  disabled?: boolean
  modelDisabled?: boolean
  showCustomStrategy?: boolean
  modelConfigs?: ModelConfig[]
  activeModelConfigId?: string | null
  fallbackModelId?: string | null
  emptyModelOptionLabel?: string
  onModelConfigChange?: (modelConfigId: string) => void
  onChange: (patch: Partial<ContextManagementConfig>) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const strategyMode = contextStrategyMode(value, showCustomStrategy)
  const referenceModel = modelConfigs?.find((model) => model.id === activeModelConfigId) ??
    modelConfigs?.find((model) => model.id === fallbackModelId) ??
    modelConfigs?.[0]

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

  function applyExperiencedBudgets(): void {
    if (!referenceModel) {
      return
    }
    onChange(deriveContextBudgets(referenceModel.modelMaxContext, referenceModel.modelMaxOutputTokens))
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
          <Field label={t('customContextStrategyPrompt')} hint={t('customContextStrategyPromptHint')}>
            <Textarea
              disabled={disabled}
              resize="vertical"
              value={value.customStrategyPrompt ?? ''}
              onChange={(_, data) => onChange({ customStrategyPrompt: data.value })}
              placeholder={t('customContextStrategyPromptPlaceholder')}
              rows={4}
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
          {modelConfigs !== undefined && modelConfigs.length > 0 && (
            <Field label={t('modelConfiguration')}>
              <Select
                disabled={modelDisabled ?? disabled}
                value={activeModelConfigId ?? referenceModel?.id ?? ''}
                onChange={(_, data) => onModelConfigChange?.(data.value)}
              >
                {emptyModelOptionLabel !== undefined && <option value="">{emptyModelOptionLabel}</option>}
                {modelConfigs.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name || model.modelName || t('unnamedModel')}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Button
            appearance="secondary"
            disabled={disabled || !referenceModel}
            onClick={applyExperiencedBudgets}
          >
            {t('generateExperiencedConfig')}
          </Button>
          {strategyMode === 'default' && (
            <Field label={t('maxInputTokens')} hint={t('maxInputTokensHint')}>
              <Input
                disabled={disabled}
                min={0}
                step={1000}
                type="number"
                value={value.maxInputTokens >= 1 ? String(value.maxInputTokens) : ''}
                onChange={(_, data) => onChange({
                  maxInputTokens: data.value === '' || !Number.isFinite(Number(data.value)) || Number(data.value) < 1
                    ? 0
                    : Number(data.value),
                })}
              />
            </Field>
          )}
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
  const [commandDialogOpen, setCommandDialogOpen] = useState(false)
  const [commandProjectId, setCommandProjectId] = useState('')
  const [commandConversationId, setCommandConversationId] = useState('')
  const [commandSettingsScope, setCommandSettingsScope] = useState<'conversation' | 'project'>('conversation')
  const [commandDraft, setCommandDraft] = useState<CommandExecutionConfig | null>(defaultCommandExecutionConfig)
  const [commandTab, setCommandTab] = useState<'execution' | 'review'>('execution')
  const [approvalRequest, setApprovalRequest] = useState<CommandApprovalRequest | null>(null)
  const [shellDetection, setShellDetection] = useState<ShellDetectionResult | null>(null)
  const [shellDetectBusy, setShellDetectBusy] = useState(false)
  const [wslDistros, setWslDistros] = useState<string[]>([])
  const [wsl2Draft, setWsl2Draft] = useState<Wsl2ManualConfig>({ distro: '', sandboxUser: '' })
  const [wsl2ConfigBusy, setWsl2ConfigBusy] = useState(false)
  const [promptSnapshot, setPromptSnapshot] = useState<PromptSnapshot | null>(null)
  const [helpDialogOpen, setHelpDialogOpen] = useState(false)
  const [helpTab, setHelpTab] = useState<'tools' | 'commandRules'>('tools')
  const [toolHelp, setToolHelp] = useState<ToolHelpSnapshot | null>(null)
  const [toolSearch, setToolSearch] = useState('')
  const [toolMatchIndex, setToolMatchIndex] = useState(0)
  const toolListRef = useRef<HTMLDivElement>(null)
  const [wsl2ConfigOpen, setWsl2ConfigOpen] = useState(false)
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null)
  const [openConversationMenuId, setOpenConversationMenuId] = useState<string | null>(null)
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [conversationStates, setConversationStates] = useState<Record<string, ConversationRuntimeState>>({})
  const [stoppingConversations, setStoppingConversations] = useState<Record<string, boolean>>({})
  const [conversationTurns, setConversationTurns] = useState<Record<string, ConversationTurn>>({})
  const [saving, setSaving] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [error, setError] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [capabilitiesBusy, setCapabilitiesBusy] = useState(false)
  const [connectivityBusy, setConnectivityBusy] = useState(false)
  const [connectivityStatus, setConnectivityStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [toast, setToast] = useState<{ message: string; tone: 'info' | 'error' } | null>(null)
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
  const toastTimerRef = useRef<number | undefined>(undefined)
  const settingsOpenedOnceRef = useRef(false)
  const [settingsTab, setSettingsTab] = useState<'models' | 'language' | 'power' | 'archive' | 'developer' | 'prompts'>('models')

  const visibleProjects = projects.filter((project) => !project.archived)
  const activeProject = visibleProjects.find((project) => project.id === activeProjectId)
  const visibleConversations = activeProject?.conversations.filter((conversation) => !conversation.archived) ?? []
  const archivedProjects = projects.filter((project) => project.archived)
  const archivedConversations = projects
    .filter((project) => !project.archived)
    .flatMap((project) => project.conversations
      .filter((conversation) => conversation.archived)
      .map((conversation) => ({ project, conversation })))
  const activeConversation = visibleConversations.find(
    (conversation) => conversation.id === activeConversationId,
  )
  const projectModelConfigId = activeProject?.defaultModelConfigId ?? config.activeModelConfigId
  const effectiveModelConfigId = activeConversation?.modelConfigId ?? projectModelConfigId
  const effectiveModelConfig = config.modelConfigs.find((model) => model.id === effectiveModelConfigId)
  const effectiveContextConfig = activeConversation?.contextConfigOverride ??
    activeProject?.contextConfigOverride ?? config.contextManagement
  const maxInputTokensError = effectiveModelConfig &&
    effectiveContextConfig.maxInputTokens > effectiveModelConfig.modelMaxContext
    ? t('maxInputTokensContextError', {
        tokens: effectiveContextConfig.maxInputTokens.toLocaleString(),
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
    ? `${Math.round((context.compressedTokens / context.modelMaxContext) * 100)}% context / ${Math.round((context.compressedTokens / context.maxInputTokens) * 100)}% input`
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
  const conversationContextConfigInvalid = Boolean(activeConversation && activeConversation.modelConfigId && effectiveModelConfig &&
    !isContextConfigValidForModel(
      activeConversation.contextConfigOverride ?? activeProject?.contextConfigOverride ?? config.contextManagement,
      effectiveModelConfig.modelMaxContext,
    ))
  const canSend = Boolean(configured && activeProject?.folders.length && activeConversation && !interactionLocked && !conversationContextConfigInvalid)
  activeConversationKeyRef.current = activeConversationKey
  const lastUserMessage = activeConversation
    ? [...activeConversation.messages].reverse().find((message) => message.role === 'user')
    : undefined
  const lastUserMessageId = activeConversationState === 'idle' ? lastUserMessage?.id : undefined
  const continueConversation = (): void => {
    if (!lastUserMessage || !canSend) return
    const prompts = [t('continuePromptAbnormal'), t('continuePromptNormal')]
    const lastTurn = lastUserMessage.turn
      ?? (conversationTurn?.userMessageId === lastUserMessage.id ? conversationTurn : undefined)
    const content = prompts.includes(lastUserMessage.content)
      ? lastUserMessage.content
      : lastTurn?.result === 'normal'
        ? prompts[1]
        : prompts[0]
    void sendMessage(content, [])
  }

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
        const firstProject = savedProjects.find((project) => !project.archived)
        const firstConversation = firstProject?.conversations.find((conversation) => !conversation.archived)
        if (firstProject) {
          setActiveProjectId(firstProject.id)
          setActiveConversationId(firstConversation?.id ?? '')
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
    const firstConversation = project.conversations.find((conversation) => !conversation.archived)
    setActiveProjectId(project.id)
    setActiveConversationId(firstConversation?.id ?? '')
    setOpenProjectMenuId(null)
    setOpenConversationMenuId(null)
    setError('')
  }

  async function setProjectArchive(project: Project, archived: boolean): Promise<void> {
    try {
      const updated = await window.codey.setProjectArchived(project.id, archived)
      replaceProject(updated)
      setOpenProjectMenuId(null)
      if (archived && activeProjectId === project.id) {
        const nextProject = projects.find((item) => item.id !== project.id && !item.archived)
        if (nextProject) selectProject(nextProject)
        else {
          setActiveProjectId('')
          setActiveConversationId('')
        }
      } else if (!archived && !activeProjectId) {
        selectProject(updated)
      }
    } catch (reason) {
      setArchiveError(reason instanceof Error ? reason.message : t('unableArchive'))
    }
  }

  async function setConversationArchive(projectId: string, conversationId: string, archived: boolean): Promise<void> {
    try {
      const updated = await window.codey.setConversationArchived(projectId, conversationId, archived)
      replaceProject(updated)
      setOpenConversationMenuId(null)
      if (archived && activeProjectId === projectId && activeConversationId === conversationId) {
        const nextConversation = updated.conversations.find((conversation) => !conversation.archived)
        setActiveConversationId(nextConversation?.id ?? '')
      }
    } catch (reason) {
      setArchiveError(reason instanceof Error ? reason.message : t('unableArchive'))
    }
  }

  function openArchiveList(): void {
    setSettingsOpen(false)
    setArchiveError('')
    setArchiveDialogOpen(true)
  }

  function createSettingsDraft(): typeof defaultAppConfig {
    if (config.modelConfigs.length > 0) {
      return config
    }
    const model = { ...defaultModelConfig, id: crypto.randomUUID() }
    return { ...config, modelConfigs: [model], activeModelConfigId: model.id }
  }

  function openHelp(): void {
    setHelpDialogOpen(true)
    if (!toolHelp) {
      void window.codey.getToolHelpSnapshot().then(setToolHelp).catch(() => setToolHelp(null))
    }
  }

  const toolKeyword = toolSearch.trim().toLowerCase()
  const toolMatches = useMemo(
    () => (toolHelp && toolKeyword
      ? toolHelp.entries.filter((entry) => entry.name.toLowerCase().includes(toolKeyword))
      : []),
    [toolHelp, toolKeyword],
  )

  // Keyword changes reset the jump position; the effect scrolls to it.
  useEffect(() => {
    setToolMatchIndex(0)
  }, [toolKeyword])

  useEffect(() => {
    if (!helpDialogOpen || toolMatches.length === 0) return
    const container = toolListRef.current
    if (!container) return
    const name = toolMatches[Math.min(toolMatchIndex, toolMatches.length - 1)]?.name ?? ''
    const target = container.querySelector<HTMLElement>(`[data-tool-name="${CSS.escape(name)}"]`)
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [toolMatchIndex, toolMatches, helpDialogOpen])

  function jumpToMatch(direction: 1 | -1): void {
    if (toolMatches.length === 0) return
    setToolMatchIndex((current) => (current + direction + toolMatches.length) % toolMatches.length)
  }

  function isCurrentMatch(name: string): boolean {
    if (toolMatches.length === 0) return false
    return toolMatches[Math.min(toolMatchIndex, toolMatches.length - 1)]?.name === name
  }

  function openSettings(): void {
    // Keep unsaved drafts (e.g. a freshly added model configuration) across
    // dialog close/reopen; only seed once when the dialog has never been
    // opened or after a successful save replaced the draft.
    if (!settingsOpenedOnceRef.current || configDraft === config) {
      setConfigDraft(createSettingsDraft())
      settingsOpenedOnceRef.current = true
    }
    setSettingsError('')
    void window.codey.getCachedShellDetection().then((cached) => {
      if (cached) setShellDetection(cached)
    }).catch(() => undefined)
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
      setBridgeError(error instanceof Error ? error.message : t('unableLoadHandoverStatus'))
    }
  }

  async function createBridgeChannel(): Promise<void> {
    setBridgeBusy(true)
    setBridgeError('')
    try {
      await window.codey.createBridgeChannel(bridgeUrl)
      setBridgeChannels(await window.codey.getBridgeChannels())
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : t('createHandoverChannelFailed'))
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
      setBridgeError(error instanceof Error ? error.message : t('approveHandoverRequestFailed'))
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
      setBridgeError(error instanceof Error ? error.message : t('rejectHandoverRequestFailed'))
    } finally {
      setBridgeBusy(false)
    }
  }

  async function copyBridgeInvitation(channel: BridgeChannelStatus): Promise<void> {
    if (!channel.invitation) return
    try {
      await navigator.clipboard.writeText(channel.invitation)
      setBridgeError(t('handoverInvitationCopied'))
    } catch {
      setBridgeError(t('handoverInvitationCopyFailed'))
    }
  }

  async function syncBridgeNow(channelId?: string): Promise<void> {
    setBridgeBusy(true)
    setBridgeError('')
    try {
      setBridgeChannels(await window.codey.syncBridge(channelId))
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : t('syncHandoverFailed'))
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
      setBridgeError(error instanceof Error ? error.message : t('refreshHandoverInvitationFailed'))
    } finally {
      setBridgeBusy(false)
    }
  }

  async function removeBridgeChannel(channel: BridgeChannelStatus): Promise<void> {
    if (!window.confirm(t('removeHandoverChannelConfirm', { channelId: channel.channelId }))) return
    setBridgeBusy(true)
    setBridgeError('')
    try {
      setBridgeChannels(await window.codey.removeBridgeChannel(channel.channelId))
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : t('removeHandoverChannelFailed'))
    } finally {
      setBridgeBusy(false)
    }
  }

  function updateContextDraft(patch: Partial<ContextManagementConfig>): void {
    setContextDraft((current) => ({ ...current, ...patch }))
  }

  async function changeContextModelConfig(modelConfigId: string): Promise<void> {
    if (interactionLocked) {
      return
    }
    if (contextScope === 'conversation') {
      await changeConversationModelConfig(modelConfigId)
      return
    }
    if (contextProjectId) {
      await changeProjectModelConfig(contextProjectId, modelConfigId)
    }
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

  /** Materializes the effective config for a conversation: its own override,
   *  else the project default, else the built-in matrix — with review falling
   *  back to the global review config. Used when a user turns off
   *  "follow upper layer" and starts editing an override. */
  function effectiveConversationCommandConfig(): CommandExecutionConfig {
    const base = activeConversation?.commandExecution ?? activeProject?.commandExecutionDefault ?? defaultCommandExecutionConfig
    return { ...structuredClone(base), review: base.review ?? structuredClone(config.commandReviewGlobal) }
  }

  function openCommandSettings(scope: 'conversation' | 'project'): void {
    if (!activeProject || interactionLocked) return
    const conversation = activeConversation
    if (scope === 'conversation' && !conversation) return
    setCommandProjectId(activeProject.id)
    setCommandConversationId(scope === 'conversation' && conversation ? conversation.id : '')
    setCommandSettingsScope(scope)
    setCommandDraft(scope === 'conversation'
      ? conversation?.commandExecution ? structuredClone(conversation.commandExecution) : null
      : activeProject.commandExecutionDefault ? structuredClone(activeProject.commandExecutionDefault) : null)
    setCommandTab('execution')
    setSettingsError('')
    setCommandDialogOpen(true)
    // Availability checks need a detection; run one if none is cached so the
    // first save does not fail with "run environment detection".
    void window.codey.getCachedShellDetection().then((cached) => {
      if (cached) {
        setShellDetection(cached)
        return
      }
      return runShellDetection()
    }).catch(() => undefined)
  }

  /** Reloads the draft when the scope switch flips inside the dialog. */
  function switchCommandSettingsScope(scope: 'conversation' | 'project'): void {
    if (scope === commandSettingsScope) return
    if (scope === 'conversation' && !activeConversation) return
    setCommandSettingsScope(scope)
    setCommandConversationId(scope === 'conversation' ? activeConversation?.id ?? '' : '')
    setCommandDraft(scope === 'conversation'
      ? activeConversation?.commandExecution ? structuredClone(activeConversation.commandExecution) : null
      : activeProject?.commandExecutionDefault ? structuredClone(activeProject.commandExecutionDefault) : null)
    setSettingsError('')
  }

  async function saveCommandExecutionSettings(): Promise<void> {
    if (interactionLocked || !isValidCommandExecutionDraft(commandDraft)) {
      return
    }
    setSaving(true)
    setSettingsError('')
    try {
      const updated = commandSettingsScope === 'conversation'
        ? await window.codey.setConversationCommandExecution(commandProjectId, commandConversationId, commandDraft)
        : await window.codey.setProjectCommandExecutionDefault(commandProjectId, commandDraft)
      replaceProject(updated)
      setCommandDialogOpen(false)
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : t('unableChangeCommandExecution'))
    } finally {
      setSaving(false)
    }
  }

  function isValidCommandExecutionDraft(draft: CommandExecutionConfig | null): boolean {
    if (draft === null) return true
    if (!commandExecutionSupported(draft.interpreter, draft.environment)) return false
    // The session default combo must be within the enabled combos.
    if (!(draft.enabledEnvironments[draft.interpreter] ?? []).includes(draft.environment)) return false
    // Every enabled combo must be supported.
    for (const [interpreter, environments] of Object.entries(draft.enabledEnvironments)) {
      for (const environment of environments) {
        if (!commandExecutionSupported(interpreter as CommandExecutionConfig['interpreter'], environment)) return false
      }
    }
    if (draft.review !== null && !validateCommandReviewConfig(draft.review)) return false
    return true
  }

  function respondCommandApproval(approved: boolean, memory?: CommandApprovalMemory): void {
    const request = approvalRequest
    if (!request) return
    setApprovalRequest(null)
    void window.codey.respondCommandReview(request.requestId, { approved, memory }).catch(() => undefined)
  }

  function openCommandRulesHelp(): void {
    setHelpTab('commandRules')
    setHelpDialogOpen(true)
    if (!toolHelp) {
      void window.codey.getToolHelpSnapshot().then(setToolHelp).catch(() => setToolHelp(null))
    }
  }

  useEffect(() => window.codey.onCommandReviewRequest((request) => setApprovalRequest(request)), [])

  async function runShellDetection(): Promise<void> {
    if (shellDetectBusy) {
      return
    }
    setShellDetectBusy(true)
    try {
      setShellDetection(await window.codey.detectShells())
    } catch {
      setShellDetection(null)
    } finally {
      setShellDetectBusy(false)
    }
  }

  async function pickBashExecutable(): Promise<void> {
    try {
      const picked = await window.codey.pickBashExecutable()
      if (picked) {
        setShellDetection(await window.codey.detectShells())
      }
    } catch {
      showToast(t('unableChangeCommandExecution'), 'error')
    }
  }

  async function openWsl2Config(): Promise<void> {
    if (wsl2ConfigBusy) {
      return
    }
    setWsl2ConfigOpen(true)
    setWsl2ConfigBusy(true)
    try {
      const [distros, current] = await Promise.all([
        window.codey.listWslDistros(),
        window.codey.getWsl2ManualConfig(),
      ])
      setWslDistros(distros)
      setWsl2Draft(current ?? { distro: distros[0] ?? '', sandboxUser: '' })
    } catch {
      setWslDistros([])
    } finally {
      setWsl2ConfigBusy(false)
    }
  }

  async function saveWsl2Config(): Promise<void> {
    if (!wsl2Draft.distro.trim() || !wsl2Draft.sandboxUser.trim()) {
      return
    }
    setWsl2ConfigBusy(true)
    try {
      await window.codey.setWsl2ManualConfig({ distro: wsl2Draft.distro.trim(), sandboxUser: wsl2Draft.sandboxUser.trim() })
      setShellDetection(await window.codey.detectShells())
    } catch {
      showToast(t('unableChangeCommandExecution'), 'error')
    } finally {
      setWsl2ConfigBusy(false)
    }
  }

  async function clearWsl2Config(): Promise<void> {
    setWsl2ConfigBusy(true)
    try {
      await window.codey.setWsl2ManualConfig(null)
      setShellDetection(await window.codey.detectShells())
    } catch {
      showToast(t('unableChangeCommandExecution'), 'error')
    } finally {
      setWsl2ConfigBusy(false)
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

  function duplicateSelectedModelConfig(): void {
    const selected = configDraft.modelConfigs.find((model) => model.id === configDraft.activeModelConfigId)
    if (!selected) {
      return
    }
    const copy: ModelConfig = {
      ...selected,
      id: crypto.randomUUID(),
      name: `${selected.name || selected.modelName || t('unnamedModel')} ${t('modelConfigCopySuffix')}`,
    }
    setConfigDraft((current) => ({
      ...current,
      modelConfigs: [...current.modelConfigs, copy],
      activeModelConfigId: copy.id,
    }))
  }

  async function testSelectedModelConnectivity(): Promise<void> {
    const selected = configDraft.modelConfigs.find((model) => model.id === configDraft.activeModelConfigId)
    if (!selected || connectivityBusy || !selected.baseUrl.trim() || !selected.modelName.trim()) {
      return
    }
    setConnectivityBusy(true)
    setConnectivityStatus(null)
    try {
      const result = await window.codey.testModelConnectivity(selected)
      if (result.status === 'ok') {
        setConnectivityStatus({ tone: 'ok', text: t('connectivityOk', { count: result.models }) })
        return
      }
      if (result.status === 'network-error') {
        setConnectivityStatus({ tone: 'error', text: t('connectivityNetworkError') })
        return
      }
      if (result.status === 'auth-error') {
        setConnectivityStatus({ tone: 'error', text: t('connectivityAuthError') })
        return
      }
      if (result.status === 'model-not-found') {
        setConnectivityStatus({ tone: 'error', text: t('connectivityModelNotFound', { model: selected.modelName, available: result.available.slice(0, 5).join(', ') }) })
        return
      }
      setConnectivityStatus({ tone: 'error', text: t('connectivityEndpointError', { detail: result.detail }) })
    } catch {
      setConnectivityStatus({ tone: 'error', text: t('connectivityNetworkError') })
    } finally {
      setConnectivityBusy(false)
    }
  }

  function deleteSelectedModelConfig(): void {
    const selectedId = configDraft.activeModelConfigId
    if (!selectedId) {
      return
    }
    const target = configDraft.modelConfigs.find((model) => model.id === selectedId)
    if (!target) {
      return
    }
    const label = target.name || target.modelName || t('unnamedModel')
    if (!window.confirm(t('deleteModelConfigConfirm', { name: label }))) {
      return
    }
    setConfigDraft((current) => {
      const remaining = current.modelConfigs.filter((model) => model.id !== selectedId)
      if (remaining.length === 0) {
        const model = { ...defaultModelConfig, id: crypto.randomUUID() }
        return { ...current, modelConfigs: [model], activeModelConfigId: model.id }
      }
      return {
        ...current,
        modelConfigs: remaining,
        activeModelConfigId: remaining.some((model) => model.id === current.activeModelConfigId)
          ? current.activeModelConfigId
          : remaining[0].id,
      }
    })
  }

  function showToast(message: string, tone: 'info' | 'error'): void {
    if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    setToast({ message, tone })
    toastTimerRef.current = window.setTimeout(() => setToast(null), 5_000)
  }

  async function fetchModelCapabilitiesForSelected(): Promise<void> {
    const modelName = selectedModel?.modelName.trim() ?? ''
    if (!modelName || capabilitiesBusy) {
      return
    }
    setCapabilitiesBusy(true)
    try {
      const result = await window.codey.fetchModelCapabilities(modelName)
      if (result.status === 'ok') {
        updateSelectedModel({
          ...(result.maxContextTokens !== undefined ? { modelMaxContext: result.maxContextTokens } : {}),
          ...(result.maxOutputTokens !== undefined ? { modelMaxOutputTokens: result.maxOutputTokens } : {}),
          supportsImageInput: result.image,
          supportsPdfInput: result.pdf,
          supportsVideoInput: result.video,
          supportsAudioInput: result.audio,
        })
        showToast(t('modelCapabilitiesFetched'), 'info')
        return
      }
      if (result.status === 'not-found') {
        showToast(t('modelCapabilitiesNotFound', { model: modelName }), 'error')
        return
      }
      showToast(t('modelCapabilitiesNetworkError'), 'error')
    } catch {
      showToast(t('modelCapabilitiesNetworkError'), 'error')
    } finally {
      setCapabilitiesBusy(false)
    }
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
  const settingsDirty = configDraft !== config
  const invalidModelConfig = configDraft.modelConfigs.length === 0 || configDraft.modelConfigs.some((model) =>
    !model.name.trim() ||
    !model.baseUrl.trim() ||
    !model.apiKey.trim() ||
    !model.modelName.trim() ||
    model.modelMaxContext < 1_000 ||
    (model.modelMaxOutputTokens !== undefined &&
      (!Number.isInteger(model.modelMaxOutputTokens) || model.modelMaxOutputTokens < 1))
  )
  const invalidAppContextConfig = !isValidContextConfig(configDraft.contextManagement)
  const invalidGlobalCommandReview = !validateCommandReviewConfig(configDraft.commandReviewGlobal)
  const invalidContextOverride = contextOverrideEnabled && !isValidContextConfig(contextDraft)

  return (
    <FluentProvider className="app" theme={webLightTheme}>
      <main className="shell">
        <aside className="sidebar">

          <Button appearance="primary" onClick={openProjectDialog}>
            {t('newProject')}
          </Button>

          <section className="sidebar-section projects-section">
            <p className="section-label">{t('projects')}</p>
            <nav className="nav-list" aria-label={t('projects')}>
              {visibleProjects.map((project) => (
                <div className="project-nav-item" key={project.id}>
                  <div className="project-nav-row">
                    <Button className="nav-item-button" appearance={project.id === activeProjectId ? 'secondary' : 'subtle'} onClick={() => selectProject(project)}>
                      <span className="nav-item-title">{project.name}</span>
                    </Button>
                    <Button appearance="subtle" size="small" aria-expanded={openProjectMenuId === project.id} aria-label={t('projectOptions')} onClick={() => setOpenProjectMenuId((current) => current === project.id ? null : project.id)}>
                      …
                    </Button>
                  </div>
                  {openProjectMenuId === project.id && (
                    <div className="project-menu-panel">
                      <label>
                        <span>{t('projectDefaultModel')}</span>
                        <Select aria-label={t('projectDefaultModel')} disabled={interactionLocked || config.modelConfigs.length === 0} value={project.defaultModelConfigId ?? ''} onChange={(_, data) => { setOpenProjectMenuId(null); void changeProjectModelConfig(project.id, data.value) }}>
                          <option value="">{t('applicationDefault')}</option>
                          {config.modelConfigs.map((model) => <option key={model.id} value={model.id}>{model.name || model.modelName || t('unnamedModel')}</option>)}
                        </Select>
                      </label>
                      <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => openContextSettings('project', project)}>{t('contextSettings')}</Button>
                      <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => void setProjectArchive(project, true)}>{t('archiveProject')}</Button>
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
                <Button appearance="subtle" size="small" onClick={() => void startNewConversation()}>{t('new')}</Button>
              </div>
              <nav className="nav-list" aria-label={t('conversations')}>
                {visibleConversations.map((conversation) => (
                  <div className="conversation-nav-item" key={conversation.id}>
                    <div className="conversation-nav-row">
                      <Button className="nav-item-button" appearance={conversation.id === activeConversationId ? 'secondary' : 'subtle'} onClick={() => { setActiveConversationId(conversation.id); setOpenConversationMenuId(null); setError('') }}>
                        <span className="nav-item-title">{conversation.title}</span>
                      </Button>
                      <Button appearance="subtle" size="small" aria-expanded={openConversationMenuId === conversation.id} aria-label={t('conversationOptions')} onClick={() => setOpenConversationMenuId((current) => current === conversation.id ? null : conversation.id)}>…</Button>
                    </div>
                    {openConversationMenuId === conversation.id && (
                      <div className="conversation-menu-panel">
                        <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => void setConversationArchive(activeProject.id, conversation.id, true)}>{t('archiveConversation')}</Button>
                      </div>
                    )}
                  </div>
                ))}
              </nav>
            </section>
          )}

          <Button className="settings-button" appearance="subtle" onClick={openHelp}>
            {t('help')}
          </Button>
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
            {t('handover')}
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
                  {config.developerMode && activeProject && (
                    <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => openCommandSettings('conversation')}>
                      {t('commandAndReview')}：{(activeConversation.commandExecution ?? activeProject.commandExecutionDefault ?? defaultCommandExecutionConfig).enabled ? t('commandExecutionOn') : t('commandExecutionOff')}
                    </Button>
                  )}
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
              {conversationContextConfigInvalid && (
                <div className="topbar-row">
                  <span className="context-config-invalid" role="alert">
                    {t('conversationContextConfigInvalid', { model: effectiveModelConfig?.name || effectiveModelConfig?.modelName })}
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
                  lastUserMessageId={lastUserMessageId}
                  onContinue={continueConversation}
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
              if (maxInputTokensError) {
                setError(maxInputTokensError)
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

      <Dialog open={helpDialogOpen} onOpenChange={(_, data) => setHelpDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('help')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <TabList
                selectedValue={helpTab}
                onTabSelect={(_, data) => setHelpTab(data.value as typeof helpTab)}
              >
                <Tab value="tools">{t('helpTools')}</Tab>
                <Tab value="commandRules">{t('helpCommandRules')}</Tab>
              </TabList>
              {helpTab === 'commandRules' && (
                <section className="settings-group command-rules-help">
                  <p className="settings-description">{t('helpCommandRulesIntro')}</p>
                  <p className="section-label">{t('helpCommandRulesPatterns')}</p>
                  <ul className="command-rules-help-list">
                    <li><code>git status</code> — {t('helpCommandRulesExact')}</li>
                    <li><code>git *</code> — {t('helpCommandRulesStar')}</li>
                    <li><code>pnpm run build *</code> — {t('helpCommandRulesTailStar')}</li>
                    <li><code>npm run ?</code> — {t('helpCommandRulesQuestion')}</li>
                    <li><code>git commit -m "fix bug"</code> — {t('helpCommandRulesQuoted')}</li>
                  </ul>
                  <p className="section-label">{t('helpCommandRulesSemantics')}</p>
                  <ul className="command-rules-help-list">
                    <li>{t('helpCommandRulesCase')}</li>
                    <li>{t('helpCommandRulesPrecedence')}</li>
                    <li>{t('helpCommandRulesMutex')}</li>
                    <li>{t('helpCommandRulesDuration')}</li>
                    <li>{t('helpCommandRulesBuiltin')}</li>
                    <li>{t('helpCommandRulesRegex')}</li>
                  </ul>
                </section>
              )}
              {helpTab === 'tools' && (
                <section className="settings-group tool-help-group">
                      <p className="settings-description">
                        {toolHelp
                          ? toolSearch.trim()
                            ? t('helpToolMatchCount', { count: toolMatches.length, total: toolHelp.entries.length })
                            : t('helpToolTotalCount', { count: toolHelp.entries.length })
                          : ''}
                      </p>
                      {toolHelp && <p className="settings-description">{t('helpToolToolsetNote')}</p>}
                  <div className="tool-search-row">
                    <div className="tool-search-field">
                      <Field label={t('helpToolSearch')}>
                        <Input
                          value={toolSearch}
                          onChange={(_, data) => setToolSearch(data.value)}
                          placeholder={t('helpToolSearchPlaceholder')}
                        />
                      </Field>
                    </div>
                    {toolMatches.length > 1 && (
                      <div className="tool-search-nav">
                        <Button appearance="subtle" size="small" aria-label={t('helpToolPreviousMatch')} onClick={() => jumpToMatch(-1)}>
                          ↑
                        </Button>
                        <span className="tool-match-position">{toolMatchIndex + 1} / {toolMatches.length}</span>
                        <Button appearance="subtle" size="small" aria-label={t('helpToolNextMatch')} onClick={() => jumpToMatch(1)}>
                          ↓
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="tool-help-list" ref={toolListRef}>
                    {!toolHelp && <p className="settings-description">{t('loadingPrompts')}</p>}
                    {toolHelp && (() => {
                      const renderEntry = (entry: typeof toolHelp.entries[number], showToolset: boolean) => (
                        <div className={`tool-help-entry${isCurrentMatch(entry.name) ? ' current-match' : ''}`} data-tool-name={entry.name} key={entry.name}>
                          <h3>
                            <HighlightedText keyword={toolSearch} text={entry.name} />
                            {showToolset && entry.toolset && (
                              <span className="tool-help-toolset" title={t('helpToolToolsetTitle', { toolset: entry.toolset })}>
                                {t('helpToolToolset', { toolset: entry.toolset })}
                              </span>
                            )}
                          </h3>
                          <p className="settings-description">{entry.description}</p>
                          <details>
                            <summary>{t('helpToolParameters')}</summary>
                            <pre className="prompt-content">{entry.parameters}</pre>
                          </details>
                          <p className="tool-help-returns">{t('helpToolReturns')}: {entry.returns}</p>
                        </div>
                      )
                      const groupEntries = (hidden: boolean) => {
                        const groups = new Map<string, typeof toolHelp.entries>()
                        for (const entry of toolHelp.entries) {
                          if (!entry.toolset || entry.toolsetHidden !== hidden) continue
                          const bucket = groups.get(entry.toolset) ?? []
                          bucket.push(entry)
                          groups.set(entry.toolset, bucket)
                        }
                        return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
                      }
                      // Search keeps the flat list so match navigation stays
                      // contiguous; the catalog view groups by toolset: meta
                      // tool first, then always-unlocked sets, then sets that
                      // unlock on demand — each section alphabetically.
                      if (toolSearch.trim()) {
                        return toolMatches.map((entry) => renderEntry(entry, true))
                      }
                      return (
                        <>
                          <h4 className="tool-help-group-header">{t('helpToolMetaSection')}</h4>
                          {toolHelp.entries.filter((entry) => !entry.toolset).map((entry) => renderEntry(entry, false))}
                          <h4 className="tool-help-group-header">{t('helpToolsetUnlockedSection')}</h4>
                          {groupEntries(false).map(([toolset, entries]) => (
                            <div key={toolset}>
                              <h5 className="tool-help-toolset-header">
                                {toolset}
                                <span className="tool-help-toolset-state">{t('helpToolsetUnlockedLabel')}</span>
                              </h5>
                              {entries.map((entry) => renderEntry(entry, false))}
                            </div>
                          ))}
                          <h4 className="tool-help-group-header">{t('helpToolsetOnDemandSection')}</h4>
                          {groupEntries(true).map(([toolset, entries]) => (
                            <div key={toolset}>
                              <h5 className="tool-help-toolset-header">
                                {toolset}
                                <span className="tool-help-toolset-state">{t('helpToolsetOnDemandLabel')}</span>
                              </h5>
                              {entries.map((entry) => renderEntry(entry, false))}
                            </div>
                          ))}
                        </>
                      )
                    })()}
                  </div>
                </section>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setHelpDialogOpen(false)}>
                {t('close')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {approvalRequest && (
        <CommandApprovalDialog
          request={approvalRequest}
          onRespond={(approved, memory) => respondCommandApproval(approved, memory)}
          onOpenSyntaxHelp={openCommandRulesHelp}
        />
      )}

      <Dialog open={settingsOpen} onOpenChange={(_, data) => setSettingsOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('settings')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <TabList
                selectedValue={settingsTab}
                onTabSelect={(_, data) => {
                  const next = data.value as typeof settingsTab
                  setSettingsTab(next)
                  if (next === 'prompts' && !promptSnapshot) {
                    void window.codey.getPromptSnapshot().then(setPromptSnapshot).catch(() => setPromptSnapshot(null))
                  }
                }}
              >
                <Tab value="models">{t('models')}</Tab>
                <Tab value="language">{t('language')}</Tab>
                <Tab value="power">{t('powerSettings')}</Tab>
                <Tab value="archive">{t('archivedItems')}</Tab>
                <Tab value="developer">{t('developerMode')}</Tab>
                <Tab value="prompts">{t('prompts')}</Tab>
              </TabList>
              {settingsTab === 'models' && (
              <section className="settings-group">
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
                  <Button appearance="secondary" onClick={duplicateSelectedModelConfig}>
                    {t('duplicateModelConfig')}
                  </Button>
                  <Button appearance="secondary" onClick={deleteSelectedModelConfig}>
                    {t('deleteModelConfig')}
                  </Button>
                  <Button
                    appearance="secondary"
                    disabled={!selectedModel?.baseUrl.trim() || !selectedModel?.modelName.trim() || connectivityBusy}
                    onClick={() => void testSelectedModelConnectivity()}
                  >
                    {connectivityBusy ? t('testingConnectivity') : t('testConnectivity')}
                  </Button>
                  <Button
                    appearance="primary"
                    disabled={invalidModelConfig || invalidAppContextConfig || invalidGlobalCommandReview || interactionLocked || saving}
                    onClick={() => void saveSettings()}
                  >
                    {saving ? t('saving') : t('save')}
                  </Button>
                </div>
                <p className="model-config-status-line" role="status">
                  <span className={`model-config-save-state${settingsDirty ? ' dirty' : ''}`}>
                    {settingsDirty ? t('settingsUnsaved') : t('settingsSaved')}
                  </span>
                  {connectivityStatus && (
                    <span className={`connectivity-status ${connectivityStatus.tone}`}> {connectivityStatus.text}</span>
                  )}
                </p>
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
                <Button
                  appearance="secondary"
                  disabled={!selectedModel?.modelName.trim() || capabilitiesBusy}
                  onClick={() => void fetchModelCapabilitiesForSelected()}
                >
                  {capabilitiesBusy ? t('fetchingModelCapabilities') : t('fetchModelCapabilities')}
                </Button>
                <Field label={t('maximumContextTokens')} required>
                  <Input
                    min={1000}
                    step={1000}
                    type="number"
                    value={String(selectedModel?.modelMaxContext ?? '')}
                    onChange={(_, data) => updateSelectedModel({ modelMaxContext: Number(data.value) })}
                  />
                </Field>
                <Field label={t('maximumOutputTokens')} hint={t('maximumOutputTokensHint')}>
                  <Input
                    min={1}
                    step={1000}
                    type="number"
                    value={selectedModel?.modelMaxOutputTokens === undefined ? '' : String(selectedModel.modelMaxOutputTokens)}
                    onChange={(_, data) => updateSelectedModel({
                      modelMaxOutputTokens: data.value === '' || !Number.isFinite(Number(data.value))
                        ? undefined
                        : Number(data.value),
                    })}
                  />
                </Field>
                <div className="multimodal-group">
                  <p className="section-label">{t('multimodalCapabilities')}</p>
                  <div className="multimodal-switches">
                    <Switch
                      checked={selectedModel?.supportsImageInput ?? false}
                      label={t('modalityImage')}
                      onChange={(_, data) => updateSelectedModel({ supportsImageInput: data.checked })}
                    />
                    <Switch
                      checked={selectedModel?.supportsPdfInput ?? false}
                      label={t('modalityPdf')}
                      onChange={(_, data) => updateSelectedModel({ supportsPdfInput: data.checked })}
                    />
                    <Switch
                      checked={selectedModel?.supportsVideoInput ?? false}
                      label={t('modalityVideo')}
                      onChange={(_, data) => updateSelectedModel({ supportsVideoInput: data.checked })}
                    />
                     <Switch
                       checked={selectedModel?.supportsAudioInput ?? false}
                       label={t('modalityAudio')}
                       onChange={(_, data) => updateSelectedModel({ supportsAudioInput: data.checked })}
                     />
                   </div>
                 </div>
              </section>
              )}
              {settingsTab === 'language' && (
              <section className="settings-group">
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
              )}
              {settingsTab === 'power' && (
               <section className="settings-group">
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
              )}
              {settingsTab === 'archive' && (
               <section className="settings-group">
                 <p className="settings-description">{t('archivedItemsDescription')}</p>
                 <Button appearance="secondary" onClick={openArchiveList}>
                   {t('openArchivedItems')}
                 </Button>
               </section>
              )}
              {settingsTab === 'developer' && (
               <section className="settings-group">
                 <Switch
                   checked={configDraft.developerMode}
                  label={t('developerMode')}
                  onChange={(_, data) => setConfigDraft((current) => ({
                    ...current,
                    developerMode: data.checked,
                  }))}
                />
                <p className="settings-description">{t('developerModeDescription')}</p>
                {configDraft.developerMode && (
                  <div className="command-review-global-group">
                    <h3>{t('globalCommandReview')}</h3>
                    <p className="settings-description">{t('globalCommandReviewDescription')}</p>
                    <CommandReviewEditor
                      value={configDraft.commandReviewGlobal}
                      modelConfigs={configDraft.modelConfigs}
                      onOpenSyntaxHelp={openCommandRulesHelp}
                      onChange={(next) => setConfigDraft((current) => ({ ...current, commandReviewGlobal: next }))}
                    />
                  </div>
                )}
                {configDraft.developerMode && (
                  <div className="shell-detection-group">
                    <h3>{t('environmentDetection')}</h3>
                    <Button appearance="secondary" disabled={shellDetectBusy} onClick={() => void runShellDetection()}>
                      {shellDetectBusy ? t('detectingShells') : t('runEnvironmentDetection')}
                    </Button>
                    {shellDetection && (
                      <div className="shell-detection-results">
                        {shellDetection.interpreters.map((entry) => (
                          <p key={entry.kind} className="shell-detection-item">
                            <span>{entry.available ? '✓' : '✗'} {interpreterLabels[entry.kind] ?? entry.kind}</span>
                            <span className="shell-detection-detail">{entry.detail}</span>
                          </p>
                        ))}
                        {shellDetection.environments.map((entry) => (
                          <p key={entry.kind} className="shell-detection-item">
                            <span>{entry.available ? '✓' : '✗'} {environmentLabels[entry.kind] ?? entry.kind}</span>
                            <span className="shell-detection-detail">{entry.detail}</span>
                          </p>
                        ))}
                        <Button appearance="subtle" size="small" onClick={() => void pickBashExecutable()}>
                          {t('pickBashExecutable')}
                        </Button>
                        <div className="wsl2-config-group">
                          <Button appearance="subtle" size="small" disabled={wsl2ConfigBusy} onClick={() => void openWsl2Config()}>
                            {t('configureWsl2')}
                          </Button>
                          {wsl2ConfigOpen && (
                            <div className="wsl2-config-form">
                              {wslDistros.length > 0 ? (
                                <Field label={t('wsl2Distro')}>
                                  <Select
                                    disabled={wsl2ConfigBusy}
                                    value={wsl2Draft.distro}
                                    onChange={(_, data) => setWsl2Draft((current) => ({ ...current, distro: data.value }))}
                                  >
                                    {wslDistros.map((distro) => (
                                      <option key={distro} value={distro}>{distro}</option>
                                    ))}
                                  </Select>
                                </Field>
                              ) : (
                                <p className="settings-warning" role="alert">{t('wsl2NoUserDistro')}</p>
                              )}
                              <Field label={t('wsl2SandboxUser')} hint={t('wsl2SandboxUserHint')}>
                                <Input
                                  disabled={wsl2ConfigBusy || wslDistros.length === 0}
                                  value={wsl2Draft.sandboxUser}
                                  onChange={(_, data) => setWsl2Draft((current) => ({ ...current, sandboxUser: data.value }))}
                                />
                              </Field>
                              <div className="wsl2-config-actions">
                                <Button appearance="secondary" size="small" disabled={wsl2ConfigBusy || wslDistros.length === 0 || !wsl2Draft.distro || !wsl2Draft.sandboxUser.trim()} onClick={() => void saveWsl2Config()}>
                                  {t('save')}
                                </Button>
                                <Button appearance="subtle" size="small" disabled={wsl2ConfigBusy} onClick={() => void clearWsl2Config()}>
                                  {t('wsl2ClearConfig')}
                                </Button>
                                <Button appearance="subtle" size="small" onClick={() => setWsl2ConfigOpen(false)}>
                                  {t('close')}
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                        {shellDetection.wsl2Sandbox && (
                          <div className="wsl2-sandbox-probe">
                            <p className="shell-detection-item">
                              <span>{shellDetection.wsl2Sandbox.bwrapAvailable ? '✓' : '✗'} bwrap</span>
                              <span className="shell-detection-detail">{shellDetection.wsl2Sandbox.bwrapAvailable ? t('wsl2BwrapOk') : t('wsl2BwrapMissing')}</span>
                            </p>
                            <p className="shell-detection-item">
                              <span>{shellDetection.wsl2Sandbox.socatAvailable ? '✓' : '✗'} socat</span>
                              <span className="shell-detection-detail">{shellDetection.wsl2Sandbox.socatAvailable ? t('wsl2SocatOk') : t('wsl2SocatMissing')}</span>
                            </p>
                            <p className="shell-detection-item">
                              <span>{shellDetection.wsl2Sandbox.interopEnabled ? '✗' : '✓'} interop</span>
                              <span className="shell-detection-detail">{shellDetection.wsl2Sandbox.interopEnabled ? t('wsl2InteropWarning') : t('wsl2InteropOk')}</span>
                            </p>
                            {shellDetection.wsl2Sandbox.interopEnabled && (
                              <p className="settings-warning" role="alert">{t('wsl2InteropHighRisk')}</p>
                            )}
                            {!shellDetection.wsl2Sandbox.socatAvailable && (
                              <p className="settings-warning" role="alert">{t('wsl2SocatHighRisk')}</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                   </div>
                 )}
                </section>
              )}
              {settingsTab === 'prompts' && (
                <section className="settings-group prompt-viewer-group">
                  <p className="settings-description">{t('promptsDescription')}</p>
                  {!promptSnapshot && <p className="settings-description">{t('loadingPrompts')}</p>}
                  {promptSnapshot?.entries.map((entry) => (
                    <div className="prompt-entry" key={entry.id}>
                      <h3>{entry.title}</h3>
                      <p className="settings-description">{entry.scene}</p>
                      <pre className="prompt-content">{entry.content}</pre>
                    </div>
                  ))}
                </section>
              )}
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

      <Dialog open={archiveDialogOpen} onOpenChange={(_, data) => setArchiveDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('archivedItems')}</DialogTitle>
            <DialogContent className="dialog-fields archive-list">
              <section>
                <h2>{t('archivedProjects')}</h2>
                {archivedProjects.length === 0 ? (
                  <p className="settings-description">{t('noArchivedProjects')}</p>
                ) : archivedProjects.map((project) => (
                  <div className="archive-list-item" key={project.id}>
                    <span>{project.name}</span>
                    <Button size="small" onClick={() => void setProjectArchive(project, false)}>
                      {t('unarchive')}
                    </Button>
                  </div>
                ))}
              </section>
              <section>
                <h2>{t('archivedConversations')}</h2>
                {archivedConversations.length === 0 ? (
                  <p className="settings-description">{t('noArchivedConversations')}</p>
                ) : archivedConversations.map(({ project, conversation }) => (
                  <div className="archive-list-item" key={`${project.id}:${conversation.id}`}>
                    <span>
                      <strong>{conversation.title}</strong>
                      <small>{project.name}</small>
                    </span>
                    <Button size="small" onClick={() => void setConversationArchive(project.id, conversation.id, false)}>
                      {t('unarchive')}
                    </Button>
                  </div>
                ))}
              </section>
              {archiveError && <p className="dialog-error">{archiveError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setArchiveDialogOpen(false)}>
                {t('close')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={bridgeDialogOpen} onOpenChange={(_, data) => setBridgeDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('handoverChannelTitle')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <Field label={t('bridgeAddress')} hint={t('bridgeAddressHint')}>
                <Input value={bridgeUrl} onChange={(_, data) => setBridgeUrl(data.value)} disabled={bridgeBusy} placeholder="http://127.0.0.1:8787" />
              </Field>
              <div className="bridge-actions">
                <Button appearance="primary" disabled={bridgeBusy || !bridgeUrl.trim()} onClick={() => void createBridgeChannel()}>
                  {bridgeBusy ? t('creatingHandoverChannel') : t('createHandoverChannel')}
                </Button>
                {bridgeChannels.length > 0 && <Button appearance="secondary" disabled={bridgeBusy} onClick={() => void syncBridgeNow()}>{t('syncAllHandoverChannels')}</Button>}
              </div>
              <p className="status">{t('handoverChannelDescription')}</p>
              {bridgeChannels.length === 0 ? <p className="status">{t('noHandoverChannels')}</p> : bridgeChannels.map((channel) => (
                <section className="bridge-channel" key={channel.channelId}>
                  <div className="bridge-channel-heading">
                    <div>
                      <strong>{t('handoverChannelLabel', { channelId: channel.channelId })}</strong>
                      <small>{t('handoverChannelExpiry', { url: channel.bridgeUrl, time: new Date(channel.enrollmentExpiresAt).toLocaleString() })}</small>
                    </div>
                    <Button size="small" appearance="secondary" disabled={bridgeBusy} onClick={() => void removeBridgeChannel(channel)}>{t('removeHandoverChannel')}</Button>
                  </div>
                  <Field label={t('handoverInvitation')} hint={t('handoverInvitationHint')}>
                    <Textarea className="bridge-invitation" readOnly value={channel.invitation} rows={4} />
                  </Field>
                  <div className="bridge-actions">
                    <Button appearance="secondary" disabled={bridgeBusy} onClick={() => void copyBridgeInvitation(channel)}>{t('copyHandoverInvitation')}</Button>
                    <Button appearance="secondary" disabled={bridgeBusy} onClick={() => void syncBridgeNow(channel.channelId)}>{t('syncHandoverNow')}</Button>
                    <Button appearance="secondary" disabled={bridgeBusy} onClick={() => void refreshBridgeEnrollment(channel.channelId)}>{t('refreshHandoverInvitation')}</Button>
                  </div>
                  <h3>{t('pendingHandoverDevices')}</h3>
                  <p className="status">{t('verifyHandoverFingerprint')}</p>
                  {channel.pendingRequests.length === 0 ? <p className="status">{t('noHandoverRequests')}</p> : channel.pendingRequests.map((request) => (
                    <div className="bridge-request" key={request.id}>
                      <span>{request.deviceName}<small>{t('deviceFingerprintLabel')}<code>{request.fingerprint}</code></small></span>
                      <Button size="small" appearance="primary" disabled={bridgeBusy} onClick={() => void approveBridgeRequest(channel.channelId, request)}>{t('approve')}</Button>
                      <Button size="small" appearance="secondary" disabled={bridgeBusy} onClick={() => void rejectBridgeRequest(channel.channelId, request.id)}>{t('reject')}</Button>
                    </div>
                  ))}
                  <p className="status">{t('approvedHandoverDevices', { count: channel.approvedDevices.length })}</p>
                </section>
              ))}
              {bridgeError && <p className="dialog-error">{bridgeError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setBridgeDialogOpen(false)}>{t('close')}</Button>
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

      <Dialog open={commandDialogOpen} onOpenChange={(_, data) => setCommandDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('commandAndReviewSettings')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <TabList
                selectedValue={commandSettingsScope}
                onTabSelect={(_, data) => switchCommandSettingsScope(data.value as 'conversation' | 'project')}
              >
                <Tab value="conversation">{t('commandScopeConversation')}</Tab>
                <Tab value="project">{t('commandScopeProject')}</Tab>
              </TabList>
              <TabList
                selectedValue={commandTab}
                onTabSelect={(_, data) => setCommandTab(data.value as typeof commandTab)}
              >
                <Tab value="execution">{t('commandTabExecution')}</Tab>
                <Tab value="review">{t('commandTabReview')}</Tab>
              </TabList>
              {commandTab === 'execution' && (
                <>
                  <Switch
                    checked={commandDraft !== null}
                    disabled={interactionLocked}
                    label={commandSettingsScope === 'conversation' ? t('commandOverrideProject') : t('commandOverrideDefault')}
                    onChange={(_, data) => setCommandDraft(data.checked
                      ? commandSettingsScope === 'conversation'
                        ? effectiveConversationCommandConfig()
                        : { ...defaultCommandExecutionConfig, review: structuredClone(config.commandReviewGlobal) }
                      : null)}
                  />
                  {commandDraft === null ? (
                    <p className="settings-description">
                      {commandSettingsScope === 'conversation' ? t('commandFollowingProject') : t('commandFollowingDefault')}
                    </p>
                  ) : (
                    <>
                      <Switch
                        checked={commandDraft.enabled}
                        disabled={interactionLocked}
                        label={t('commandExecutionEnabled')}
                        onChange={(_, data) => setCommandDraft((current) => current && { ...current, enabled: data.checked })}
                      />
                      <p className="settings-description">{t('commandExecutionDescription')}</p>
                      <Field label={t('commandInterpreter')}>
                        <Select
                          disabled={interactionLocked || !commandDraft.enabled}
                          value={commandDraft.interpreter}
                          onChange={(_, data) => setCommandDraft((current) => current && ({
                            ...current,
                            interpreter: data.value as CommandExecutionConfig['interpreter'],
                          }))}
                        >
                          <option value="bash">bash</option>
                          <option value="pwsh7">pwsh 7</option>
                          <option value="pwsh51">pwsh 5.1</option>
                        </Select>
                      </Field>
                      <Field label={t('commandEnvironment')}>
                        <Select
                          disabled={interactionLocked || !commandDraft.enabled}
                          value={commandDraft.environment}
                          onChange={(_, data) => setCommandDraft((current) => current && ({
                            ...current,
                            environment: data.value as CommandExecutionConfig['environment'],
                          }))}
                        >
                          <option value="bare">{t('commandEnvBare')}</option>
                          <option value="wsl2">wsl2</option>
                          <option value="docker">docker</option>
                          <option value="windows-sandbox">Windows Sandbox</option>
                        </Select>
                      </Field>
                      {!commandExecutionSupported(commandDraft.interpreter, commandDraft.environment) && (
                        <p className="settings-warning" role="alert">{t('commandComboUnsupported')}</p>
                      )}
                      {commandDraft.enabled && (
                        <div className="enabled-environments-group">
                          <p className="section-label">{t('enabledEnvironments')}</p>
                          <p className="settings-description">{t('enabledEnvironmentsHint')}</p>
                          {(['bash', 'pwsh7', 'pwsh51'] as const).map((interpreter) => (
                            <div className="enabled-environments-row" key={interpreter}>
                              <span className="enabled-environments-label">
                                {interpreterLabels[interpreter] ?? interpreter}
                              </span>
                              {(['bare', 'wsl2', 'docker'] as const).map((environment) => (
                                <label className="enabled-environments-check" key={environment}>
                                  <input
                                    type="checkbox"
                                    checked={commandDraft.enabledEnvironments[interpreter]?.includes(environment) ?? false}
                                    onChange={(event) => setCommandDraft((current) => {
                                      if (!current) return current
                                      const current2 = current.enabledEnvironments[interpreter] ?? []
                                      const next = event.target.checked
                                        ? [...current2, environment]
                                        : current2.filter((entry) => entry !== environment)
                                      return {
                                        ...current,
                                        enabledEnvironments: {
                                          ...current.enabledEnvironments,
                                          [interpreter]: next,
                                        },
                                      }
                                    })}
                                  />
                                  {environmentLabels[environment] ?? environment}
                                </label>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
              {commandTab === 'review' && (
                commandDraft === null ? (
                  <p className="settings-description">{t('reviewFollowingNote')}</p>
                ) : (
                  <>
                    <Switch
                      checked={commandDraft.review !== null}
                      disabled={interactionLocked}
                      label={t('reviewOverrideGlobal')}
                      onChange={(_, data) => setCommandDraft((current) => current && ({
                        ...current,
                        review: data.checked
                          ? structuredClone(current.review ?? config.commandReviewGlobal)
                          : null,
                      }))}
                    />
                    {commandDraft.review === null ? (
                      <p className="settings-description">{t('reviewFollowingGlobal')}</p>
                    ) : (
                      <CommandReviewEditor
                        value={commandDraft.review}
                        disabled={interactionLocked}
                        modelConfigs={config.modelConfigs}
                        sessionModel={effectiveModelConfig}
                        onOpenSyntaxHelp={openCommandRulesHelp}
                        onChange={(next) => setCommandDraft((current) => current && ({ ...current, review: next }))}
                      />
                    )}
                  </>
                )
              )}
              {settingsError && <p className="dialog-error">{settingsError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCommandDialogOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={interactionLocked || saving || !isValidCommandExecutionDraft(commandDraft)}
                onClick={() => void saveCommandExecutionSettings()}
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
                modelDisabled={interactionLocked}
                showCustomStrategy={config.developerMode && contextScope === 'conversation' && contextOverrideEnabled}
                modelConfigs={config.modelConfigs}
                activeModelConfigId={contextScope === 'conversation'
                  ? activeConversation?.modelConfigId ?? ''
                  : projects.find((project) => project.id === contextProjectId)?.defaultModelConfigId ?? ''}
                fallbackModelId={contextScope === 'conversation'
                  ? activeProject?.defaultModelConfigId ?? config.activeModelConfigId
                  : config.activeModelConfigId}
                emptyModelOptionLabel={t(contextScope === 'conversation' ? 'followProjectDefault' : 'applicationDefault')}
                onModelConfigChange={(modelConfigId) => void changeContextModelConfig(modelConfigId)}
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

      {toast && createPortal(
        <div className={`app-toast app-toast-${toast.tone}`} role="status">
          {toast.message}
        </div>,
        document.body,
      )}
    </FluentProvider>
  )
}
