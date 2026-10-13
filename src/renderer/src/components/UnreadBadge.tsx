import { memo } from 'react'
import { useTranslation } from 'react-i18next'

interface UnreadBadgeProps {
  count: number
  error?: boolean
}

export const UnreadBadge = memo(({ count, error }: UnreadBadgeProps) => {
  const { t } = useTranslation()
  if (count <= 0 && !error) return null
  return (
    <span style={{ display: 'inline-flex', flexShrink: 0, alignItems: 'center', gap: 4 }}>
      {count > 0 && <span
        aria-label={t('unreadReplies', { count })}
        title={t('unreadReplies', { count })}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          minWidth: 18, height: 18, padding: '0 5px', background: '#3B82F6', color: '#EFF6FF',
          borderRadius: 9, fontSize: 11, fontWeight: 600, lineHeight: 1 }}
      >{count > 99 ? '99+' : count}</span>}
      {error && <span
        aria-label={t('conversationFailed')}
        title={t('conversationFailed')}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 18, height: 18, background: '#EF4444', color: '#FFF',
          borderRadius: '50%', fontSize: 13, fontWeight: 700, lineHeight: 1 }}
      >!</span>}
    </span>
  )
})

UnreadBadge.displayName = 'UnreadBadge'
