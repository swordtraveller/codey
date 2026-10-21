import {
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  Tab,
  TabList,
} from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import type {
  AppConfig,
  ContextManagementConfig,
  InstalledSkill,
  KnowledgeBase,
  ModelConfig,
  ModelGroupConfig,
  ModelLink,
  RuntimeModelConfig,
  ShellDetectionResult,
  Wsl2ManualConfig,
} from '../../../shared/types'
import {
  AgentLimitsFields,
  CommandExecutionEditorFields,
  CommandReviewEditor,
  environmentLabels,
  interpreterLabels,
} from './CommandReviewSettings'
import { ContextSettingsFields } from './ContextSettingsFields'

export type GlobalSettingsTab = 'model' | 'agentLimits' | 'command' | 'context' | 'skills' | 'knowledgeBases'

export type GlobalSettingsPanelProps = {
  selectedTab: GlobalSettingsTab
  onTabSelect: (tab: GlobalSettingsTab) => void
  configDraft: AppConfig
  onConfigDraftChange: (updater: (current: AppConfig) => AppConfig) => void
  interactionLocked: boolean
  sortedModelGroups: ModelGroupConfig[]
  sortedModels: ModelLink[]
  flatModelConfigs: ModelConfig[]
  onOpenSyntaxHelp: () => void
  shellDetection: ShellDetectionResult | null
  shellDetectBusy: boolean
  onRunShellDetection: () => void
  onPickBashExecutable: () => void
  wsl2ConfigOpen: boolean
  onOpenWsl2Config: () => void
  wslDistros: string[]
  wsl2Draft: Wsl2ManualConfig
  wsl2ConfigBusy: boolean
  onWsl2DraftChange: (patch: Partial<Wsl2ManualConfig>) => void
  onSaveWsl2Config: () => void
  onClearWsl2Config: () => void
  onCloseWsl2Config: () => void
  installedSkills: InstalledSkill[]
  knowledgeBases: KnowledgeBase[]
  contextModelTargets: Array<{ id: string; label: string }>
  contextActiveModelConfigId: string | null
  contextReferenceModel?: RuntimeModelConfig
  contextValue: ContextManagementConfig
  onContextModelConfigChange: (modelConfigId: string) => void
  onContextChange: (patch: Partial<ContextManagementConfig>) => void
}

