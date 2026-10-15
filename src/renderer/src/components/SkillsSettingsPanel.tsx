import { Button, Checkbox, Field, Input } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import type { InstalledSkill, SkillImportPreview } from '../../../shared/types'
import { formatBytes } from '../utils/format-bytes'

export type SkillsSettingsPanelProps = {
  installedSkills: InstalledSkill[]
  skillUrl: string
  skillPreview: SkillImportPreview | null
  selectedSkillCandidateIds: string[]
  skillBusy: boolean
  skillError: string
  interactionLocked: boolean
  onUrlChange: (url: string) => void
  onCandidateSelectionChange: (id: string, selected: boolean) => void
  onPreview: () => void
  onInstall: () => void
  onPrepareUpdate: (skill: InstalledSkill) => void
  onRemove: (skill: InstalledSkill) => void
}

export function SkillsSettingsPanel({
  installedSkills,
  skillUrl,
  skillPreview,
  selectedSkillCandidateIds,
  skillBusy,
  skillError,
  interactionLocked,
  onUrlChange,
  onCandidateSelectionChange,
  onPreview,
  onInstall,
  onPrepareUpdate,
  onRemove,
}: SkillsSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const installedSkillIds = new Set(installedSkills.map((skill) => skill.id))

  return (
    <section className="settings-group skill-management">
      <h2>{t('skillManagement')}</h2>
      <p className="settings-description">{t('skillManagementDescription')}</p>
      <Field label={t('skillGitHubUrl')} hint={t('skillGitHubUrlHint')}>
        <Input
          value={skillUrl}
          disabled={skillBusy || interactionLocked}
          placeholder="https://github.com/owner/repository/tree/main/path/to/skill"
          onChange={(_, data) => onUrlChange(data.value)}
        />
      </Field>
      <div className="skill-import-actions">
        <Button disabled={!skillUrl.trim() || skillBusy || interactionLocked} onClick={() => void onPreview()}>
          {skillBusy ? t('loading') : t('previewSkill')}
        </Button>
      </div>
      {skillPreview && (
        <div className="skill-preview">
          <h3>{skillPreview.name}</h3>
          {skillPreview.description && <p>{skillPreview.description}</p>}
          <dl className="skill-metadata">
            <dt>{t('skillCommit')}</dt><dd>{skillPreview.sourceCommitSha}</dd>
            <dt>{t('skillSourcePath')}</dt><dd>{skillPreview.sourcePath || '/'}</dd>
            <dt>{t('skillFiles')}</dt><dd>{skillPreview.fileCount}</dd>
            <dt>{t('skillPackageSize')}</dt><dd>{formatBytes(skillPreview.totalBytes)}</dd>
          </dl>
          <h4>{t('skillScriptCandidates')}</h4>
          {skillPreview.candidates.length === 0 ? (
            <p className="settings-description">{t('skillNoScriptCandidates')}</p>
          ) : (
            <div className="skill-candidate-list">
              {skillPreview.candidates.map((candidate) => (
                <label className="skill-candidate-row" key={candidate.id}>
                  <Checkbox
                    checked={selectedSkillCandidateIds.includes(candidate.id)}
                    disabled={skillBusy || interactionLocked}
                    onChange={(_, data) => onCandidateSelectionChange(candidate.id, data.checked === true)}
                  />
                  <span>
                    <strong>{candidate.name}</strong>
                    <small>{candidate.runtime} · {candidate.entry}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
          <p className="settings-warning" role="alert">{t('skillSecurityWarning')}</p>
          <Button appearance="primary" disabled={skillBusy || interactionLocked} onClick={() => void onInstall()}>
            {installedSkillIds.has(skillPreview.skillId) ? t('overwriteSkill') : t('installSkill')}
          </Button>
        </div>
      )}
      <div className="skill-list">
        <h2>{t('installedSkills')}</h2>
        {installedSkills.length === 0 ? (
          <p className="settings-description">{t('noInstalledSkills')}</p>
        ) : installedSkills.map((skill) => (
          <article className="skill-card" key={skill.id}>
            <div className="skill-card-header">
              <div>
                <h3>{skill.name}</h3>
                {skill.description && <p>{skill.description}</p>}
              </div>
              <div className="skill-import-actions">
                <Button size="small" disabled={skillBusy || interactionLocked} onClick={() => onPrepareUpdate(skill)}>
                  {t('skillUpdate')}
                </Button>
                <Button size="small" disabled={skillBusy || interactionLocked} onClick={() => void onRemove(skill)}>
                  {t('skillRemove')}
                </Button>
              </div>
            </div>
            <dl className="skill-metadata">
              <dt>{t('skillSource')}</dt><dd>{skill.sourceUrl}</dd>
              <dt>{t('skillCommit')}</dt><dd>{skill.sourceCommitSha}</dd>
              <dt>{t('skillPackageSha')}</dt><dd>{skill.packageSha256}</dd>
              <dt>{t('skillTools')}</dt><dd>{skill.tools.length}</dd>
              <dt>{t('skillInstalledAt')}</dt><dd>{new Date(skill.installedAt).toLocaleString()}</dd>
            </dl>
          </article>
        ))}
      </div>
      {skillError && <p className="dialog-error">{skillError}</p>}
    </section>
  )
}
