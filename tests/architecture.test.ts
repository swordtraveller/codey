import { describe, expect, it } from 'vitest'
import { parseArchitecture, splitArchitectureBlocks, type ArchitectureGraph } from '../src/shared/architecture'
import { findCodeReadReferences } from '../src/shared/code-reading'

const graph: ArchitectureGraph = {
  title: 'Application',
  nodes: [{ id: 'ui', label: 'UI', source: { root: 'folder one', path: 'src/模块.ts', startLine: 3, endLine: 8 } }, { id: 'main', label: 'Main process' }],
  edges: [{ from: 'ui', to: 'main', label: 'IPC' }, { from: 'main', to: 'ui', label: 'Events' }],
}
const fence = (value: unknown): string => '```architecture\n' + JSON.stringify(value) + '\n```'

describe('architecture message format', () => {
  it('accepts cyclic and conceptual nodes and deduplicates references with ordinary links', () => {
    expect(parseArchitecture(JSON.stringify(graph))).toEqual({ ok: true, graph })
    const link = 'codey://coderead/text?root=folder%20one&path=src%2F%E6%A8%A1%E5%9D%97.ts#L3-L8'
    expect(findCodeReadReferences(fence(graph) + `\n[source](${link})`)).toEqual([{
      sourceLink: link, reference: { rootId: 'folder one', path: 'src/模块.ts', startLine: 3, endLine: 8 },
    }])
  })
  it.each([
    { ...graph, nodes: [...graph.nodes, graph.nodes[0]] },
    { ...graph, edges: [{ from: 'ui', to: 'missing' }] },
    { ...graph, edges: [graph.edges[0], graph.edges[0]] },
    { ...graph, nodes: [] },
    { ...graph, nodes: Array.from({ length: 61 }, (_, i) => ({ id: String(i), label: 'x' })) },
    { ...graph, script: 'alert(1)' },
  ])('rejects malformed or excessive graphs', (value) => {
    expect(parseArchitecture(JSON.stringify(value)).ok).toBe(false)
    expect(findCodeReadReferences(fence(value))).toEqual([])
  })
  it.each([
    { root: 'folder', path: '\ud800' },
    { root: 'folder', path: '../secret' }, { root: 'folder', path: 'C:/secret' },
    { root: 'folder', path: 'src\\file.ts' }, { root: 'folder', path: '/absolute' },
    { root: 'folder', path: 'file.ts', startLine: 0 }, { root: 'folder', path: 'file.ts', startLine: 1.5 },
    { root: 'folder', path: 'file.ts', endLine: 2 }, { root: 'folder', path: 'file.ts', startLine: 9, endLine: 2 },
    { root: 'folder', path: 'file.ts', startLine: '1' }, { root: 'folder', path: 'file.ts', url: 'javascript:alert(1)' },
  ])('rejects unsafe or invalid source %j', (source) => {
    expect(parseArchitecture(JSON.stringify({ nodes: [{ id: 'a', label: 'A', source }], edges: [] })).ok).toBe(false)
  })
  it('keeps incomplete fences and example fences as ordinary Markdown', () => {
    const incomplete = '```architecture\n{"nodes":'
    expect(splitArchitectureBlocks(incomplete)).toEqual([{ kind: 'markdown', content: incomplete }])
    const example = '````markdown\n' + fence(graph) + '\n````'
    expect(splitArchitectureBlocks(example)).toEqual([{ kind: 'markdown', content: example }])
    expect(findCodeReadReferences(example)).toEqual([])
    expect(findCodeReadReferences(incomplete)).toEqual([])
  })
  it('preserves prose and multiple fenced blocks, including CRLF and tilde fences', () => {
    const content = 'before\n' + fence(graph) + '\nafter\n~~~architecture\n' + JSON.stringify(graph) + '\n~~~'
    const blocks = splitArchitectureBlocks(content.replace(/\n/g, '\r\n'))
    expect(blocks.map((block) => block.kind)).toEqual(['markdown', 'architecture', 'markdown', 'architecture'])
    expect(blocks.filter((block) => block.kind === 'architecture').every((block) => parseArchitecture(block.content).ok)).toBe(true)
    expect(splitArchitectureBlocks('    ' + fence(graph))[0].kind).toBe('markdown')
  })
  it('preserves invalid JSON for a readable fallback', () => {
    expect(parseArchitecture('{"nodes":')).toMatchObject({ ok: false })
    expect(parseArchitecture(' '.repeat(64_001))).toMatchObject({ ok: false })
    expect(splitArchitectureBlocks('```architecture\nnot JSON\n```')).toEqual([{ kind: 'architecture', content: 'not JSON' }])
  })
})
