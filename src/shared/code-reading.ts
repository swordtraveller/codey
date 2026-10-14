export type CodeReadReference = {
  rootId: string
  path: string
  startLine?: number
  endLine?: number
}

export type CodeReadViewerData = {
  sourceLink: string
  reference: CodeReadReference
  capturedAt: string
  language: string
  content: string
}

const maxRootIdLength = 200
const maxPathLength = 1_000
const maxLineNumber = 10_000_000

function validRelativePath(value: string): boolean {
  if (!value || value.length > maxPathLength || value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/** Strictly parses a model-facing immutable-source reference. */
export function parseCodeReadReference(value: string | undefined): CodeReadReference | null {
  if (typeof value !== 'string' || value.length > 2_500) return null
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'codey:' || url.hostname !== 'coderead' || url.pathname !== '/text'
    || url.username || url.password || url.port) return null
  const parameters = [...url.searchParams.keys()]
  if (parameters.length !== 2 || !parameters.includes('root') || !parameters.includes('path')) return null
  const rootId = url.searchParams.get('root') ?? ''
  const path = url.searchParams.get('path') ?? ''
  if (!rootId || rootId.length > maxRootIdLength || !validRelativePath(path)) return null
  let startLine: number | undefined
  let endLine: number | undefined
  if (url.hash) {
    const match = /^#L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(url.hash)
    if (!match) return null
    startLine = Number(match[1])
    endLine = match[2] ? Number(match[2]) : startLine
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
      || startLine > maxLineNumber || endLine > maxLineNumber || endLine < startLine) return null
  }
  return { rootId, path, startLine, endLine }
}

/** Produces the canonical form used as a stable snapshot lookup key. */
export function formatCodeReadReference(reference: CodeReadReference): string {
  const suffix = reference.startLine
    ? `#L${reference.startLine}${reference.endLine && reference.endLine !== reference.startLine ? `-L${reference.endLine}` : ''}`
    : ''
  return `codey://coderead/text?root=${encodeURIComponent(reference.rootId)}&path=${encodeURIComponent(reference.path)}${suffix}`
}

export function codeReadReferenceKey(value: string): string | null {
  const reference = parseCodeReadReference(value)
  return reference ? formatCodeReadReference(reference) : null
}

/** Finds the source links emitted in a completed assistant message. */
export function findCodeReadReferences(content: string): Array<{ sourceLink: string; reference: CodeReadReference }> {
  const matches = content.match(/codey:\/\/coderead\/text[^\s<>)\]"']*/gu) ?? []
  const found = new Map<string, CodeReadReference>()
  for (const match of matches) {
    const reference = parseCodeReadReference(match)
    if (!reference) continue
    const sourceLink = formatCodeReadReference(reference)
    found.set(sourceLink, reference)
  }
  return [...found].map(([sourceLink, reference]) => ({ sourceLink, reference }))
}

export const codeReadLinkPrompt = [
  'When citing project code in your final answer, use a Markdown link in this exact form:',
  '[label](codey://coderead/text?root=<folder-id>&path=<relative-posix-path>#L<start>-L<end>).',
  'Use a folder id from the project-folder list, URL-encode values, and use 1-based inclusive lines.',
  'Only cite files you actually inspected. These links open an immutable Codey snapshot captured when your response is saved.',
].join(' ')
