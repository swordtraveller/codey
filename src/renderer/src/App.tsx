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

type ModelConfig = {
  baseUrl: string
  apiKey: string
  modelName: string
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

const emptyConfig: ModelConfig = { baseUrl: '', apiKey: '', modelName: '' }

export function App(): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [config, setConfig] = useState(emptyConfig)
  const [configDraft, setConfigDraft] = useState(emptyConfig)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const configured = Boolean(config.baseUrl && config.apiKey && config.modelName)

  useEffect(() => {
    void window.codey
      .getConfig()
      .then((saved) => {
        setConfig(saved)
        setConfigDraft(saved)
      })
      .catch(() => setError('Unable to load model configuration'))
  }, [])

  function startNewConversation(): void {
    setMessages([])
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

  async function sendMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    const content = draft.trim()
    if (!content || !configured || sending) {
      return
    }

    const nextMessages = [...messages, { role: 'user' as const, content }]
    setMessages(nextMessages)
    setDraft('')
    setError('')
    setSending(true)

    try {
      const result = await window.codey.chat(nextMessages)
      if (result.reply) {
        setMessages([...nextMessages, { role: 'assistant', content: result.reply }])
      } else {
        setError(result.error || 'Request failed')
      }
    } catch {
      setError('Unable to reach the model')
    } finally {
      setSending(false)
    }
  }

  return (
    <FluentProvider className="app" theme={webLightTheme}>
      <main className="shell">
        <aside className="sidebar">
          <div className="brand" aria-label="Codey">
            <span className="brand-mark">C</span>
            Codey
          </div>
          <Button appearance="primary" disabled={sending} onClick={startNewConversation}>
            New conversation
          </Button>
          <Button className="settings-button" appearance="subtle" onClick={openSettings}>
            Settings
          </Button>
        </aside>

        <section className="workspace">
          <header className="topbar">
            <span>Conversation</span>
            <span className="status">
              {configured ? config.modelName : 'Not configured'}
            </span>
          </header>

          <div className="conversation" aria-label="Conversation">
            {messages.length === 0 ? (
              <div className="empty-state">
                <span className="welcome-mark">C</span>
                <h1>{configured ? 'How can I help?' : 'Configure a model'}</h1>
                <p>
                  {configured
                    ? 'Write a message to start a conversation.'
                    : 'Add an OpenAI-compatible endpoint to begin.'}
                </p>
                {!configured && (
                  <Button appearance="primary" onClick={openSettings}>
                    Open settings
                  </Button>
                )}
              </div>
            ) : (
              <div className="messages" aria-live="polite">
                {messages.map((message, index) => (
                  <div className={`message ${message.role}`} key={`${message.role}-${index}`}>
                    <p>{message.content}</p>
                  </div>
                ))}
                {sending && <p className="pending">Thinking…</p>}
              </div>
            )}
            {error && <p className="error" role="alert">{error}</p>}
          </div>

          <form className="composer" onSubmit={sendMessage}>
            <Input
              autoFocus
              aria-label="Message"
              className="message-input"
              disabled={!configured || sending}
              size="large"
              value={draft}
              onChange={(_, data) => setDraft(data.value)}
              placeholder={configured ? 'Message Codey' : 'Configure a model first'}
            />
            <Button
              appearance="primary"
              disabled={!configured || !draft.trim() || sending}
              size="large"
              type="submit"
            >
              Send
            </Button>
          </form>
        </section>
      </main>

      <Dialog open={settingsOpen} onOpenChange={(_, data) => setSettingsOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Model settings</DialogTitle>
            <DialogContent className="settings-fields">
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
              {settingsError && (
                <p className="settings-error" role="alert">
                  {settingsError}
                </p>
              )}
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
