import { memo } from 'react'
import { Spinner } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import { UnreadBadge } from './UnreadBadge'

export const SidebarStatus = memo(({ unreadCount, error, runningCount, project = false }: {
  unreadCount: number
  error?: boolean
  runningCount: number
  project?: boolean
}) => {
  const { t } = useTranslation()
  if (unreadCount <= 0 && !error && runningCount <= 0) return null
  const label = project ? t('projectProcessing', { count: runningCount }) : t('conversationProcessing')
  return <span className="sidebar-status">
    {runningCount > 0 && <span className="sidebar-processing" title={label}>
      <Spinner size="extra-tiny" aria-label={label} />
    </span>}
    <UnreadBadge count={unreadCount} error={error} />
  </span>
})

SidebarStatus.displayName = 'SidebarStatus'
