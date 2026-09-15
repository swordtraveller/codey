import { memo } from 'react'

interface UnreadBadgeProps {
  count: number
  /** When true, shows a red exclamation mark instead of the unread count. */
  error?: boolean
}

export const UnreadBadge = memo(({ count, error }: UnreadBadgeProps) => {
  if (error) {
    return (
      <span
        title="会话异常"
        style={{
          display: 'inline-flex',
        flexShrink: 0,
          alignItems: 'center',
          justifyContent: 'center',
          width: '18px',
          height: '18px',
          background: '#EF4444',
          color: '#FFF',
          borderRadius: '50%',
          fontSize: '13px',
          fontWeight: '700',
          lineHeight: '1',
        }}
      >
        !
      </span>
    )
  }

  if (count <= 0) return null

  return (
    <span
      style={{
        display: 'inline-flex',
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: '18px',
        height: '18px',
        padding: '0 5px',
        background: '#3B82F6',
        color: '#EFF6FF',
        borderRadius: '9px',
        fontSize: '11px',
        fontWeight: '600',
        lineHeight: '1',
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
})

UnreadBadge.displayName = 'UnreadBadge'