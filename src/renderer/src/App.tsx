import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  FluentProvider,
  Input,
  Textarea,
  webLightTheme,
} from '@fluentui/react-components'
import { Component, Fragment, useEffect, useRef, useState, type ErrorInfo, type FormEvent, type ReactNode } from 'react'
import Markdown from 'react-markdown'
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
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s)|\*\*[^*]+\*\*|`[^`]+`|\[[^]]+\]\([^)]+\)/.test(content)
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

function formatTurnDuration(durationMs: number): string {
  const totalMinutes = Math.floor(Math.max(0, durationMs) / 60000)
  return `${Math.floor(totalMinutes / 60)} 时 ${totalMinutes % 60} 分`
}

function ConversationStopwatch({ turn }: { turn: ConversationTurn }): React.JSX.Element {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (turn.result !== 'processing') {
      return
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [turn.result])

  const duration = formatTurnDuration((turn.endedAt ?? now) - turn.startedAt)
  const result = turn.result === 'processing'
    ? ''
    : turn.result === 'normal'
      ? '正常结束'
      : turn.result === 'timeout'
        ? '超时未响应'
        : `其他 ${turn.error ?? '未知'} 异常`

  return (
    <p className="turn-stopwatch">
      {turn.result === 'processing' ? `正在处理中 ${duration}...` : `已结束处理 ${duration}：${result}`}
    </p>
  )
}
function AssistantContent({ content }: { content: string }): React.JSX.Element {
  const fallback = <p>{content}</p>

  return (
    <div className="message-card">
      <div className="message-card-actions">
        <Button
          aria-label="Copy message"
          appearance="subtle"
          size="small"
          title="Copy message"
          onClick={() => copyText(content)}
        >
          Copy
        </Button>
      </div>
      {looksLikeMarkdown(content) ? (
        <MarkdownErrorBoundary fallback={fallback}>
          <div className="markdown-content">
            <Markdown>{content}</Markdown>
          </div>
        </MarkdownErrorBoundary>
      ) : (
        fallback
      )}
    </div>
  )
}
export function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState('')
  const [activeConversationId, setActiveConversationId] = useState('')
  const [draft, setDraft] = useState('')
  const [config, setConfig] = useState(emptyConfig)
  const [configDraft, setConfigDraft] = useState(emptyConfig)
  const [settingsOpen, setSettingsOpen] = useState(false)
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
      })
      .catch(() => setError('Unable to load model configuration'))

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
      .catch(() => setError('Unable to load projects'))
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
    setSettingsError('')
    setSettingsOpen(true)
  }

  async function saveSettings(): Promise<void> {
    setSaving(true)
    setSettingsError('')

    try {
      const saved = await window.codey.saveConfig(configDraft)
      setConfig(saved)
      setConfigDraft(saved)
      setError('')
      setSettingsOpen(false)
    } catch {
      setSettingsError('Enter valid model and context settings')
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
      setProjectError('Enter a project name')
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
      setError('Unable to add the project folder')
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
      setError('Unable to create a conversation')
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
          ? ` (${result.writtenFiles.length} file(s) written)`
          : ''
        setError(`${result.error}${files}`)
      }
    } catch {
      setConversationTurn((current) => current ? {
        ...current,
        endedAt: Date.now(),
        result: 'other',
        error: '请求失败',
      } : current)
      setError('Unable to process the development request')
    } finally {
      setSending(false)
    }
  }

  const emptyTitle = !activeProject
    ? 'Create a project'
    : activeProject.folders.length === 0
      ? 'Add a project folder'
      : 'What should I build?'
  const emptyDescription = !activeProject
    ? 'Projects group folders and conversations.'
    : activeProject.folders.length === 0
      ? 'Codey only writes files inside folders you select.'
      : 'Describe a development task to start this conversation.'

  return (
    <FluentProvider className="app" theme={webLightTheme}>
      <main className="shell">
        <aside className="sidebar">
          <div className="brand" aria-label="Codey">
            <span className="brand-mark">C</span>
            Codey
          </div>

          <Button appearance="primary" disabled={sending} onClick={openProjectDialog}>
            New project
          </Button>

          <section className="sidebar-section">
            <p className="section-label">Projects</p>
            <nav className="nav-list" aria-label="Projects">
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
                <p className="section-label">Conversations</p>
                <Button
                  appearance="subtle"
                  disabled={sending}
                  size="small"
                  onClick={() => void startNewConversation()}
                >
                  New
                </Button>
              </div>
              <nav className="nav-list" aria-label="Conversations">
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
            Model settings
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
                {configured ? config.modelName : 'Not configured'}
              </span>
              {context && contextStatus && (
                <span
                  className="context-status"
                  title={`Peak input ${context.originalTokens} tokens; current input ${context.compressedTokens} tokens`}
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
                  <span>No folders selected</span>
                ) : (
                  activeProject.folders.map((folder) => (
                    <span className="folder" key={folder.id} title={folder.path}>
                      {folder.path}
                    </span>
                  ))
                )}
              </div>
              <Button disabled={sending} size="small" onClick={() => void addFolder()}>
                Add folder
              </Button>
            </div>
          )}

          <div className="conversation-container">
            <div
              ref={conversationRef}
              className="conversation"
              aria-label="Conversation"
              onScroll={updateScrollButton}
            >
            {!activeConversation || (activeConversation.messages.length === 0 && !sending) ? (
              <div className="empty-state">
                <span className="welcome-mark">C</span>
                <h1>{emptyTitle}</h1>
                <p>{emptyDescription}</p>
                {!activeProject && (
                  <Button appearance="primary" onClick={openProjectDialog}>
                    New project
                  </Button>
                )}
                {activeProject && activeProject.folders.length === 0 && (
                  <Button appearance="primary" onClick={() => void addFolder()}>
                    Add folder
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
                            Context compressed: {message.compression.originalTokens.toLocaleString()} to{' '}
                            {message.compression.compressedTokens.toLocaleString()} tokens ({message.compression.compressionRatio.toFixed(2)}x)
                          </p>
                          <p>Method: {message.compression.method}</p>
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
                {sending && <p className="pending">Working…</p>}
              </div>
            )}
              {error && <p className="error" role="alert">{error}</p>}
            </div>
            {showScrollToBottom && (
              <Button
                aria-label="Scroll to bottom"
                className="scroll-to-bottom"
                appearance="secondary"
                shape="circular"
                onClick={scrollToBottom}
                title="Scroll to bottom"
              >
                ↓
              </Button>
            )}
          </div>

          <form className="composer" onSubmit={sendMessage}>
            <Textarea
              aria-label="Development request"
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
                  ? 'Configure a model first'
                  : !activeProject?.folders.length
                    ? 'Add a project folder first'
                    : 'Describe a development task'
              }
            />
            <Button
              appearance="primary"
              disabled={!canSend || !draft.trim() || sending}
              size="large"
              type="submit"
            >
              Send
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
            <DialogTitle>New project</DialogTitle>
            <DialogContent className="dialog-fields">
              <Field label="Project name" required>
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
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={!projectName.trim() || creatingProject}
                onClick={() => void createNewProject()}
              >
                {creatingProject ? 'Creating…' : 'Create'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={(_, data) => setSettingsOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Model settings</DialogTitle>
            <DialogContent className="dialog-fields">
              <Field label="Base URL" required>
                <Input
                  value={configDraft.baseUrl}
                  onChange={(_, data) => setConfigDraft({ ...configDraft, baseUrl: data.value })}
                  placeholder="https://api.example.com/v1"
                />
              </Field>
              <Field label="API key" required>
                <Input
                  type="password"
                  value={configDraft.apiKey}
                  onChange={(_, data) => setConfigDraft({ ...configDraft, apiKey: data.value })}
                />
              </Field>
              <Field label="Model name" required>
                <Input
                  value={configDraft.modelName}
                  onChange={(_, data) => setConfigDraft({ ...configDraft, modelName: data.value })}
                  placeholder="model-name"
                />
              </Field>
              <Field label="Maximum context tokens" required>
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
              <Field label="Output token margin" required>
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
              <Field label="Recent rounds to keep" required>
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
              {settingsError && <p className="dialog-error">{settingsError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setSettingsOpen(false)}>
                Cancel
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
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </FluentProvider>
  )
}
