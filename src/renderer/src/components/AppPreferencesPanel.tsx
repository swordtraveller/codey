import { Field, Select, Switch } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import type { AppConfig, AppLanguage } from '../../../shared/types'

export type AppPreferencesTab = 'language' | 'power' | 'notifications'

export type AppPreferencesPanelProps = {
  selectedTab: AppPreferencesTab
  configDraft: AppConfig
  onConfigDraftChange: (updater: (current: AppConfig) => AppConfig) => void
}

export function AppPreferencesPanel({
  selectedTab,
  configDraft,
  onConfigDraftChange,
}: AppPreferencesPanelProps): React.JSX.Element {
  const { t } = useTranslation()

  if (selectedTab === 'language') {
    return (
      <section className="settings-group">
        <Field label={t('language')}>
          <Select
            value={configDraft.language}
            onChange={(_, data) => onConfigDraftChange((current) => ({
              ...current,
              language: data.value as AppLanguage,
            }))}
          >
            <option value="system">{t('followSystem')}</option>
            <option value="en">{t('english')}</option>
            <option value="zh-CN">{t('simplifiedChinese')}</option>
          </Select>
        </Field>
      </section>
    )
  }

  if (selectedTab === 'power') {
    return (
      <section className="settings-group">
        <Switch
          checked={configDraft.keepAwakeEnabled}
          label={t('keepAwakeComputer')}
          onChange={(_, data) => onConfigDraftChange((current) => ({
            ...current,
            keepAwakeEnabled: data.checked,
          }))}
        />
        {configDraft.keepAwakeEnabled && (
          <p className="settings-warning" role="alert">{t('keepAwakeWarning')}</p>
        )}
        <Switch
          checked={configDraft.keepAwakeOnlyWhileWorking}
          className="nested-setting"
          disabled={!configDraft.keepAwakeEnabled}
          label={t('keepAwakeOnlyWhileWorking')}
          onChange={(_, data) => onConfigDraftChange((current) => ({
            ...current,
            keepAwakeOnlyWhileWorking: data.checked,
          }))}
        />
      </section>
    )
  }

  return (
    <section className="settings-group">
      <Switch
        checked={configDraft.notificationSettings.enabled}
        label={t('notificationsEnabled')}
        onChange={(_, data) => onConfigDraftChange((current) => ({
          ...current,
          notificationSettings: { ...current.notificationSettings, enabled: data.checked },
        }))}
      />
      {([
        ['onlyWhenUnfocused', 'notificationsOnlyWhenUnfocused'],
        ['taskComplete', 'notificationsTaskComplete'],
        ['taskFailed', 'notificationsTaskFailed'],
        ['needsConfirmation', 'notificationsNeedsConfirmation'],
        ['connectionError', 'notificationsConnectionError'],
        ['modelError', 'notificationsModelError'],
      ] as const).map(([key, label]) => (
        <Switch
          key={key}
          checked={configDraft.notificationSettings[key]}
          disabled={!configDraft.notificationSettings.enabled}
          label={t(label)}
          onChange={(_, data) => onConfigDraftChange((current) => ({
            ...current,
            notificationSettings: { ...current.notificationSettings, [key]: data.checked },
          }))}
        />
      ))}
    </section>
  )
}
