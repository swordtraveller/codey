import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Select,
  Switch,
} from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import type {
  AppConfig,
  InstalledSkill,
  KnowledgeBase,
  ModelConfig,
  Project,
  Conversation,
} from '../../../shared/types'
import { resolveModelTarget } from '../../../shared/model-targets'
import { ContextSettingsFields } from './ContextSettingsFields'
import {
  AgentLimitsFields,
  CommandExecutionEditorFields,
  isValidAgentLimits,
  isValidCommandExecutionDraft,
} from './CommandReviewSettings'
import {
  resourceSelectionMode,
  updateResourceSelection,
  resolveEffectiveResourceIds,
  type ResourceSelectionMode,
} from '../resource-selection'
import type { useConversationSettings } from '../hooks/useConversationSettings'

type ConversationSettingsDialogsProps = {
  settings: ReturnType<typeof useConversationSettings>
  config: AppConfig
  installedSkills: InstalledSkill[]
  knowledgeBases: KnowledgeBase[]
  flatModelConfigs: ModelConfig[]
  effectiveModelConfig: ReturnType<typeof resolveModelTarget>
  interactionLocked: boolean
  saving: boolean
  settingsError: string
  openCommandRulesHelp: () => void
  projects: Project[]
  activeProject?: Project
  activeConversation?: Conversation
  skillBusy: boolean
  skillError: string
  knowledgeBaseBusy: boolean
  knowledgeBaseError: string
}