export function GlobalSettingsPanel({
  selectedTab,
  onTabSelect,
  configDraft,
  onConfigDraftChange,
  interactionLocked,
  sortedModelGroups,
  sortedModels,
  flatModelConfigs,
  onOpenSyntaxHelp,
  shellDetection,
  shellDetectBusy,
  onRunShellDetection,
  onPickBashExecutable,
  wsl2ConfigOpen,
  onOpenWsl2Config,
  wslDistros,
  wsl2Draft,
  wsl2ConfigBusy,
  onWsl2DraftChange,
  onSaveWsl2Config,
  onClearWsl2Config,
  onCloseWsl2Config,
  installedSkills,
  knowledgeBases,
  contextModelTargets,
  contextActiveModelConfigId,
  contextReferenceModel,
  contextValue,
  onContextModelConfigChange,
  onContextChange,
}: GlobalSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <section className="settings-group">
      <TabList
        selectedValue={selectedTab}
        onTabSelect={(_, data) => onTabSelect(data.value as GlobalSettingsTab)}
      >
        <Tab value="model">{t('globalTabModel')}</Tab>
        <Tab value="agentLimits">{t('globalTabAgentLimits')}</Tab>
        <Tab value="command">{t('globalTabCommand')}</Tab>
        <Tab value="context">{t('globalTabContext')}</Tab>
        <Tab value="skills">{t('skills')}</Tab>
        <Tab value="knowledgeBases">{t('knowledgeBases')}</Tab>
      </TabList>

      {selectedTab === 'model' && (
        <Field label={t('defaultModelTarget')} hint={t('defaultModelTargetHint')}>
          <Select
            aria-label={t('defaultModelTarget')}
            value={configDraft.activeModelConfigId ?? ''}
            onChange={(_, data) => onConfigDraftChange((current) => ({
              ...current,
              activeModelConfigId: data.value || null,
            }))}
          >
            <option value="">{t('notConfigured')}</option>
            {sortedModelGroups.map((group) => (
              <option key={group.id} value={group.id}>
                {t('modelGroupOption', { name: group.name || t('unnamedModelGroup') })}
              </option>
            ))}
            {sortedModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name || t('unnamedModel')}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {selectedTab === 'agentLimits' && (
        <AgentLimitsFields
          value={configDraft.agentLimitsGlobal}
          disabled={interactionLocked}
          onChange={(patch) => onConfigDraftChange((current) => ({
            ...current,
            agentLimitsGlobal: { ...current.agentLimitsGlobal, ...patch },
          }))}
        />
      )}

      {selectedTab === 'command' && (
        <>
          <div className="command-execution-global-group">
            <h3>{t('globalCommandExecution')}</h3>
            <CommandExecutionEditorFields
              value={configDraft.commandExecutionGlobal}
              onChange={(next) => onConfigDraftChange((current) => ({
                ...current,
                commandExecutionGlobal: next,
              }))}
              modelConfigs={flatModelConfigs}
              globalReview={configDraft.commandReviewGlobal}
              onOpenSyntaxHelp={onOpenSyntaxHelp}
              showReview={false}
            />
          </div>
          <div className="command-review-global-group">
            <h3>{t('globalCommandReview')}</h3>
            <p className="settings-description">{t('globalCommandReviewDescription')}</p>
            <CommandReviewEditor
              value={configDraft.commandReviewGlobal}
              modelConfigs={flatModelConfigs}
              onOpenSyntaxHelp={onOpenSyntaxHelp}
              onChange={(next) => onConfigDraftChange((current) => ({
                ...current,
                commandReviewGlobal: next,
              }))}
            />
          </div>
          <div className="shell-detection-group">
            <h3>{t('environmentDetection')}</h3>
            <Button appearance="secondary" disabled={shellDetectBusy} onClick={onRunShellDetection}>
              {shellDetectBusy ? t('detectingShells') : t('runEnvironmentDetection')}
            </Button>
            {shellDetection && (
              <div className="shell-detection-results">
                {shellDetection.interpreters.map((entry) => (
                  <p key={entry.kind} className="shell-detection-item">
                    <span>{entry.available ? '✓' : '✗'} {interpreterLabels[entry.kind] ?? entry.kind}</span>
                    <span className="shell-detection-detail">{entry.detail}</span>
                  </p>
                ))}
                {shellDetection.environments.map((entry) => (
                  <p key={entry.kind} className="shell-detection-item">
                    <span>{entry.available ? '✓' : '✗'} {environmentLabels[entry.kind] ?? entry.kind}</span>
                    <span className="shell-detection-detail">{entry.detail}</span>
                  </p>
                ))}
                <Button appearance="subtle" size="small" onClick={onPickBashExecutable}>
                  {t('pickBashExecutable')}
                </Button>
                <div className="wsl2-config-group">
                  <Button appearance="subtle" size="small" disabled={wsl2ConfigBusy} onClick={onOpenWsl2Config}>
                    {t('configureWsl2')}
                  </Button>
                  {wsl2ConfigOpen && (
                    <div className="wsl2-config-form">
                      {wslDistros.length > 0 ? (
                        <Field label={t('wsl2Distro')}>
                          <Select
                            disabled={wsl2ConfigBusy}
                            value={wsl2Draft.distro}
                            onChange={(_, data) => onWsl2DraftChange({ distro: data.value })}
                          >
                            {wslDistros.map((distro) => (
                              <option key={distro} value={distro}>{distro}</option>
                            ))}
                          </Select>
                        </Field>
                      ) : (
                        <p className="settings-warning" role="alert">{t('wsl2NoUserDistro')}</p>
                      )}
                      <Field label={t('wsl2SandboxUser')} hint={t('wsl2SandboxUserHint')}>
                        <Input
                          disabled={wsl2ConfigBusy || wslDistros.length === 0}
                          value={wsl2Draft.sandboxUser}
                          onChange={(_, data) => onWsl2DraftChange({ sandboxUser: data.value })}
                        />
                      </Field>
                      <div className="wsl2-config-actions">
                        <Button
                          appearance="secondary"
                          size="small"
                          disabled={wsl2ConfigBusy || wslDistros.length === 0 || !wsl2Draft.distro || !wsl2Draft.sandboxUser.trim()}
                          onClick={onSaveWsl2Config}
                        >
                          {t('save')}
                        </Button>
                        <Button appearance="subtle" size="small" disabled={wsl2ConfigBusy} onClick={onClearWsl2Config}>
                          {t('wsl2ClearConfig')}
                        </Button>
                        <Button appearance="subtle" size="small" onClick={onCloseWsl2Config}>
                          {t('close')}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                {shellDetection.wsl2Sandbox && (
                  <div className="wsl2-sandbox-probe">
                    <p className="shell-detection-item">
                      <span>{shellDetection.wsl2Sandbox.bwrapAvailable ? '✓' : '✗'} bwrap</span>
                      <span className="shell-detection-detail">{shellDetection.wsl2Sandbox.bwrapAvailable ? t('wsl2BwrapOk') : t('wsl2BwrapMissing')}</span>
                    </p>
                    <p className="shell-detection-item">
                      <span>{shellDetection.wsl2Sandbox.socatAvailable ? '✓' : '✗'} socat</span>
                      <span className="shell-detection-detail">{shellDetection.wsl2Sandbox.socatAvailable ? t('wsl2SocatOk') : t('wsl2SocatMissing')}</span>
                    </p>
                    <p className="shell-detection-item">
                      <span>{shellDetection.wsl2Sandbox.interopEnabled ? '✗' : '✓'} interop</span>
                      <span className="shell-detection-detail">{shellDetection.wsl2Sandbox.interopEnabled ? t('wsl2InteropWarning') : t('wsl2InteropOk')}</span>
                    </p>
                    {shellDetection.wsl2Sandbox.interopEnabled && (
                      <p className="settings-warning" role="alert">{t('wsl2InteropHighRisk')}</p>
                    )}
                    {!shellDetection.wsl2Sandbox.socatAvailable && (
                      <p className="settings-warning" role="alert">{t('wsl2SocatHighRisk')}</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {selectedTab === 'skills' && (
        <div className="skill-selection-list">
          <p className="settings-description">{t('globalSkillSelectionDescription')}</p>
          {installedSkills.length === 0 ? (
            <p className="settings-description">{t('noInstalledSkills')}</p>
          ) : installedSkills.map((skill) => (
            <label className="skill-selection-row" key={skill.id}>
              <Checkbox
                checked={configDraft.defaultSkillIds.includes(skill.id)}
                disabled={interactionLocked}
                onChange={(_, data) => onConfigDraftChange((current) => ({
                  ...current,
                  defaultSkillIds: data.checked === true
                    ? [...new Set([...current.defaultSkillIds, skill.id])]
                    : current.defaultSkillIds.filter((id) => id !== skill.id),
                }))}
              />
              <span>
                <strong>{skill.name}</strong>
                <small>{skill.description || skill.sourceUrl}</small>
              </span>
            </label>
          ))}
        </div>
      )}

      {selectedTab === 'knowledgeBases' && (
        <div className="skill-selection-list">
          <p className="settings-description">{t('globalKnowledgeBaseSelectionDescription')}</p>
          {knowledgeBases.length === 0 ? (
            <p className="settings-description">{t('noKnowledgeBases')}</p>
          ) : knowledgeBases.map((knowledgeBase) => (
            <label className="skill-selection-row" key={knowledgeBase.id}>
              <Checkbox
                checked={configDraft.defaultKnowledgeBaseIds.includes(knowledgeBase.id)}
                disabled={interactionLocked}
                onChange={(_, data) => onConfigDraftChange((current) => ({
                  ...current,
                  defaultKnowledgeBaseIds: data.checked === true
                    ? [...new Set([...current.defaultKnowledgeBaseIds, knowledgeBase.id])]
                    : current.defaultKnowledgeBaseIds.filter((id) => id !== knowledgeBase.id),
                }))}
              />
              <span>
                <strong>{knowledgeBase.name}</strong>
                <small>{t(knowledgeBase.mode === 'rg' ? 'knowledgeBaseModeRg' : 'knowledgeBaseModeRag')} · {knowledgeBase.source.path}</small>
                <small className={knowledgeBase.status === 'ready' ? 'resource-effective' : 'resource-unavailable'}>
                  {t(`knowledgeBaseStatus_${knowledgeBase.status.replace('-', '_')}`)}
                </small>
              </span>
            </label>
          ))}
        </div>
      )}

      {selectedTab === 'context' && (
        <ContextSettingsFields
          modelTargets={contextModelTargets}
          activeModelConfigId={contextActiveModelConfigId}
          referenceModel={contextReferenceModel}
          onModelConfigChange={onContextModelConfigChange}
          value={contextValue}
          disabled={interactionLocked}
          onChange={onContextChange}
        />
      )}
    </section>
  )
}
