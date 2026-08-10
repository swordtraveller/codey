export function App(): React.JSX.Element {
  const runtime = window.runtime?.electron
    ? `Electron ${window.runtime.electron}`
    : 'Electron'

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand" aria-label="Codey">
          Codey
        </div>
        <div className="status">
          <span className="status-dot" />
          Ready
        </div>
      </header>

      <section className="welcome" aria-labelledby="welcome-title">
        <p className="eyebrow">Desktop workspace</p>
        <h1 id="welcome-title">Conversation, work and coding.</h1>
        <p className="intro">
          A quiet place to think clearly and move work forward.
        </p>
      </section>

      <footer className="footer">
        <span>Codey desktop</span>
        <span>{runtime}</span>
      </footer>
    </main>
  )
}
