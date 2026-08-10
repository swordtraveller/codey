import { FormEvent, useState } from 'react'

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
    <main className="shell">
      <header className="topbar">
        <div className="brand" aria-label="Codey">
          Codey
        </div>
        <button className="new-conversation" type="button" onClick={startNewConversation}>
          New conversation
        </button>
      </header>

      <section className="conversation" aria-label="Conversation">
        {messages.length === 0 ? (
          <div className="empty-state">
            <p className="eyebrow">Desktop workspace</p>
            <h1>Start a conversation.</h1>
          </div>
        ) : (
          <div className="messages" aria-live="polite">
            {messages.map((message, index) => (
              <p className={`message ${message.role}`} key={`${message.role}-${index}`}>
                {message.content}
              </p>
            ))}
          </div>
        )}
      </section>

      <form className="composer" onSubmit={sendMessage}>
        <input
          aria-label="Message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Write a message..."
        />
      </form>
    </main>
  )
}
