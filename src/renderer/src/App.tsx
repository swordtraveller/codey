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
import { Component, Fragment, useEffect, useRef, useState, type ErrorInfo, type FormEvent, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { setAppLanguage } from './i18n'
import type {
  AgentLimitsConfig,
  AppLanguage,
  ContextCompressionNotice,
  ContextManagementConfig,
  ConversationRuntimeState,
  ConversationTurnRecord,
  DevelopmentTimelineItem,
} from '../../shared/types'
import {
  defaultAgentLimitsConfig,
  defaultAppConfig,
  defaultContextManagementConfig,
  defaultModelConfig,
  maximumAgentLimit,
  type ModelConfig,
  type Project,
} from '../../shared/types'

function formatToolParameters(parameters: string): string {
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

function AssistantContent({ content }: { content: string }): React.JSX.Element {
  const { t } = useTranslation()
  const fallback = <p>{content}</p>

  return (
    <div className="message-card">
      <div className="message-card-actions">
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
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
          </div>
        </MarkdownErrorBoundary>
      ) : (
        fallback
      )}
    </div>
  )
}
function ContextSettingsFields({
  value,
  disabled = false,
  onChange,
}: {
  value: ContextManagementConfig
  disabled?: boolean
  onChange: (patch: Partial<ContextManagementConfig>) => void
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="context-settings-fields">
      <Switch
        checked={value.layeredEnabled}
        disabled={disabled}
        label={t('layeredContext')}
        onChange={(_, data) => onChange({ layeredEnabled: data.checked })}
      />
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
      {value.layeredEnabled && (
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
    </div>
  )
}
export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState('')
  const [activeConversationId, setActiveConversationId] = useState('')
  const [draft, setDraft] = useState('')
  const [config, setConfig] = useState(defaultAppConfig)
  const [configDraft, setConfigDraft] = useState(defaultAppConfig)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [contextDialogOpen, setContextDialogOpen] = useState(false)
  const [contextScope, setContextScope] = useState<'project' | 'conversation'>('conversation')
  const [contextProjectId, setContextProjectId] = useState('')
  const [contextOverrideEnabled, setContextOverrideEnabled] = useState(false)
  const [contextDraft, setContextDraft] = useState(defaultContextManagementConfig)
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
  const [projectError, setProjectError] = useState('')
  const [liveResponses, setLiveResponses] = useState<Record<string, {
    projectId: string
    conversationId: string
    timeline: DevelopmentTimelineItem[]
  }>>({})
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const conversationRef = useRef<HTMLDivElement>(null)
  const activeConversationKeyRef = useRef('')

  const activeProject = projects.find((project) => project.id === activeProjectId)
  const activeConversation = activeProject?.conversations.find(
    (conversation) => conversation.id === activeConversationId,
  )
  const projectModelConfigId = activeProject?.defaultModelConfigId ?? config.activeModelConfigId
  const effectiveModelConfigId = activeConversation?.modelConfigId ?? projectModelConfigId
  const effectiveModelConfig = config.modelConfigs.find((model) => model.id === effectiveModelConfigId)
  const effectiveContextConfig = activeConversation?.contextConfigOverride ??
    activeProject?.contextConfigOverride ?? config.contextManagement
  const configured = Boolean(effectiveModelConfig?.baseUrl && effectiveModelConfig.apiKey && effectiveModelConfig.modelName)
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
  const liveTimeline = activeConversationKey
    ? liveResponses[activeConversationKey]?.timeline ?? []
    : []
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

  useEffect(() => window.codey.onDevelopmentProgress((progress) => {
    const key = `${progress.projectId}:${progress.conversationId}`
    setLiveResponses((current) => ({ ...current, [key]: progress }))
  }), [])

  useEffect(() => window.codey.onConversationStateChange((change) => {
    setConversationStates((current) => ({
      ...current,
      [`${change.projectId}:${change.conversationId}`]: change.state,
    }))
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

  function updateScrollButton(): void {
    const element = conversationRef.current
    if (element) {
      setShowScrollToBottom(element.scrollHeight - element.scrollTop - element.clientHeight > 24)
    }
  }

  function scrollToBottom(): void {
    setShowScrollToBottom(false)
    conversationRef.current?.scrollTo({
      top: conversationRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }

  useEffect(updateScrollButton, [activeConversation?.messages, liveTimeline, interactionLocked])

  function replaceProject(updated: Project): void {
    setProjects((current) => current.map((project) =>
      project.id === updated.id ? updated : project,
    ))
  }

  function selectProject(project: Project): void {
    setActiveProjectId(project.id)
    setActiveConversationId(project.conversations[0]?.id ?? '')
    setOpenProjectMenuId(null)
    setDraft('')
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
      setDraft('')
      setError('')
    } catch {
      setError(t('unableCreateConversation'))
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    const content = draft.trim()
    if (!content || !canSend || !activeProject || !activeConversation || interactionLocked) {
      return
    }

    const projectId = activeProject.id
    const conversationId = activeConversation.id
    const conversationKey = `${projectId}:${conversationId}`
    setDraft('')
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
                { id: userMessageId, role: 'user', content },
              ],
            }
          : conversation,
      ),
    }
    replaceProject(optimisticProject)
    setLiveResponses((current) => ({
      ...current,
      [conversationKey]: {
        projectId,
        conversationId,
        timeline: [],
      },
    }))
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
      const result = await window.codey.develop(projectId, conversationId, content)
      if (result.project) {
        const updatedConversation = result.project.conversations.find(
          (conversation) => conversation.id === conversationId,
        )
        const updatedUserMessage = [...(updatedConversation?.messages ?? [])]
          .reverse()
          .find((message) => message.role === 'user' && message.content === content)
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
      setLiveResponses((current) => {
        if (!current[conversationKey]) return current
        const next = { ...current }
        delete next[conversationKey]
        return next
      })
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
          <div className="brand" aria-label="Codey">
            <span className="brand-mark">C</span>
            Codey
          </div>

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
                      setDraft('')
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
        </aside>

        <section className="workspace">
          <header className="topbar">
            <div>
              <strong>{activeProject?.name ?? 'Codey'}</strong>
              {activeConversation && <span>{activeConversation.title}</span>}
            </div>
            <div className="model-status">
              {activeConversation && config.modelConfigs.length > 0 ? (
                <label className="conversation-model-picker">
                  <span>
                    {configured ? effectiveModelConfig?.modelName : t('notConfigured')}
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
                </label>
              ) : (
                <span className="status">{t('notConfigured')}</span>
              )}
              {activeConversation && (
                <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => openContextSettings('conversation')}>
                  {t('contextSettings')}{effectiveContextConfig.layeredEnabled ? ' · Hot/Warm/Cold' : ''}
                </Button>
              )}
              {activeConversation && (
                <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={openAgentLimitsSettings}>
                  {t('agentLimits')}
                </Button>
              )}
              {context && contextStatus && (
                <span
                  className="context-status"
                  title={t('peakInputTitle', { original: context.originalTokens, compressed: context.compressedTokens })}
                >
                  {contextStatus}
                </span>
              )}
              {config.developerMode && activeProject && activeConversation && (
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
              onScroll={updateScrollButton}
            >
            {!activeConversation || (activeConversation.messages.length === 0 && !interactionLocked) ? (
              <div className="empty-state">
                <span className="welcome-mark">C</span>
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
                {activeConversation.messages.map((message) => {
                  const messageTurn = message.turn ?? (
                    conversationTurn && conversationTurn.userMessageId === message.id
                      ? conversationTurn
                      : undefined
                  )

                  return (
                    <Fragment key={message.id}>
                      <div className={`message ${message.role}`}>
                        {message.compression ? (
                          <CompressionMessage compression={message.compression} />
                        ) : message.role === 'assistant' && message.blocks?.length ? (
                          message.blocks.map((block, index) =>
                            block.type === 'content' ? (
                              <AssistantContent content={block.content} key={`${message.id}-${index}`} />
                            ) : (
                              <details className="function-call" key={block.id}>
                                <summary>{block.name}</summary>
                                <pre>{formatToolParameters(block.parameters)}</pre>
                              </details>
                            ),
                          )
                        ) : message.role === 'assistant' ? (
                          <AssistantContent content={message.content} />
                        ) : (
                          <p>{message.content}</p>
                        )}
                      </div>
                      {messageTurn && <ConversationStopwatch turn={messageTurn} />}
                    </Fragment>
                  )
                })}
                {liveTimeline.length > 0 && (
                  <div className="message assistant live-response">
                    {liveTimeline.map((item, index) =>
                      item.type === 'compression' ? (
                        <CompressionMessage
                          compression={item.compression}
                          key={`live-compression-${index}`}
                        />
                      ) : item.block.type === 'content' ? (
                        <AssistantContent content={item.block.content} key={`live-block-${index}`} />
                      ) : (
                        <details className="function-call" key={item.block.id || `live-block-${index}`}>
                          <summary>{item.block.name}</summary>
                          <pre>{formatToolParameters(item.block.parameters)}</pre>
                        </details>
                      ),
                    )}
                  </div>
                )}
              </div>
            )}
              {error && <p className="error" role="alert">{error}</p>}
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

          <form className="composer" onSubmit={sendMessage}>
            <Textarea
              aria-label={t('developmentRequest')}
              className="message-input"
              disabled={!canSend || interactionLocked}
              size="large"
              value={draft}
              onChange={(_, data) => setDraft(data.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder={
                !configured
                  ? t('configureModel')
                  : !activeProject?.folders.length
                    ? t('addFolderFirst')
                    : t('describeTask')
              }
            />
            {conversationWorking ? (
              <Button
                appearance="primary"
                disabled={stopping || !activeProject || !activeConversation}
                onClick={() => void stopMessage()}
                size="large"
                type="button"
              >
                {t('stop')}
              </Button>
            ) : (
              <Button
                appearance="primary"
                disabled={!canSend || !draft.trim() || interactionLocked}
                size="large"
                type="submit"
              >
                {t('send')}
              </Button>
            )}
          </form>
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
