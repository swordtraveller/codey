import {
  Button,
  FluentProvider,
  Input,
  webLightTheme,
} from '@fluentui/react-components'
import { useState, type FormEvent } from 'react'

type Message = {
  role: 'user' | 'system'
  content: string
}

export function App(): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')

  function startNewConversation(): void {
    setMessages([])
    setDraft('')
  }

  function sendMessage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()

    const content = draft.trim()
    if (!content) {
      return
    }

    setMessages((current) => [
      ...current,
      { role: 'user', content },
      { role: 'system', content: 'Received' },
    ])
    setDraft('')
  }

  return (
    <FluentProvider className="app" theme={webLightTheme}>
      <main className="shell">
        <aside className="sidebar">
          <div className="brand" aria-label="Codey">
            <span className="brand-mark">C</span>
            Codey
          </div>
          <Button appearance="primary" size="large" onClick={startNewConversation}>
            New conversation
          </Button>
        </aside>

        <section className="workspace">
          <header className="topbar">
            <span>Conversation</span>
            <span className="status">Ready</span>
          </header>

          <div className="conversation" aria-label="Conversation">
            {messages.length === 0 ? (
              <div className="empty-state">
                <span className="welcome-mark">C</span>
                <h1>How can I help?</h1>
                <p>Write a message to start a conversation.</p>
              </div>
            ) : (
              <div className="messages" aria-live="polite">
                {messages.map((message, index) => (
                  <div className={`message ${message.role}`} key={`${message.role}-${index}`}>
                    <p>{message.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <form className="composer" onSubmit={sendMessage}>
            <Input
              autoFocus
              aria-label="Message"
              className="message-input"
              size="large"
              value={draft}
              onChange={(_, data) => setDraft(data.value)}
              placeholder="Message Codey"
            />
            <Button appearance="primary" disabled={!draft.trim()} size="large" type="submit">
              Send
            </Button>
          </form>
        </section>
      </main>
    </FluentProvider>
  )
}
