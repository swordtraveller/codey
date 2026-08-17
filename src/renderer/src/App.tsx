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
import type { AppLanguage } from '../../shared/types'
import { defaultModelConfig, type AssistantMessageBlock, type Project } from '../../shared/types'

const emptyConfig = defaultModelConfig

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

type TurnResult = 'processing' | 'normal' | 'timeout' | 'other'

type ConversationTurn = {
  projectId: string
  conversationId: string
  userMessageId: string
  startedAt: number
  endedAt?: number
  result: TurnResult
  error?: string
}

function ConversationStopwatch({ turn }: { turn: ConversationTurn }): React.JSX.Element {
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
export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState('')
  const [activeConversationId, setActiveConversationId] = useState('')
  const [draft, setDraft] = useState('')
  const [config, setConfig] = useState(emptyConfig)
  const [configDraft, setConfigDraft] = useState(emptyConfig)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [languageDraft, setLanguageDraft] = useState<AppLanguage>('system')
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [sending, setSending] = useState(false)
  const [conversationTurn, setConversationTurn] = useState<ConversationTurn | null>(null)
  const [saving, setSaving] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [error, setError] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [projectError, setProjectError] = useState('')
  const [liveResponse, setLiveResponse] = useState<{
    projectId: string
    conversationId: string
    blocks: AssistantMessageBlock[]
  } | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const conversationRef = useRef<HTMLDivElement>(null)

  const activeProject = projects.find((project) => project.id === activeProjectId)
  const activeConversation = activeProject?.conversations.find(
    (conversation) => conversation.id === activeConversationId,
  )
  const configured = Boolean(config.baseUrl && config.apiKey && config.modelName)
  const context = activeConversation?.context
  const contextStatus = context
    ? `${Math.round((context.compressedTokens / context.modelMaxContext) * 100)}% context / ${Math.round((context.compressedTokens / context.triggerThreshold) * 100)}% input`
    : ''
  const canSend = Boolean(configured && activeProject?.folders.length && activeConversation)
  const liveBlocks =
    liveResponse?.projectId === activeProjectId &&
    liveResponse.conversationId === activeConversationId
      ? liveResponse.blocks
      : []

  useEffect(() => {
    void window.codey
      .getConfig()
      .then((saved) => {
        setConfig(saved)
        setConfigDraft(saved)
        setLanguageDraft(saved.language)
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
    setLiveResponse(progress)
  }), [])

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

  useEffect(updateScrollButton, [activeConversation?.messages, liveResponse, sending])

  function replaceProject(updated: Project): void {
    setProjects((current) => current.map((project) =>
      project.id === updated.id ? updated : project,
    ))
  }

  function selectProject(project: Project): void {
    setActiveProjectId(project.id)
    setActiveConversationId(project.conversations[0]?.id ?? '')
    setConversationTurn(null)
    setDraft('')
    setError('')
  }

  function openSettings(): void {
    setConfigDraft(config)
    setLanguageDraft(config.language)
    setSettingsError('')
    setSettingsOpen(true)
  }

  async function saveSettings(): Promise<void> {
    setSaving(true)
    setSettingsError('')

    try {
      const saved = await window.codey.saveConfig({ ...configDraft, language: languageDraft })
      setConfig(saved)
      setConfigDraft(saved)
      setLanguageDraft(saved.language)
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
      setConversationTurn(null)
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

  async function startNewConversation(): Promise<void> {
    if (!activeProject) {
      return
    }

    try {
      const updated = await window.codey.createConversation(activeProject.id)
      replaceProject(updated)
      setActiveConversationId(updated.conversations.at(-1)?.id ?? '')
      setConversationTurn(null)
      setDraft('')
      setError('')
    } catch {
      setError(t('unableCreateConversation'))
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    const content = draft.trim()
    if (!content || !canSend || !activeProject || !activeConversation || sending) {
      return
    }

    setDraft('')
    setError('')
    const userMessageId = crypto.randomUUID()
    const optimisticProject: Project = {
      ...activeProject,
      conversations: activeProject.conversations.map((conversation) =>
        conversation.id === activeConversation.id
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
    setLiveResponse({
      projectId: activeProject.id,
      conversationId: activeConversation.id,
      blocks: [],
    })
    setConversationTurn({
      projectId: activeProject.id,
      conversationId: activeConversation.id,
      userMessageId,
      startedAt: Date.now(),
      result: 'processing',
    })
    setSending(true)

    try {
      const result = await window.codey.develop(
        activeProject.id,
        activeConversation.id,
        content,
      )
      if (result.project) {
        const updatedConversation = result.project.conversations.find(
          (conversation) => conversation.id === activeConversation.id,
        )
        const updatedUserMessage = [...(updatedConversation?.messages ?? [])]
          .reverse()
          .find((message) => message.role === 'user' && message.content === content)
        setConversationTurn((current) => current ? {
          ...current,
          userMessageId: updatedUserMessage?.id ?? current.userMessageId,
        } : current)
        replaceProject(result.project)
        setLiveResponse(null)
      }
      setConversationTurn((current) => current ? {
        ...current,
        endedAt: Date.now(),
        result: result.error
          ? /timed out/i.test(result.error) ? 'timeout' : 'other'
          : 'normal',
        error: result.error,
      } : current)
      if (result.error) {
        const files = result.writtenFiles.length
          ? t('filesWritten', { count: result.writtenFiles.length })
          : ''
        setError(`${result.error}${files}`)
      }
    } catch {
      setConversationTurn((current) => current ? {
        ...current,
        endedAt: Date.now(),
        result: 'other',
        error: t('requestFailed'),
      } : current)
      setError(t('unableProcessRequest'))
    } finally {
      setSending(false)
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

  return (
    <FluentProvider className="app" theme={webLightTheme}>
      <main className="shell">
        <aside className="sidebar">
          <div className="brand" aria-label="Codey">
            <span className="brand-mark">C</span>
            Codey
          </div>

          <Button appearance="primary" disabled={sending} onClick={openProjectDialog}>
            {t('newProject')}
          </Button>

          <section className="sidebar-section">
            <p className="section-label">{t('projects')}</p>
            <nav className="nav-list" aria-label={t('projects')}>
              {projects.map((project) => (
                <Button
                  appearance={project.id === activeProjectId ? 'secondary' : 'subtle'}
                  disabled={sending}
                  key={project.id}
                  onClick={() => selectProject(project)}
                >
                  {project.name}
                </Button>
              ))}
            </nav>
          </section>

          {activeProject && (
            <section className="sidebar-section conversations-section">
              <div className="section-heading">
                <p className="section-label">{t('conversations')}</p>
                <Button
                  appearance="subtle"
                  disabled={sending}
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
                    disabled={sending}
                    key={conversation.id}
                    onClick={() => {
                      setActiveConversationId(conversation.id)
                      setConversationTurn(null)
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
              <span className="status">
                {configured ? config.modelName : t('notConfigured')}
              </span>
              {context && contextStatus && (
                <span
                  className="context-status"
                  title={t('peakInputTitle', { original: context.originalTokens, compressed: context.compressedTokens })}
                >
                  {contextStatus}
                </span>
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
              <Button disabled={sending} size="small" onClick={() => void addFolder()}>
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
            {!activeConversation || (activeConversation.messages.length === 0 && !sending) ? (
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
                {activeConversation.messages.map((message) => (
                  <Fragment key={message.id}>
                    <div className={`message ${message.role}`}>
                      {message.compression ? (
                        <div className="compression-message">
                          <p>
                            {t('contextCompressed', {
                              original: message.compression.originalTokens.toLocaleString(),
                              compressed: message.compression.compressedTokens.toLocaleString(),
                              ratio: message.compression.compressionRatio.toFixed(2),
                            })}
                          </p>
                          <p>{t('method', { method: message.compression.method })}</p>
                        </div>
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
                    {conversationTurn && conversationTurn.userMessageId === message.id && (
                      <ConversationStopwatch turn={conversationTurn} />
                    )}
                  </Fragment>
                ))}
                {liveBlocks.length > 0 && (
                  <div className="message assistant live-response">
                    {liveBlocks.map((block, index) =>
                      block.type === 'content' ? (
                        <AssistantContent content={block.content} key={`live-${index}`} />
                      ) : (
                        <details className="function-call" key={block.id}>
                          <summary>{block.name}</summary>
                          <pre>{formatToolParameters(block.parameters)}</pre>
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
              disabled={!canSend || sending}
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
            <Button
              appearance="primary"
              disabled={!canSend || !draft.trim() || sending}
              size="large"
              type="submit"
            >
              {t('send')}
            </Button>
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
                <Field label={t('baseUrl')} required>
                  <Input
                    value={configDraft.baseUrl}
                    onChange={(_, data) => setConfigDraft({ ...configDraft, baseUrl: data.value })}
                    placeholder="https://api.example.com/v1"
                  />
                </Field>
                <Field label={t('apiKey')} required>
                  <Input
                    type="password"
                    value={configDraft.apiKey}
                    onChange={(_, data) => setConfigDraft({ ...configDraft, apiKey: data.value })}
                  />
                </Field>
                <Field label={t('modelName')} required>
                  <Input
                    value={configDraft.modelName}
                    onChange={(_, data) => setConfigDraft({ ...configDraft, modelName: data.value })}
                    placeholder="model-name"
                  />
                </Field>
                <Field label={t('maximumContextTokens')} required>
                  <Input
                    min={1000}
                    step={1000}
                    type="number"
                    value={String(configDraft.modelMaxContext)}
                    onChange={(_, data) => setConfigDraft({
                      ...configDraft,
                      modelMaxContext: Number(data.value),
                    })}
                  />
                </Field>
                <Field label={t('outputTokenMargin')} required>
                  <Input
                    min={1}
                    step={1000}
                    type="number"
                    value={String(configDraft.safeOutputMargin)}
                    onChange={(_, data) => setConfigDraft({
                      ...configDraft,
                      safeOutputMargin: Number(data.value),
                    })}
                  />
                </Field>
                <Field label={t('recentRounds')} required>
                  <Input
                    max={20}
                    min={1}
                    type="number"
                    value={String(configDraft.recentKeepRounds)}
                    onChange={(_, data) => setConfigDraft({
                      ...configDraft,
                      recentKeepRounds: Number(data.value),
                    })}
                  />
                </Field>
              </section>
              <section className="settings-group">
                <h2>{t('languageSettings')}</h2>
                <Field label={t('language')}>
                  <Select
                    value={languageDraft}
                    onChange={(_, data) => setLanguageDraft(data.value as AppLanguage)}
                  >
                    <option value="system">{t('followSystem')}</option>
                    <option value="en">{t('english')}</option>
                    <option value="zh-CN">{t('simplifiedChinese')}</option>
                  </Select>
                </Field>
              </section>
              {settingsError && <p className="dialog-error">{settingsError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setSettingsOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={
                  !configDraft.baseUrl.trim() ||
                  !configDraft.apiKey.trim() ||
                  !configDraft.modelName.trim() ||
                  configDraft.modelMaxContext < 1_000 ||
                  configDraft.safeOutputMargin < 1 ||
                  configDraft.safeOutputMargin >= configDraft.modelMaxContext ||
                  configDraft.recentKeepRounds < 1 ||
                  configDraft.recentKeepRounds > 20 ||
                  saving
                }
                onClick={() => void saveSettings()}
              >
                {saving ? t('saving') : t('save')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </FluentProvider>
  )
}
