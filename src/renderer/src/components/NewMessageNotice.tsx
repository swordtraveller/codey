import { memo } from 'react'

interface NewMessageNoticeProps {
  visible: boolean
  onClick: () => void
}

export const NewMessageNotice = memo(({ visible, onClick }: NewMessageNoticeProps) => {
  if (!visible) return null

  return (
    <div
      onClick={onClick}
      style={{
        position: 'fixed',
        bottom: '24px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        background: '#0F172A',
        border: '1px solid #38BDF8',
        borderRadius: '24px',
        padding: '10px 20px',
        cursor: 'pointer',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
        transition: 'all 0.2s',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = '#1E293B'
        e.currentTarget.style.borderColor = '#22D3EE'
        e.currentTarget.style.transform = 'translateX(-50%) translateY(-2px)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = '#0F172A'
        e.currentTarget.style.borderColor = '#38BDF8'
        e.currentTarget.style.transform = 'translateX(-50%)'
      }}
    >
      <span style={{ color: '#F8FAFC', fontSize: '13px', fontWeight: '500' }}>
        有新消息
      </span>
      <span style={{ color: '#38BDF8', fontSize: '16px', fontWeight: '600' }}>
        ↓
      </span>
    </div>
  )
})

NewMessageNotice.displayName = 'NewMessageNotice'
