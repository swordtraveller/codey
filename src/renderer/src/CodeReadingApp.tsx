import { useEffect, useMemo, useState } from 'react'
import type { CodeReadViewerData } from '../../shared/code-reading'
import { setAppLanguage } from './i18n'

const keywords = new Set(['abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'default', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'implements', 'import', 'in', 'interface', 'let', 'match', 'new', 'null', 'of', 'private', 'protected', 'public', 'return', 'static', 'switch', 'this', 'throw', 'true', 'try', 'type', 'undefined', 'var', 'void', 'while', 'with', 'yield'])

type Token = { text: string; kind?: 'comment' | 'string' | 'number' | 'keyword' }
function tokensFor(line: string, language: string): Token[] {
  if (language === 'text') return [{ text: line }]
  const result: Token[] = []
  const pattern = /(\/\/.*$|#.*$|\/\*[\s\S]*?\*\/|`(?:\\.|[^`])*`|'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g
  let cursor = 0
  for (const match of line.matchAll(pattern)) {
    const text = match[0]
    if (match.index! > cursor) result.push({ text: line.slice(cursor, match.index) })
    const kind = text.startsWith('//') || text.startsWith('#') || text.startsWith('/*') ? 'comment'
      : /^['"`]/.test(text) ? 'string' : /^\d/.test(text) ? 'number' : keywords.has(text) ? 'keyword' : undefined
    result.push({ text, kind })
    cursor = match.index! + text.length
  }
  if (cursor < line.length) result.push({ text: line.slice(cursor) })
  return result
}
function lineRange(data: CodeReadViewerData): { start: number; end: number } | null {
  const { startLine, endLine } = data.reference
  return startLine ? { start: startLine, end: endLine ?? startLine } : null
}

export function CodeReadingApp(): React.JSX.Element {
  const [data, setData] = useState<CodeReadViewerData | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.codey.getConfig().then((config) => { if (active) setAppLanguage(config.language) }).catch(() => undefined)
    void window.codey.getCodeReadData().then((value) => { if (active) setData(value) }).catch((reason) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [])
  useEffect(() => { document.title = 'Codey · Code reading' }, [])
  const lines = useMemo(() => data?.content.replace(/\r\n/g, '\n').split('\n') ?? [], [data])
  useEffect(() => {
    if (!data?.reference.startLine) return
    requestAnimationFrame(() => document.getElementById(`code-line-${data.reference.startLine}`)?.scrollIntoView({ block: 'center' }))
  }, [data])
  if (error) return <main className="code-reading-window"><p role="alert">Unable to open code snapshot: {error}</p></main>
  if (!data) return <main className="code-reading-window"><p role="status">Loading code snapshot…</p></main>
  const range = lineRange(data)
  return <main className="code-reading-window">
    <header className="code-reading-header">
      <div><h1>{data.reference.path}</h1><p>{data.reference.rootId} · {data.language} · captured {new Date(data.capturedAt).toLocaleString()}</p></div>
      <button type="button" onClick={() => void navigator.clipboard.writeText(data.content)}>Copy file</button>
    </header>
    {range && <p className="code-reading-range">Highlighted lines {range.start}–{range.end}</p>}
    <pre className="code-reading-source" aria-label={`Code snapshot for ${data.reference.path}`}><code>{lines.map((line, index) => {
      const number = index + 1
      const highlighted = Boolean(range && number >= range.start && number <= range.end)
      return <span className={`code-reading-line${highlighted ? ' target' : ''}`} id={`code-line-${number}`} key={number}>
        <span className="code-reading-number">{number}</span><span className="code-reading-code">{tokensFor(line, data.language).map((token, tokenIndex) => <span className={token.kind ? `syntax-${token.kind}` : undefined} key={tokenIndex}>{token.text}</span>)}</span>
      </span>
    })}</code></pre>
  </main>
}
