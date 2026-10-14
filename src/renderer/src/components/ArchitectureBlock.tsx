import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { architectureSourceReference, parseArchitecture, type ArchitectureGraph } from '../../../shared/architecture'
import { formatCodeReadReference } from '../../../shared/code-reading-reference'
import { GraphCanvas } from './GraphCanvas'
import { ARCHITECTURE_NODE_HEIGHT, ARCHITECTURE_NODE_WIDTH, layoutArchitecture } from './architecture-layout'

export type CodeReadOwner = { projectId?: string; conversationId?: string; messageId?: string }

function ArchitecturePanel({ graph, projectId, conversationId, messageId }: { graph: ArchitectureGraph } & CodeReadOwner): React.JSX.Element {
  const { t } = useTranslation()
  const layout = useMemo(() => layoutArchitecture(graph), [graph])
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)
  const saved = Boolean(projectId && conversationId && messageId)
  const names = new Map(graph.nodes.map((node) => [node.id, node.label]))
  const open = async (sourceLink: string): Promise<void> => {
    if (!projectId || !conversationId || !messageId || opening) return
    setOpening(true); setError('')
    try { await window.codey.openCodeRead(projectId, conversationId, messageId, sourceLink) }
    catch (reason) { setError(String(reason)) }
    finally { setOpening(false) }
  }
  return <section className="architecture-panel" aria-label={graph.title || t('architectureTitle')}>
    <div className="architecture-heading"><strong>{graph.title || t('architectureTitle')}</strong></div>
    <p className="architecture-hint">{t(saved ? 'architectureHint' : 'architecturePending')}</p>
    {error && <p className="architecture-error" role="alert">{t('architectureOpenError')}: {error}</p>}
    <GraphCanvas width={layout.width} height={layout.height} edges={layout.edges} label={graph.title || t('architectureTitle')}>
      <ul className="architecture-nodes">
        {layout.nodes.map((node) => {
          const source = node.source
          const location = source ? `${source.root}: ${source.path}${source.startLine ? `:${source.startLine}${source.endLine && source.endLine !== source.startLine ? '–' + source.endLine : ''}` : ''}` : ''
          const content = <>
            <strong className="architecture-node-label">{node.label}</strong>
            <span className="architecture-node-description">{node.description || (source ? t('architectureOpen') : t('architectureConcept'))}</span>
            {source && <span className="architecture-node-source">{source.path.split('/').pop()}{source.startLine ? ':' + source.startLine : ''} ↗</span>}
          </>
          return <li key={node.id} className="architecture-node" style={{ left: node.x, top: node.y, width: ARCHITECTURE_NODE_WIDTH, height: ARCHITECTURE_NODE_HEIGHT }}>
            {source ? <button type="button" disabled={!saved || opening} title={[node.label, node.description, location].filter(Boolean).join('\n')}
              aria-label={`${t('architectureOpen')}: ${node.label} (${location})`}
              onClick={() => { void open(formatCodeReadReference(architectureSourceReference(source))) }}>{content}</button>
              : <div className="architecture-concept" title={[node.label, node.description].filter(Boolean).join('\n')}>{content}</div>}
          </li>
        })}
      </ul>
    </GraphCanvas>
    {graph.edges.length > 0 && <details className="architecture-relations">
      <summary>{t('architectureRelations', { count: graph.edges.length })}</summary>
      <ul>{graph.edges.map((edge) => <li key={edge.from + ':' + edge.to}>{names.get(edge.from)} → {names.get(edge.to)}{edge.label ? ` · ${edge.label}` : ''}</li>)}</ul>
    </details>}
  </section>
}

export function ArchitectureBlock({ content, ...owner }: { content: string } & CodeReadOwner): React.JSX.Element {
  const { t } = useTranslation()
  const result = useMemo(() => parseArchitecture(content), [content])
  return result.ok ? <ArchitecturePanel graph={result.graph} {...owner} /> : <div className="architecture-invalid">
    <p role="status">{t('architectureInvalid')} {result.error}</p>
    <pre><code>{content}</code></pre>
  </div>
}
