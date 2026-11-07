import { useRef, useState } from 'react'
import { Button } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'

type Item = { id: string; text: string; attachmentCount: number }
type DropTarget = { id: string; placement: 'before' | 'after' }

export function QueuedMessageList({ items, pendingId, canRunNow, onReorder, onRunNow, onRemove }: {
  items: Item[]
  pendingId?: string
  canRunNow: boolean
  onReorder: (sourceId: string, targetId: string, placement: 'before' | 'after') => void
  onRunNow: (id: string) => void
  onRemove: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const sourceRef = useRef<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const resetDrag = (): void => {
    sourceRef.current = null
    setDraggingId(null)
    setDropTarget(null)
  }

  return (
    <ol className="conversation-queue-items" aria-label={t('queuedMessages')}>
      {items.map((item, index) => (
        <li
          className={`conversation-queue-item${draggingId === item.id ? ' is-dragging' : ''}${dropTarget?.id === item.id ? ` drop-${dropTarget.placement}` : ''}`}
          key={item.id}
          onDragOver={(event) => {
            if (!sourceRef.current || pendingId || sourceRef.current === item.id) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            const rect = event.currentTarget.getBoundingClientRect()
            setDropTarget({ id: item.id, placement: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after' })
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
          }}
          onDrop={(event) => {
            if (!sourceRef.current || pendingId) return
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            onReorder(sourceRef.current, item.id, event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
            resetDrag()
          }}
        >
          <button
            type="button"
            className="conversation-queue-drag"
            draggable={!pendingId && items.length > 1}
            disabled={Boolean(pendingId) || items.length < 2}
            aria-label={`${t('reorderQueuedMessage')} (${index + 1}/${items.length})`}
            title={t('reorderQueuedMessage')}
            onDragStart={(event) => {
              sourceRef.current = item.id
              setDraggingId(item.id)
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', item.id)
              event.dataTransfer.setDragImage(event.currentTarget.parentElement!, 16, 20)
            }}
            onDragEnd={resetDrag}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              const target = items[index + (event.key === 'ArrowUp' ? -1 : 1)]
              if (target) onReorder(item.id, target.id, event.key === 'ArrowUp' ? 'before' : 'after')
            }}
          ><span aria-hidden="true">⠿</span></button>
          <span className="conversation-queue-order">{index + 1}</span>
          <p title={item.text}>{item.text}</p>
          <span className="conversation-queue-attachment-count">{item.attachmentCount > 0 ? `+${item.attachmentCount}` : ''}</span>
          <Button
            appearance="subtle" size="small" className="conversation-queue-run"
            disabled={!canRunNow || Boolean(pendingId)}
            title={t('runQueuedMessageNowDescription')}
            onClick={() => onRunNow(item.id)}
          >{pendingId === item.id ? t('queuedMessageWaitingForStop') : t('runQueuedMessageNow')}</Button>
          <Button
            appearance="subtle" size="small" className="conversation-queue-remove"
            disabled={pendingId === item.id}
            aria-label={t('removeQueuedMessage')} title={t('removeQueuedMessage')}
            onClick={() => onRemove(item.id)}
          >×</Button>
        </li>
      ))}
    </ol>
  )
}
