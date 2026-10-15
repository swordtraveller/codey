import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Select,
  Switch,
} from '@fluentui/react-components'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentLimitsConfig,
  CommandApprovalMemory,
  CommandApprovalRequest,
  CommandExecutionConfig,
  CommandReviewConfig,
  CommandReviewRule,
  ModelConfig,
} from '../../../shared/types'
import { findConflictingRule, isValidGlobPattern, validateCommandReviewConfig } from '../../../shared/command-rules'
import { commandExecutionSupported, maximumAgentLimit } from '../../../shared/types'

export const interpreterLabels: Record<string, string> = {
  bash: 'bash',
  pwsh7: 'pwsh 7',
  pwsh51: 'pwsh 5.1',
}

export const environmentLabels: Record<string, string> = {
  bare: 'bare',
  wsl2: 'wsl2',
  docker: 'docker',
  'windows-sandbox': 'Windows Sandbox',
}

function listEnabledCombos(enabledEnvironments: CommandExecutionConfig['enabledEnvironments']): Array<{
  interpreter: CommandExecutionConfig['interpreter']
  environment: CommandExecutionConfig['environment']
}> {
  return (['bash', 'pwsh7', 'pwsh51'] as const).flatMap((interpreter) =>
    (['bare', 'wsl2', 'docker'] as const)
      .filter((environment) => enabledEnvironments[interpreter]?.includes(environment) ?? false)
      .map((environment) => ({ interpreter, environment })),
  )
}

function formatCommandDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${rest}s`
}

export function isValidAgentLimits(value: AgentLimitsConfig): boolean {
  return Number.isInteger(value.modelRequestsPerRound) &&
    value.modelRequestsPerRound >= 1 && value.modelRequestsPerRound <= maximumAgentLimit &&
    Number.isInteger(value.toolCallsPerRequest) &&
    value.toolCallsPerRequest >= 1 && value.toolCallsPerRequest <= maximumAgentLimit
}

export function isValidCommandExecutionDraft(draft: CommandExecutionConfig | null): boolean {
  if (draft === null) return true
  if (!commandExecutionSupported(draft.interpreter, draft.environment)) return false
  // The session default combo must be within the enabled combos.
  if (!(draft.enabledEnvironments[draft.interpreter] ?? []).includes(draft.environment)) return false
  // Every enabled combo must be supported.
  for (const [interpreter, environments] of Object.entries(draft.enabledEnvironments)) {
    for (const environment of environments) {
      if (!commandExecutionSupported(interpreter as CommandExecutionConfig['interpreter'], environment)) return false
    }
  }
  if (draft.review !== null && !validateCommandReviewConfig(draft.review)) return false
  return true
}

/** Shared Agent-limits fields for the three settings surfaces (global,
 * project, conversation). */
export function AgentLimitsFields({ value, disabled, onChange }: {
  value: AgentLimitsConfig
  disabled?: boolean
  onChange: (patch: Partial<AgentLimitsConfig>) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <Field label={t('modelRequestsPerRound')} hint={t('modelRequestsPerRoundHint')} required>
        <Input
          disabled={disabled}
          min={1}
          max={maximumAgentLimit}
          type="number"
          value={String(value.modelRequestsPerRound)}
          onChange={(_, data) => onChange({ modelRequestsPerRound: Number(data.value) })}
        />
      </Field>
      <Field label={t('toolCallsPerRequest')} hint={t('toolCallsPerRequestHint')} required>
        <Input
          disabled={disabled}
          min={1}
          max={maximumAgentLimit}
          type="number"
          value={String(value.toolCallsPerRequest)}
          onChange={(_, data) => onChange({ toolCallsPerRequest: Number(data.value) })}
        />
      </Field>
    </>
  )
}

/** Shared command-execution editor (flat: execution + review sections) for
 * the conversation dialog and the project settings dialog. The override
 * switch (null = inherit) lives in the caller. */
export function CommandExecutionEditorFields({ value, onChange, disabled, modelConfigs, sessionModel, globalReview, onOpenSyntaxHelp, showReview = true }: {
  value: CommandExecutionConfig
  onChange: (next: CommandExecutionConfig) => void
  disabled?: boolean
  modelConfigs: ModelConfig[]
  sessionModel?: ModelConfig
  globalReview: CommandReviewConfig
  onOpenSyntaxHelp?: () => void
  showReview?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const setDraft = (next: CommandExecutionConfig): void => onChange(next)
  const enabledCombos = listEnabledCombos(value.enabledEnvironments)
  const defaultInEnabled = enabledCombos.some(
    (combo) => combo.interpreter === value.interpreter && combo.environment === value.environment,
  )
  return (
    <>
      <Switch
        checked={value.enabled}
        disabled={disabled}
        label={t('commandExecutionEnabled')}
        onChange={(_, data) => setDraft({ ...value, enabled: data.checked })}
      />
      <p className="settings-description">{t('commandExecutionDescription')}</p>
      <div className="enabled-environments-group">
        <p className="section-label">{t('enabledEnvironments')}</p>
        <p className="settings-description">{t('enabledEnvironmentsHint')}</p>
        {(['bash', 'pwsh7', 'pwsh51'] as const).map((interpreter) => (
          <div className="enabled-environments-row" key={interpreter}>
            <span className="enabled-environments-label">
              {interpreterLabels[interpreter] ?? interpreter}
            </span>
            {(['bare', 'wsl2', 'docker'] as const).map((environment) => {
              if (interpreter === 'pwsh51' && environment === 'wsl2') return null
              return (
                <label className="enabled-environments-check" key={environment}>
                  <input
                    type="checkbox"
                    disabled={disabled || !value.enabled}
                    checked={value.enabledEnvironments[interpreter]?.includes(environment) ?? false}
                    onChange={(event) => {
                      const current = value.enabledEnvironments[interpreter] ?? []
                      const next = event.target.checked
                        ? [...current, environment]
                        : current.filter((entry) => entry !== environment)
                      const enabledEnvironments = { ...value.enabledEnvironments, [interpreter]: next }
                      const draft: CommandExecutionConfig = { ...value, enabledEnvironments }
                      // Keep the default combo inside the enabled set.
                      if (!(enabledEnvironments[draft.interpreter] ?? []).includes(draft.environment)) {
                        const fallback = listEnabledCombos(enabledEnvironments)[0]
                        if (fallback) {
                          draft.interpreter = fallback.interpreter
                          draft.environment = fallback.environment
                        }
                      }
                      setDraft(draft)
                    }}
                  />
                  {environmentLabels[environment] ?? environment}
                </label>
              )
            })}
          </div>
        ))}
      </div>
      <Field label={t('commandDefaultCombo')}>
        <Select
          disabled={disabled || !value.enabled || enabledCombos.length === 0}
          value={defaultInEnabled ? `${value.interpreter}|${value.environment}` : ''}
          onChange={(_, data) => {
            const [interpreter, environment] = String(data.value ?? '').split('|')
            if (!interpreter || !environment) return
            setDraft({
              ...value,
              interpreter: interpreter as CommandExecutionConfig['interpreter'],
              environment: environment as CommandExecutionConfig['environment'],
            })
          }}
        >
          {!defaultInEnabled && <option value="" disabled>{t('commandDefaultComboNone')}</option>}
          {enabledCombos.map((combo) => (
            <option key={`${combo.interpreter}|${combo.environment}`} value={`${combo.interpreter}|${combo.environment}`}>
              {`${interpreterLabels[combo.interpreter] ?? combo.interpreter} / ${environmentLabels[combo.environment] ?? combo.environment}`}
            </option>
          ))}
        </Select>
      </Field>
      <p className="settings-description">{t('commandDefaultComboHint')}</p>
      {value.enabled && !defaultInEnabled && (
        <p className="settings-warning" role="alert">{t('commandDefaultComboInvalid')}</p>
      )}
      {showReview && (
        <>
          <Switch
            checked={value.review !== null}
            disabled={disabled}
            label={t('reviewOverrideGlobal')}
            onChange={(_, data) => setDraft({
              ...value,
              review: data.checked
                ? structuredClone(value.review ?? globalReview)
                : null,
            })}
          />
          {value.review === null ? (
            <p className="settings-description">{t('reviewFollowingGlobal')}</p>
          ) : (
            <CommandReviewEditor
              value={value.review}
              disabled={disabled}
              modelConfigs={modelConfigs}
              sessionModel={sessionModel}
              onOpenSyntaxHelp={onOpenSyntaxHelp}
              onChange={(next) => setDraft({ ...value, review: next })}
            />
          )}
        </>
      )}
    </>
  )
}

/** Shared review editor for the three settings surfaces (global, project,
 * conversation): duration gate, reviewer checkboxes, rule list. */
export function CommandReviewEditor({ value, onChange, disabled, modelConfigs, sessionModel, onOpenSyntaxHelp }: {
  value: CommandReviewConfig
  onChange: (next: CommandReviewConfig) => void
  disabled?: boolean
  modelConfigs: ModelConfig[]
  sessionModel?: ModelConfig
  onOpenSyntaxHelp?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [newPattern, setNewPattern] = useState('')
  const [newList, setNewList] = useState<'allow' | 'deny'>('deny')
  const newPatternInvalid = newPattern.trim() !== '' && !isValidGlobPattern(newPattern)
  const newPatternConflict = newPattern.trim() !== '' && Boolean(findConflictingRule(value.contentRules, { pattern: newPattern, list: newList }))
  const auditModel = value.reviewers.auditModelConfigId
    ? modelConfigs.find((model) => model.id === value.reviewers.auditModelConfigId)
    : undefined
  const updateRule = (id: string, patch: Partial<CommandReviewRule>): void => {
    onChange({ ...value, contentRules: value.contentRules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule) })
  }
  const removeRule = (id: string): void => {
    onChange({ ...value, contentRules: value.contentRules.filter((rule) => rule.id !== id) })
  }
  const addRule = (): void => {
    const pattern = newPattern.trim()
    if (!pattern || newPatternInvalid) return
    onChange({
      ...value,
      contentRules: [
        ...value.contentRules.filter((rule) => rule.pattern.trim().toLowerCase() !== pattern.toLowerCase()),
        { id: crypto.randomUUID(), pattern, patternType: 'glob', list: newList, source: 'user', enabled: true, createdAt: new Date().toISOString() },
      ],
    })
    setNewPattern('')
  }
  return (
    <div className="command-review-editor">
      <Field label={t('reviewDurationGate')} hint={t('reviewDurationGateHint')}>
        <Input
          type="number"
          min={1}
          max={1_440}
          disabled={disabled}
          value={String(Math.round(value.durationAllowSeconds / 60))}
          onChange={(_, data) => {
            const minutes = Math.floor(Number(data.value))
            if (!Number.isFinite(minutes)) return
            onChange({ ...value, durationAllowSeconds: Math.min(1_440, Math.max(1, minutes)) * 60 })
          }}
        />
      </Field>
      <p className="settings-description">{t('reviewDurationGateUnit')}</p>

      <p className="section-label">{t('reviewReviewers')}</p>
      <Switch checked disabled label={t('reviewProgramRules')} />
      <p className="settings-description">{t('reviewProgramRulesNote')}</p>
      <Switch
        checked={value.reviewers.auditModel}
        disabled={disabled}
        label={t('commandModelAudit')}
        onChange={(_, data) => onChange({ ...value, reviewers: { ...value.reviewers, auditModel: data.checked } })}
      />
      {value.reviewers.auditModel && (
        <Field label={t('commandAuditModel')} hint={t('commandAuditModelHint')}>
          <Select
            disabled={disabled}
            value={value.reviewers.auditModelConfigId ?? ''}
            onChange={(_, data) => onChange({ ...value, reviewers: { ...value.reviewers, auditModelConfigId: data.value || null } })}
          >
            <option value="">{t('notConfigured')}</option>
            {modelConfigs
              .filter((model) => model.id !== sessionModel?.id)
              .map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name || model.modelName || t('unnamedModel')}
                </option>
              ))}
          </Select>
        </Field>
      )}
      {value.reviewers.auditModel && auditModel && sessionModel &&
        auditModel.modelName.trim().toLowerCase() === sessionModel.modelName.trim().toLowerCase() && (
        <p className="settings-warning" role="alert">{t('commandAuditModelConflict')}</p>
      )}
      <Switch
        checked={value.reviewers.manualConfirmation}
        disabled={disabled}
        label={t('commandManualConfirmation')}
        onChange={(_, data) => onChange({ ...value, reviewers: { ...value.reviewers, manualConfirmation: data.checked } })}
      />
      <p className="settings-description">{t('reviewManualConfirmationNote')}</p>

      <p className="section-label">{t('reviewContentRules')}</p>
      {onOpenSyntaxHelp && (
        <Button appearance="subtle" size="small" onClick={onOpenSyntaxHelp}>
          {t('reviewSyntaxHelp')}
        </Button>
      )}
      <div className="command-rules-list">
        {value.contentRules.length === 0 && <p className="settings-description">{t('reviewNoRules')}</p>}
        {value.contentRules.map((rule) => {
          const conflict = findConflictingRule(value.contentRules, rule)
          return (
            <div className="command-rule-row" key={rule.id}>
              <input
                aria-label={t('reviewRuleEnabled')}
                type="checkbox"
                checked={rule.enabled}
                disabled={disabled}
                onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })}
              />
              <input
                aria-label={t('reviewRulePattern')}
                className="command-rule-pattern"
                type="text"
                value={rule.pattern}
                disabled={disabled}
                onChange={(event) => updateRule(rule.id, { pattern: event.target.value })}
              />
              <Select
                aria-label={t('reviewRuleList')}
                disabled={disabled}
                value={rule.list}
                onChange={(_, data) => updateRule(rule.id, { list: data.value as 'allow' | 'deny' })}
              >
                <option value="deny">{t('reviewRuleDeny')}</option>
                <option value="allow">{t('reviewRuleAllow')}</option>
              </Select>
              <span className={`command-rule-source source-${rule.source}`} title={rule.patternType === 'regex' ? t('reviewRuleRegex') : undefined}>
                {t(`reviewSource_${rule.source}`)}
              </span>
              <Button appearance="subtle" size="small" disabled={disabled} onClick={() => removeRule(rule.id)}>
                {t('reviewRuleDelete')}
              </Button>
              {conflict && <p className="settings-warning" role="alert">{t('reviewRuleConflict')}</p>}
            </div>
          )
        })}
      </div>
      {!disabled && (
        <div className="command-rule-add">
          <Input
            aria-label={t('reviewNewRulePattern')}
            placeholder="git *"
            type="text"
            value={newPattern}
            onChange={(_, data) => setNewPattern(data.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addRule()
            }}
          />
          <Select
            aria-label={t('reviewNewRuleList')}
            value={newList}
            onChange={(_, data) => setNewList(data.value as 'allow' | 'deny')}
          >
            <option value="deny">{t('reviewRuleDeny')}</option>
            <option value="allow">{t('reviewRuleAllow')}</option>
          </Select>
          <Button appearance="secondary" disabled={newPatternInvalid || newPattern.trim() === ''} onClick={addRule}>
            {t('reviewRuleAdd')}
          </Button>
        </div>
      )}
      {newPatternInvalid && <p className="settings-warning" role="alert">{t('reviewRulePatternInvalid')}</p>}
      {newPatternConflict && <p className="settings-warning" role="alert">{t('reviewRuleConflict')}</p>}
    </div>
  )
}

/** In-app approval card shown when run_command needs manual review. */
export function CommandApprovalDialog({ request, onRespond, onOpenSyntaxHelp }: {
  request: CommandApprovalRequest
  onRespond: (approved: boolean, memory?: CommandApprovalMemory) => void
  onOpenSyntaxHelp: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [remember, setRemember] = useState(false)
  const [patternType, setPatternType] = useState<'exact' | 'prefix'>('exact')
  const [scope, setScope] = useState<'turn' | 'session' | 'project' | 'global'>('project')
  const [list, setList] = useState<'allow' | 'deny'>('allow')
  useEffect(() => {
    setRemember(false)
    setPatternType('exact')
    setScope('project')
    setList('allow')
  }, [request.requestId])
  const checkLabels: Record<string, string> = {
    rules: t('approvalCheckRules'),
    'model-audit': t('approvalCheckModelAudit'),
    'manual-confirmation': t('approvalCheckManual'),
  }
  const checksText = request.checks.map((check) => checkLabels[check] ?? check).join(', ')
  const respond = (approved: boolean): void => {
    onRespond(approved, remember ? { patternType, scope, list } : undefined)
  }
  return (
    <Dialog open modalType="alert" onOpenChange={(_, data) => { if (!data.open) respond(false) }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('approvalTitle')}</DialogTitle>
          <DialogContent className="dialog-fields">
            <p className="settings-description">
              {t('approvalDurationInfo', { duration: formatCommandDuration(request.timeoutSeconds) })}
            </p>
            <pre className="command-approval-command">{request.command}</pre>
            <p className="settings-description">
              {t('approvalEnvironment', { environment: request.environment, workspace: request.workspacePath })}
            </p>
            {request.auditModelName && (
              <p className="settings-description">
                {t('approvalAuditVerdict', {
                  model: request.auditModelName,
                  verdict: request.auditNote?.trim() || t('approvalNoObjection'),
                })}
              </p>
            )}
            {request.checks.length > 0 && (
              <p className="settings-description">{t('approvalChecks', { checks: checksText })}</p>
            )}
            <div className="command-approval-memory">
              <Switch checked={remember} label={t('approvalRemember')} onChange={(_, data) => setRemember(data.checked)} />
              {remember && (
                <>
                  <Field label={t('approvalMemoryPattern')}>
                    <Select value={patternType} onChange={(_, data) => setPatternType(data.value as 'exact' | 'prefix')}>
                      <option value="exact">{t('approvalMemoryExact')}</option>
                      <option value="prefix">{t('approvalMemoryPrefix')}</option>
                    </Select>
                  </Field>
                  <Field label={t('approvalMemoryScope')}>
                    <Select value={scope} onChange={(_, data) => setScope(data.value as typeof scope)}>
                      <option value="turn">{t('approvalScopeTurn')}</option>
                      <option value="session">{t('approvalScopeSession')}</option>
                      <option value="project">{t('approvalScopeProject')}</option>
                      <option value="global">{t('approvalScopeGlobal')}</option>
                    </Select>
                  </Field>
                  <Field label={t('approvalMemoryList')}>
                    <Select value={list} onChange={(_, data) => setList(data.value as 'allow' | 'deny')}>
                      <option value="allow">{t('approvalMemoryAllow')}</option>
                      <option value="deny">{t('approvalMemoryDeny')}</option>
                    </Select>
                  </Field>
                </>
              )}
            </div>
            <Button appearance="subtle" size="small" onClick={onOpenSyntaxHelp}>
              {t('reviewSyntaxHelp')}
            </Button>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => respond(false)}>
              {t('approvalDeny')}
            </Button>
            <Button appearance="primary" onClick={() => respond(true)}>
              {t('approvalApprove')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