export function ConversationSettingsDialogs({
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
  projects,
  activeProject,
  activeConversation,
  skillBusy,
  skillError,
  knowledgeBaseBusy,
  knowledgeBaseError,
}: ConversationSettingsDialogsProps) {
  const { t } = useTranslation()
  const {
    conversationSkillsOpen,
    setConversationSkillsOpen,
    conversationSkillDraft,
    setConversationSkillDraft,
    conversationKnowledgeBasesOpen,
    setConversationKnowledgeBasesOpen,
    conversationKnowledgeBaseDraft,
    setConversationKnowledgeBaseDraft,
    contextDialogOpen,
    setContextDialogOpen,
    contextScope,
    contextProjectId,
    contextOverrideEnabled,
    setContextOverrideEnabled,
    contextDraft,
    agentLimitsDialogOpen,
    setAgentLimitsDialogOpen,
    agentLimitsDraft,
    setAgentLimitsDraft,
    agentLimitsOverride,
    setAgentLimitsOverride,
    commandDialogOpen,
    setCommandDialogOpen,
    commandOverride,
    setCommandOverride,
    commandDraft,
    setCommandDraft,
    saveConversationSkills,
    saveConversationKnowledgeBases,
    updateContextDraft,
    changeContextModelConfig,
    saveContextSettings,
    saveAgentLimitsSettings,
    saveCommandExecutionSettings,
    invalidContextOverride,
  } = settings

  return (
    <>
      <Dialog
        open={conversationSkillsOpen}
        onOpenChange={(_, data) => setConversationSkillsOpen(data.open)}
      >
        <DialogSurface className="skill-selection-dialog">
          <DialogBody>
            <DialogTitle>{t('skillSelection')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <p className="settings-description">{t('conversationSkillSelectionDescription')}</p>
              <section className="skill-selection-list">
                {installedSkills.length === 0 ? (
                  <p className="status">{t('noInstalledSkills')}</p>
                ) : installedSkills.map((skill) => {
                  const effective = resolveEffectiveResourceIds(
                    config.defaultSkillIds,
                    activeProject?.skillSelection,
                    conversationSkillDraft,
                  ).includes(skill.id)
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
                        disabled={interactionLocked || skillBusy}
                        value={resourceSelectionMode(conversationSkillDraft, skill.id)}
                        onChange={(_, data) => setConversationSkillDraft((current) => updateResourceSelection(
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
              {skillError && <p className="dialog-error">{skillError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={skillBusy} onClick={() => setConversationSkillsOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={interactionLocked || skillBusy}
                onClick={() => void saveConversationSkills()}
              >
                {skillBusy ? t('saving') : t('save')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={conversationKnowledgeBasesOpen}
        onOpenChange={(_, data) => setConversationKnowledgeBasesOpen(data.open)}
      >
        <DialogSurface className="skill-selection-dialog">
          <DialogBody>
            <DialogTitle>{t('knowledgeBaseSelection')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <p className="settings-description">{t('conversationKnowledgeBaseSelectionDescription')}</p>
              <section className="skill-selection-list">
                {knowledgeBases.length === 0 ? (
                  <p className="status">{t('noKnowledgeBases')}</p>
                ) : knowledgeBases.map((knowledgeBase) => {
                  const effective = resolveEffectiveResourceIds(
                    config.defaultKnowledgeBaseIds,
                    activeProject?.knowledgeBaseSelection,
                    conversationKnowledgeBaseDraft,
                  ).includes(knowledgeBase.id)
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
                        disabled={interactionLocked || knowledgeBaseBusy}
                        value={resourceSelectionMode(conversationKnowledgeBaseDraft, knowledgeBase.id)}
                        onChange={(_, data) => setConversationKnowledgeBaseDraft((current) => updateResourceSelection(
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
              {knowledgeBaseError && <p className="dialog-error">{knowledgeBaseError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={knowledgeBaseBusy} onClick={() => setConversationKnowledgeBasesOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={interactionLocked || knowledgeBaseBusy}
                onClick={() => void saveConversationKnowledgeBases()}
              >
                {knowledgeBaseBusy ? t('saving') : t('save')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={agentLimitsDialogOpen} onOpenChange={(_, data) => setAgentLimitsDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('conversationAgentLimits')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <Switch
                checked={agentLimitsOverride}
                disabled={interactionLocked}
                label={t('agentLimitsOverrideProject')}
                onChange={(_, data) => setAgentLimitsOverride(data.checked)}
              />
              <AgentLimitsFields
                value={agentLimitsDraft}
                disabled={interactionLocked || !agentLimitsOverride}
                onChange={(patch) => setAgentLimitsDraft((current) => ({ ...current, ...patch }))}
              />
              {settingsError && <p className="dialog-error">{settingsError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAgentLimitsDialogOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={interactionLocked || saving || (agentLimitsOverride && !isValidAgentLimits(agentLimitsDraft))}
                onClick={() => void saveAgentLimitsSettings()}
              >
                {saving ? t('saving') : t('save')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={commandDialogOpen} onOpenChange={(_, data) => setCommandDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('commandAndReviewSettings')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <Switch
                checked={commandOverride}
                disabled={interactionLocked}
                label={t('commandOverrideProject')}
                onChange={(_, data) => setCommandOverride(data.checked)}
              />
              <CommandExecutionEditorFields
                value={commandDraft}
                onChange={setCommandDraft}
                disabled={interactionLocked || !commandOverride}
                modelConfigs={flatModelConfigs}
                sessionModel={effectiveModelConfig}
                globalReview={config.commandReviewGlobal}
                onOpenSyntaxHelp={openCommandRulesHelp}
              />
              {settingsError && <p className="dialog-error">{settingsError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCommandDialogOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={interactionLocked || saving || !isValidCommandExecutionDraft(commandDraft)}
                onClick={() => void saveCommandExecutionSettings()}
              >
                {saving ? t('saving') : t('save')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={contextDialogOpen} onOpenChange={(_, data) => setContextDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              {contextScope === 'project' ? t('projectContextSettings') : t('conversationContextSettings')}
            </DialogTitle>
            <DialogContent className="dialog-fields">
              <Switch
                checked={contextOverrideEnabled}
                disabled={interactionLocked}
                label={contextScope === 'project' ? t('overrideApplicationContext') : t('overrideProjectContext')}
                onChange={(_, data) => setContextOverrideEnabled(data.checked)}
              />
              <ContextSettingsFields
                disabled={interactionLocked || !contextOverrideEnabled}
                modelDisabled={interactionLocked}
                showCustomStrategy={config.developerMode && contextScope === 'conversation' && contextOverrideEnabled}
                modelTargets={[
                  ...config.models.map((model) => ({ id: model.id, label: model.name || t('unnamedModel') })),
                  ...config.modelGroups.map((group) => ({ id: group.id, label: t('modelGroupOption', { name: group.name || t('unnamedModelGroup') }) })),
                ]}
                referenceModel={resolveModelTarget(config, contextScope === 'conversation'
                  ? (activeConversation?.modelConfigId ?? activeProject?.defaultModelConfigId ?? config.activeModelConfigId)
                  : (projects.find((project) => project.id === contextProjectId)?.defaultModelConfigId ?? config.activeModelConfigId))}
                activeModelConfigId={contextScope === 'conversation'
                  ? activeConversation?.modelConfigId ?? ''
                  : projects.find((project) => project.id === contextProjectId)?.defaultModelConfigId ?? ''}
                emptyModelOptionLabel={t(contextScope === 'conversation' ? 'followProjectDefault' : 'applicationDefault')}
                onModelConfigChange={(modelConfigId) => void changeContextModelConfig(modelConfigId)}
                value={contextDraft}
                onChange={updateContextDraft}
              />
              {settingsError && <p className="dialog-error">{settingsError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setContextDialogOpen(false)}>
                {t('cancel')}
              </Button>
              <Button appearance="primary" disabled={interactionLocked || saving || invalidContextOverride} onClick={() => void saveContextSettings()}>
                {saving ? t('saving') : t('save')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  )
}
