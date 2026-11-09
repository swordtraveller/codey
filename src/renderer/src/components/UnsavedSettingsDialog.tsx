import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import type { SettingsChange } from '../settings-changes'

type Props = {
  open: boolean
  changes: SettingsChange[]
  saving: boolean
  saveDisabled: boolean
  error: string
  onReturn: () => void
  onSave: () => void
  onDiscard: () => void
}

export function UnsavedSettingsDialog({ open, changes, saving, saveDisabled, error, onReturn, onSave, onDiscard }: Props): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open && !saving) onReturn() }}>
      <DialogSurface className="unsaved-settings-dialog">
        <DialogBody>
          <DialogTitle>{t('settingsUnsavedTitle')}</DialogTitle>
          <DialogContent>
            <p>{t('settingsUnsavedDescription')}</p>
            <ul className="settings-change-list">
              {changes.map((change, index) => (
                <li key={index}>{t(change.section)}{change.name ? ` — ${change.name}` : ''} · {t(`settingsChange_${change.kind}`)}</li>
              ))}
            </ul>
            <p className="settings-description">{t('settingsReturnHint')}</p>
            {saveDisabled && !saving && <p className="settings-warning">{t('settingsCannotSave')}</p>}
            {error && <p className="dialog-error" role="alert">{error}</p>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={saving} onClick={onReturn}>{t('settingsContinueEditing')}</Button>
            <Button appearance="secondary" disabled={saving} onClick={onDiscard}>{t('settingsDiscardExit')}</Button>
            <Button appearance="primary" disabled={saveDisabled || saving} onClick={onSave}>{t(saving ? 'saving' : 'save')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
