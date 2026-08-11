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
  webLightTheme,
} from '@fluentui/react-components'
import { useEffect, useState, type FormEvent } from 'react'
import type { ModelConfig, Project } from '../../shared/types'

const emptyConfig: ModelConfig = { baseUrl: '', apiKey: '', modelName: '' }

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
  const [saving, setSaving] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [error, setError] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [projectError, setProjectError] = useState('')

  const activeProject = projects.find((project) => project.id === activeProjectId)
  const activeConversation = activeProject?.conversations.find(
    (conversation) => conversation.id === activeConversationId,
  )
  const configured = Boolean(config.baseUrl && config.apiKey && config.modelName)
  const canSend = Boolean(configured && activeConversation)

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

  function replaceProject(updated: Project): void {
    setProjects((current) => current.map((project) =>
      project.id === updated.id ? updated : project,
    ))
  }

  function selectProject(project: Project): void {
    setActiveProjectId(project.id)
    setActiveConversationId(project.conversations[0]?.id ?? '')
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
      setSettingsError('Enter a valid base URL, API key, and model name')
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
    const optimisticProject: Project = {
      ...activeProject,
      conversations: activeProject.conversations.map((conversation) =>
        conversation.id === activeConversation.id
          ? {
              ...conversation,
              messages: [
                ...conversation.messages,
                { id: crypto.randomUUID(), role: 'user', content },
              ],
            }
          : conversation,
      ),
    }
    replaceProject(optimisticProject)
    setSending(true)

    try {
      const result = await window.codey.chat(
        activeProject.id,
        activeConversation.id,
        content,
      )
      if (result.project) {
        replaceProject(result.project)
      }
      if (result.error) {
        setError(result.error)
      }
    } catch {
      setError('Unable to send the message')
    } finally {
      setSending(false)
    }
  }

  const emptyTitle = activeProject ? 'How can I help?' : 'Create a project'
  const emptyDescription = activeProject
    ? 'Write a message to start this conversation.'
    : 'Projects group folders and conversations.'

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
            <span className="status">
              {configured ? config.modelName : 'Not configured'}
            </span>
          </header>

          {activeProject && (
            <div className="folderbar">
              <div className="folder-list">
                {activeProject.folders.length === 0 ? (
                  <span>No folders selected</span>
                ) : (
                  activeProject.folders.map((folder) => (
                    <span className="folder" key={folder} title={folder}>
                      {folder}
                    </span>
                  ))
                )}
              </div>
              <Button disabled={sending} size="small" onClick={() => void addFolder()}>
                Add folder
              </Button>
            </div>
          )}

          <div className="conversation" aria-label="Conversation">
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
              </div>
            ) : (
              <div className="messages" aria-live="polite">
                {activeConversation.messages.map((message) => (
                  <div className={`message ${message.role}`} key={message.id}>
                    <p>{message.content}</p>
                  </div>
                ))}
                {sending && <p className="pending">Working…</p>}
              </div>
            )}
            {error && <p className="error" role="alert">{error}</p>}
          </div>

          <form className="composer" onSubmit={sendMessage}>
            <Input
              aria-label="Message"
              className="message-input"
              disabled={!canSend || sending}
              size="large"
              value={draft}
              onChange={(_, data) => setDraft(data.value)}
              placeholder={configured ? 'Message Codey' : 'Configure a model first'}
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

