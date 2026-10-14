import { useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssistantMessageBlock } from '../../../shared/types'
import { dagStatuses, type DagSnapshot } from '../../../shared/dag'
import { usePlanCardExpansion } from './PlanCardsProvider'
import { DAG_NODE_HEIGHT, DAG_NODE_WIDTH, layoutDag } from './dag-layout'

const statusMarks = { pending: '·', in_progress: '→', blocked: '!', finished: '✓' }

export function DagPanel({ snapshot }: { snapshot: DagSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const markerId = 'dag-arrow-' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const layout = useMemo(() => layoutDag(snapshot.nodes), [snapshot.nodes])
  const names = new Map(snapshot.nodes.map((node) => [node.id, node.name]))
  return <div className="dag-panel">
    {!snapshot.success && <p className="todo-error" role="alert">{snapshot.error}</p>}
    <div className="dag-legend">{dagStatuses.map((status) => <span key={status} className={'dag-status-' + status}>
      {statusMarks[status]} {t('dagStatus_' + status)}
    </span>)}</div>
    {snapshot.nodes.length === 0 ? <p>{t('dagEmpty')}</p> : <>
      <p className="dag-progress">{t('dagProgress', { finished: snapshot.nodes.filter((node) => node.status === 'finished').length, total: snapshot.nodes.length })}</p>
      <div className="dag-viewport" tabIndex={0} role="region" aria-label={t('dagPanel')}>
        <div className="dag-canvas" style={{ width: layout.width, height: layout.height }}>
          <svg className="dag-edges" width={layout.width} height={layout.height} aria-hidden="true">
            <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker></defs>
            {layout.edges.map((edge) => <path key={edge.from + ':' + edge.to} d={edge.path} fill="none" stroke="currentColor" strokeWidth="1.5" markerEnd={'url(#' + markerId + ')'} />)}
          </svg>
          <ol className="dag-nodes">
            {layout.nodes.map((node) => {
              const name = node.task?.name ?? t(node.kind === 'start' ? 'dagStart' : 'dagEnd')
              const dependencyNames = node.task?.dependsOn.map((id) => names.get(id)).join(', ')
              const detail = [name, node.task?.description, node.task?.note, dependencyNames ? t('dagDependencies') + ': ' + dependencyNames : ''].filter(Boolean).join('\n')
              return <li key={node.id} className={'dag-node dag-status-' + node.status + (node.kind === 'task' ? '' : ' dag-terminal')}
                style={{ left: node.x, top: node.y, width: DAG_NODE_WIDTH, height: DAG_NODE_HEIGHT }} title={detail} tabIndex={0}>
                <span className="dag-node-status">{statusMarks[node.status]} {t('dagStatus_' + node.status)}</span>
                <strong className="dag-node-name">{name}</strong>
                {node.task && <span className="dag-node-detail">{node.task.note || node.task.description || node.task.id}</span>}
                {dependencyNames && <span className="dag-accessible">{t('dagDependencies')}: {dependencyNames}</span>}
              </li>
            })}
          </ol>
        </div>
      </div>
      <p className="dag-footnote">{t('dagCompletionHint')}</p>
    </>}
  </div>
}

export function DagToolCard({ block, snapshot }: { block: Extract<AssistantMessageBlock, { type: 'function_call' }>; snapshot: DagSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const expansion = usePlanCardExpansion()
  const open = expansion?.openId === block.id
  return <details className={'function-call dag-function-call' + (snapshot.success ? '' : ' tool-error')} open={open}>
    <summary onClick={(event) => {
      if (!expansion) return
      event.preventDefault()
      expansion.setOpenId(open ? null : block.id)
    }}>{block.name} · {t('dagPanel')}</summary>
    {open && <>
      <DagPanel snapshot={snapshot} />
      <details className="tool-output-section"><summary>{t('toolParameters')}</summary><pre>{block.parameters}</pre></details>
    </>}
  </details>
}
