import { formatCodeReadReference, parseCodeReadReference, type CodeReadReference } from './code-reading-reference'

export type ArchitectureSource = { root: string; path: string; startLine?: number; endLine?: number }
export type ArchitectureNode = { id: string; label: string; description?: string; source?: ArchitectureSource }
export type ArchitectureEdge = { from: string; to: string; label?: string }
export type ArchitectureGraph = { title?: string; nodes: ArchitectureNode[]; edges: ArchitectureEdge[] }
export type ArchitectureResult = { ok: true; graph: ArchitectureGraph } | { ok: false; error: string }
export const architectureLimits = { characters: 64_000, nodes: 60, edges: 120 }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const optionalText = (value: unknown, max: number): boolean => value === undefined || text(value, max)

export function architectureSourceReference(source: ArchitectureSource): CodeReadReference {
  return { rootId: source.root, path: source.path, startLine: source.startLine, endLine: source.endLine }
}

/** Model data is validated identically for rendering and snapshot authorization. */
export function parseArchitecture(content: string): ArchitectureResult {
  const fail = (error: string): ArchitectureResult => ({ ok: false, error })
  if (content.length > architectureLimits.characters) return fail('Diagram exceeds 64,000 characters.')
  let value: unknown
  try { value = JSON.parse(content) } catch { return fail('Expected a complete JSON object.') }
  if (!record(value) || !keys(value, ['title', 'nodes', 'edges']) || !optionalText(value.title, 160)
    || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return fail('Expected title (optional), nodes and edges.')
  if (!value.nodes.length || value.nodes.length > architectureLimits.nodes || value.edges.length > architectureLimits.edges) {
    return fail('Use 1–60 nodes and at most 120 edges; split larger diagrams.')
  }
  const ids = new Set<string>()
  for (const node of value.nodes) {
    if (!record(node) || !keys(node, ['id', 'label', 'description', 'source']) || !id(node.id)
      || !text(node.label, 120) || !optionalText(node.description, 500) || ids.has(node.id)) {
      return fail('Nodes need unique IDs and non-empty labels (maximum 120 characters).')
    }
    ids.add(node.id)
    if (node.source !== undefined) {
      const source = node.source
      if (!record(source) || !keys(source, ['root', 'path', 'startLine', 'endLine'])
        || !text(source.root, 200) || !text(source.path, 1_000)) return fail('Invalid source root or path.')
      for (const line of [source.startLine, source.endLine]) {
        if (line !== undefined && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1 || line > 10_000_000)) {
          return fail('Source lines must be positive integers.')
        }
      }
      if ((source.endLine !== undefined && source.startLine === undefined)
        || (typeof source.endLine === 'number' && typeof source.startLine === 'number' && source.endLine < source.startLine)) {
        return fail('Source endLine must follow startLine.')
      }
      try {
        const link = formatCodeReadReference(architectureSourceReference(source as ArchitectureSource))
        if (!parseCodeReadReference(link)) return fail('Source must use a project folder ID and a safe relative POSIX path.')
      } catch { return fail('Source contains invalid Unicode.') }
    }
  }
  const pairs = new Set<string>()
  for (const edge of value.edges) {
    if (!record(edge) || !keys(edge, ['from', 'to', 'label']) || !id(edge.from) || !id(edge.to)
      || !ids.has(edge.from) || !ids.has(edge.to) || !optionalText(edge.label, 80)) return fail('Edges must reference existing node IDs.')
    const key = edge.from + ':' + edge.to
    if (pairs.has(key)) return fail('Duplicate edges are not supported; combine their labels.')
    pairs.add(key)
  }
  return { ok: true, graph: value as ArchitectureGraph }
}

export type ArchitectureBlock = { kind: 'markdown' | 'architecture'; content: string }

/** Only closed, top-level fences are diagrams. Outer example fences remain ordinary Markdown. */
export function splitArchitectureBlocks(content: string): ArchitectureBlock[] {
  const lines = content.split('\n')
  const blocks: ArchitectureBlock[] = []
  let start = 0
  let fence: { index: number; character: string; length: number; architecture: boolean } | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '')
    if (!fence) {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (!open || (open[1][0] === '`' && open[2].includes('`'))) continue
      fence = { index, character: open[1][0], length: open[1].length, architecture: open[2].trim() === 'architecture' }
      continue
    }
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
    if (!close || close[1][0] !== fence.character || close[1].length < fence.length) continue
    if (fence.architecture) {
      if (fence.index > start) blocks.push({ kind: 'markdown', content: lines.slice(start, fence.index).join('\n') })
      blocks.push({ kind: 'architecture', content: lines.slice(fence.index + 1, index).join('\n') })
      start = index + 1
    }
    fence = undefined
  }
  if (start < lines.length) blocks.push({ kind: 'markdown', content: lines.slice(start).join('\n') })
  return blocks
}

export const architecturePrompt = [
  'When a project architecture diagram helps explain inspected code, emit a top-level fenced code block with language architecture containing JSON (not a tool call).',
  'Schema: {"title":"optional title","nodes":[{"id":"module_id","label":"Module name","description":"optional explanation","source":{"root":"project-folder-id","path":"relative/file.ts","startLine":1,"endLine":20}},{"id":"other_node_id","label":"Conceptual dependency"}],"edges":[{"from":"module_id","to":"other_node_id","label":"imports / calls / sends"}]}.',
  'Use 1–60 nodes, at most 120 edges, IDs matching [A-Za-z0-9_-]{1,64}, labels up to 120 characters, descriptions up to 500, and edge labels up to 80.',
  'Each edge points from the caller/importer/sender to its dependency/receiver; explain the relation in its label. Cycles, self references and disconnected modules are allowed. No execution statuses or artificial start/end nodes.',
  'Each node may cite one file via source; omit source for conceptual nodes. root is an actual project-folder ID, path is an unescaped relative POSIX path, and optional line ranges are 1-based inclusive.',
  'Only attach sources you read and relationships supported by inspected code. Describe uncertainty in prose instead of inventing dependencies. Split large diagrams into focused views.',
  'Codey renders the diagram and captures source snapshots when the message is saved; clicking a source node opens the code viewer. Close the fence and do not nest it in lists, quotes, or example fences.',
].join(' ')
