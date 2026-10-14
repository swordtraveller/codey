import { usePlanCardExpansion } from './PlanCardsProvider'
import { useTranslation } from 'react-i18next'
import type { AssistantMessageBlock } from '../../../shared/types'
import { type TodoSnapshot } from '../../../shared/todo'

function TodoPanel({ snapshot }: { snapshot: TodoSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const changeById = new Map(snapshot.changes.map((change) => [change.item.id, change.kind]))
  const deleted = snapshot.changes.filter((change) => change.kind === 'deleted')
  return (
    <div className={`todo-panel${snapshot.success ? '' : ' todo-panel-error'}`}>
      {!snapshot.success && <p className="todo-error" role="alert">{snapshot.error}</p>}
      {snapshot.items.length === 0 && deleted.length === 0 && <p className="todo-empty">{t('todoEmpty')}</p>}
      <ul className="todo-list">
        {snapshot.items.map((item) => (
          <li className={`todo-item todo-status-${item.status}${changeById.get(item.id) === 'added' ? ' todo-item-new' : ''}`} key={item.id}>
            <span className="todo-status-mark" aria-hidden="true">{item.status === 'finished' ? '✓' : item.status === 'in_progress' ? '→' : item.status === 'blocked' ? '!' : item.status === 'skipped' ? '–' : '·'}</span>
            <span className="todo-item-name">{item.name}</span>
            <span className="todo-item-status">{t(`todoStatus_${item.status}`)}</span>
            {changeById.get(item.id) === 'added' && <span className="todo-change todo-change-added">{t('todoChange_added')}</span>}
          </li>
        ))}
        {deleted.map(({ item }) => (
          <li className="todo-item todo-item-deleted" key={`deleted-${item.id}`}>
            <span className="todo-status-mark" aria-hidden="true">×</span>
            <span className="todo-item-name">{item.name}</span>
            <span className="todo-change todo-change-deleted">{t('todoChange_deleted')}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function TodoToolCard({ block, snapshot }: { block: Extract<AssistantMessageBlock, { type: 'function_call' }>; snapshot: TodoSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const expansion = usePlanCardExpansion()
  const open = expansion?.openId === block.id
  let parameters = block.parameters
  try { parameters = JSON.stringify(JSON.parse(parameters), null, 2) } catch { /* render raw input */ }
  return (
    <details className={`function-call todo-function-call${block.resultError ? ' tool-error' : ''}`} open={open}>
      <summary onClick={(event) => {
        if (!expansion) return
        event.preventDefault()
        expansion.setOpenId(open ? null : block.id)
      }}>{block.name} · {t('todoPanel')}</summary>
      {open && <>
        <div className="tool-output-section"><span>{t('toolParameters')}</span><pre>{parameters}</pre></div>
        <TodoPanel snapshot={snapshot} />
      </>}
    </details>
  )
}
