import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Select,
  Switch,
  Tab,
  TabList,
} from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import type { AppConfig, InstalledSkill, KnowledgeBase, ModelConfig } from '../../../shared/types'
import { resolveModelTarget } from '../../../shared/model-targets'
import { ContextSettingsFields } from './ContextSettingsFields'
import { AgentLimitsFields, CommandExecutionEditorFields } from './CommandReviewSettings'
import {
  resourceSelectionMode,
  updateResourceSelection,
  resolveEffectiveResourceIds,
  type ResourceSelectionMode,
} from '../resource-selection'
import type { useProjectSettings } from '../hooks/useProjectSettings'

type ProjectSettingsDialogProps = {
  settings: ReturnType<typeof useProjectSettings>
  config: AppConfig
  installedSkills: InstalledSkill[]
  knowledgeBases: KnowledgeBase[]
  flatModelConfigs: ModelConfig[]
  effectiveModelConfig: ReturnType<typeof resolveModelTarget>
  interactionLocked: boolean
  saving: boolean
  settingsError: string
  openCommandRulesHelp: () => void
}

export function ProjectSettingsDialog({
  settings,
  config,
  installedSkills,
  knowledgeBases,
  flatModelConfigs,
  effectiveModelConfig,
  interactionLocked,
  saving,
  settingsError,
  openCommandRulesHelp,
}: ProjectSettingsDialogProps) {
  const { t } = useTranslation()
  const {
    projectSettingsOpen,
    setProjectSettingsOpen,
    projectSettingsTab,
    setProjectSettingsTab,
    projectSettingsModelConfigId,
    setProjectSettingsModelConfigId,
    projectAgentLimitsOverride,
    setProjectAgentLimitsOverride,
    projectAgentLimitsDraft,
    setProjectAgentLimitsDraft,
    projectCommandOverride,
    setProjectCommandOverride,
    projectCommandDraft,
    setProjectCommandDraft,
    projectContextOverride,
    setProjectContextOverride,
    projectContextDraft,
    setProjectContextDraft,
    projectSkillDraft,
    setProjectSkillDraft,
    projectKnowledgeBaseDraft,
    setProjectKnowledgeBaseDraft,
    saveProjectSettings,
    projectSettingsTarget,
    projectSettingsValid,
  } = settings
  const sortedConversationModelGroups = [...config.modelGroups].sort((a, b) => (a.name || t('unnamedModelGroup')).localeCompare(b.name || t('unnamedModelGroup')))
  const sortedConversationModels = [...config.models].sort((a, b) => (a.name || t('unnamedModel')).localeCompare(b.name || t('unnamedModel')))
  const applicationDefaultTargetLabel = (() => {
    const target = config.activeModelConfigId
    if (!target) return t('notConfigured')
    const model = config.models.find((entry) => entry.id === target)
    if (model) return model.name || t('unnamedModel')
    const group = config.modelGroups.find((entry) => entry.id === target)
    return group ? t('modelGroupOption', { name: group.name || t('unnamedModelGroup') }) : t('notConfigured')
  })()

  return (
    <Dialog open={projectSettingsOpen} onOpenChange={(_, data) => setProjectSettingsOpen(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('projectSettings')}{projectSettingsTarget ? ` · ${projectSettingsTarget.name}` : ''}</DialogTitle>
          <DialogContent className="dialog-fields">
            <TabList
              selectedValue={projectSettingsTab}
              onTabSelect={(_, data) => setProjectSettingsTab(data.value as typeof projectSettingsTab)}
            >
              <Tab value="model">{t('globalTabModel')}</Tab>
              <Tab value="agentLimits">{t('globalTabAgentLimits')}</Tab>
              <Tab value="command">{t('globalTabCommand')}</Tab>
              <Tab value="context">{t('globalTabContext')}</Tab>
              <Tab value="skills">{t('skills')}</Tab>
              <Tab value="knowledgeBases">{t('knowledgeBases')}</Tab>
            </TabList>
            {projectSettingsTab === 'model' && (
              <>
                <Field label={t('projectDefaultModel')}>
                  <Select
                    disabled={interactionLocked || config.models.length === 0}
                    value={projectSettingsModelConfigId}
                    onChange={(_, data) => setProjectSettingsModelConfigId(data.value)}
                  >
                    <option value="">{t('applicationDefault')}</option>
                    {sortedConversationModelGroups.map((group) => (
                      <option key={group.id} value={group.id}>{t('modelGroupOption', { name: group.name || t('unnamedModelGroup') })}</option>
                    ))}
                    {sortedConversationModels.map((model) => (
                      <option key={model.id} value={model.id}>{model.name || t('unnamedModel')}</option>
                    ))}
                  </Select>
                </Field>
                {projectSettingsModelConfigId === '' && (
                  <p className="settings-description">{t('applicationDefault')} · {applicationDefaultTargetLabel}</p>
                )}
              </>
            )}
            {projectSettingsTab === 'agentLimits' && (
              <>
                <Switch
                  checked={projectAgentLimitsOverride}
                  disabled={interactionLocked}
                  label={t('agentLimitsOverrideGlobal')}
                  onChange={(_, data) => setProjectAgentLimitsOverride(data.checked)}
                />
                <AgentLimitsFields
                  value={projectAgentLimitsDraft}
                  disabled={interactionLocked || !projectAgentLimitsOverride}
                  onChange={(patch) => setProjectAgentLimitsDraft((current) => ({ ...current, ...patch }))}
                />
              </>
            )}
            {projectSettingsTab === 'command' && (
              <>
                <Switch
                  checked={projectCommandOverride}
                  disabled={interactionLocked}
                  label={t('commandOverrideDefault')}
                  onChange={(_, data) => setProjectCommandOverride(data.checked)}
                />
                <CommandExecutionEditorFields
                  value={projectCommandDraft}
                  onChange={setProjectCommandDraft}
                  disabled={interactionLocked || !projectCommandOverride}
                  modelConfigs={flatModelConfigs}
                  sessionModel={effectiveModelConfig}
                  globalReview={config.commandReviewGlobal}
                  onOpenSyntaxHelp={openCommandRulesHelp}
                />
              </>
            )}
            {projectSettingsTab === 'context' && (
              <>
                <Switch
                  checked={projectContextOverride}
                  disabled={interactionLocked}
                  label={t('overrideApplicationContext')}
                  onChange={(_, data) => {
                    setProjectContextOverride(data.checked)
                    if (data.checked) {
                      setProjectContextDraft({ ...(projectSettingsTarget?.contextConfigOverride ?? config.contextManagement) })
                    }
                  }}
                />
                <ContextSettingsFields
                  disabled={interactionLocked || !projectContextOverride}
                  modelDisabled={interactionLocked}
                  modelTargets={[
                    ...sortedConversationModelGroups.map((group) => ({ id: group.id, label: t('modelGroupOption', { name: group.name || t('unnamedModelGroup') }) })),
                    ...sortedConversationModels.map((model) => ({ id: model.id, label: model.name || t('unnamedModel') })),
                  ]}
                  referenceModel={resolveModelTarget(config, projectSettingsModelConfigId || config.activeModelConfigId)}
                  activeModelConfigId={projectSettingsModelConfigId}
                  emptyModelOptionLabel={t('applicationDefault')}
                  onModelConfigChange={(modelConfigId) => setProjectSettingsModelConfigId(modelConfigId)}
                  value={projectContextDraft}
                  onChange={(patch) => setProjectContextDraft((current) => ({ ...current, ...patch }))}
                />
              </>
            )}
            {projectSettingsTab === 'skills' && (
              <section className="skill-selection-list">
                <p className="settings-description">{t('projectSkillSelectionDescription')}</p>
                {installedSkills.length === 0 ? (
                  <p className="status">{t('noInstalledSkills')}</p>
                ) : installedSkills.map((skill) => {
                  const effective = resolveEffectiveResourceIds(config.defaultSkillIds, projectSkillDraft).includes(skill.id)
                  return (
                    <div className="skill-selection-row" key={skill.id}>
                      <div>
                        <strong>{skill.name}</strong>
                        <small>{skill.description || skill.id}</small>
                        <small className={effective ? 'resource-effective' : 'resource-unavailable'}>
                          {t(effective ? 'skillEffective' : 'skillNotEffective')}
                        </small>
                      </div>
                      <Select
                        aria-label={t('skillSelection')}
                        disabled={interactionLocked}
                        value={resourceSelectionMode(projectSkillDraft, skill.id)}
                        onChange={(_, data) => setProjectSkillDraft((current) => updateResourceSelection(
                          current,
                          skill.id,
                          data.value as ResourceSelectionMode,
                        ))}
                      >
                        <option value="inherit">{t('skillSelectionInherit')}</option>
                        <option value="enabled">{t('skillSelectionEnabled')}</option>
                        <option value="disabled">{t('skillSelectionDisabled')}</option>
                      </Select>
                    </div>
                  )
                })}
              </section>
            )}
            {projectSettingsTab === 'knowledgeBases' && (
              <section className="skill-selection-list">
                <p className="settings-description">{t('projectKnowledgeBaseSelectionDescription')}</p>
                {knowledgeBases.length === 0 ? (
                  <p className="status">{t('noKnowledgeBases')}</p>
                ) : knowledgeBases.map((knowledgeBase) => {
                  const effective = resolveEffectiveResourceIds(config.defaultKnowledgeBaseIds, projectKnowledgeBaseDraft).includes(knowledgeBase.id)
                  return (
                    <div className="skill-selection-row" key={knowledgeBase.id}>
                      <div>
                        <strong>{knowledgeBase.name}</strong>
                        <small>{t(knowledgeBase.mode === 'rg' ? 'knowledgeBaseModeRg' : 'knowledgeBaseModeRag')} · {knowledgeBase.source.path}</small>
                        <small className={effective ? 'resource-effective' : 'resource-unavailable'}>
                          {t(effective ? 'knowledgeBaseEffective' : 'knowledgeBaseNotEffective')}
                        </small>
                      </div>
                      <Select
                        aria-label={t('knowledgeBaseSelection')}
                        disabled={interactionLocked}
                        value={resourceSelectionMode(projectKnowledgeBaseDraft, knowledgeBase.id)}
                        onChange={(_, data) => setProjectKnowledgeBaseDraft((current) => updateResourceSelection(
                          current,
                          knowledgeBase.id,
                          data.value as ResourceSelectionMode,
                        ))}
                      >
                        <option value="inherit">{t('knowledgeBaseSelectionInherit')}</option>
                        <option value="enabled">{t('knowledgeBaseSelectionEnabled')}</option>
                        <option value="disabled">{t('knowledgeBaseSelectionDisabled')}</option>
                      </Select>
                    </div>
                  )
                })}
              </section>
            )}
            {settingsError && <p className="dialog-error">{settingsError}</p>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setProjectSettingsOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              appearance="primary"
              disabled={interactionLocked || saving || !projectSettingsValid}
              onClick={() => void saveProjectSettings()}
            >
              {saving ? t('saving') : t('save')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
