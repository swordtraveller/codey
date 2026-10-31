import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Select } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import { invalidModelReferences, modelDeletionImpact, type ModelReferenceReplacements } from '../../../shared/model-deletion'
import type { AppConfig, Project } from '../../../shared/types'

export type ModelDeletionDialogProps = {
  before: AppConfig
  after: AppConfig
  projects: Project[]
  name: string
  repairOnly: boolean
  referenceChoices: ModelReferenceReplacements
  onReferenceChoice: (key: string, id: string | null) => void
  replacement: string
  onReplacement: (id: string) => void
  onCancel: () => void
  onConfirm: () => void
}

export function ModelDeletionDialog(props: ModelDeletionDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const impact = modelDeletionImpact(props.before, props.after, props.projects)
  const references = invalidModelReferences(props.after, props.projects)
  const empty = props.after.models.length === 0 || props.after.providers.length === 0
  const sections = [
    [t('modelDeleteModels'), impact.removedModels.map(item => item.name)],
    [t('modelDeleteGroups'), impact.removedGroups.map(item => item.name)],
    [t('modelDeleteGroupMembers'), impact.changedGroups.map(item => item.name)],
  ] as const
  const options = <>
    <option value="">{t('modelReferenceClear')}</option>
    {props.after.modelGroups.length > 0 && <optgroup label={t('modelGroupBadge')}>{props.after.modelGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</optgroup>}
    <optgroup label={t('modelDeleteModels')}>{props.after.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</optgroup>
  </>
  return (
    <Dialog open onOpenChange={(_, data) => { if (!data.open) props.onCancel() }}>
      <DialogSurface className="model-deletion-dialog">
        <DialogBody>
          <DialogTitle>{props.repairOnly ? t('modelReferenceRepairTitle') : t('modelDeleteTitle', { name: props.name })}</DialogTitle>
          <DialogContent>
            <p>{t('modelDeleteDraftHint')}</p>
            {sections.filter(([, names]) => names.length > 0).map(([title, names]) => (
              <section key={title}><strong>{title} ({names.length})</strong><ul>{names.map((name, i) => <li key={i}>{name}</li>)}</ul></section>
            ))}
            <p>{t('modelDeleteHistoryHint')}</p>
            {references.length > 0 && !empty && <>
              <Field label={t('modelReferenceBulk')}>
                <Select value={props.replacement} onChange={(_, data) => props.onReplacement(data.value)}>{options}</Select>
              </Field>
              <p>{t('modelReferenceClearHint')}</p>
              <div className="settings-change-list">
                {references.map(ref => {
                  const scope = ref.projectName
                    ? [ref.projectName, ref.conversationTitle].filter(Boolean).join(' / ')
                    : t('modelReferenceGlobal')
                  const label = `${scope} · ${t(ref.kind === 'audit' ? 'modelReferenceAudit' : 'modelReferenceModel')}`
                  return <Field key={ref.key} label={label}>
                    <Select aria-label={label} value={props.referenceChoices[ref.key] ?? ''}
                      onChange={(_, data) => props.onReferenceChoice(ref.key, data.value || null)}>{options}</Select>
                  </Field>
                })}
              </div>
            </>}
            {empty && <p className="dialog-error" role="alert">{t('modelDeleteLastBlocked')}</p>}
          </DialogContent>
          <DialogActions>
            <Button onClick={props.onCancel}>{t('cancel')}</Button>
            <Button appearance="primary" disabled={empty} onClick={props.onConfirm}>{t(props.repairOnly ? 'modelReferenceApply' : 'modelDeleteConfirm')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
