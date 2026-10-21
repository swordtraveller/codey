import {
  Field,
  Input,
  Select,
  Switch,
  Textarea,
} from '@fluentui/react-components'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  deriveContextBudgets,
  type ContextManagementConfig,
  type RuntimeModelConfig,
} from '../../../shared/types'

type ContextStrategyMode = 'default' | 'layered' | 'custom'

function contextStrategyMode(value: ContextManagementConfig, customStrategyAvailable: boolean): ContextStrategyMode {
  if (customStrategyAvailable && value.customStrategyEnabled) return 'custom'
  return value.layeredEnabled ? 'layered' : 'default'
}

export function ContextSettingsFields({
  value,
  disabled = false,
  modelDisabled,
  showCustomStrategy = false,
  modelTargets,
  referenceModel,
  activeModelConfigId,
  emptyModelOptionLabel,
  onModelConfigChange,
  onChange,
}: {
  value: ContextManagementConfig
  disabled?: boolean
  modelDisabled?: boolean
  showCustomStrategy?: boolean
  /** Selectable targets: single models and model groups. */
  modelTargets?: Array<{ id: string; label: string }>
  /** Resolved effective target used for budget derivation. */
  referenceModel?: RuntimeModelConfig
  activeModelConfigId?: string | null
  emptyModelOptionLabel?: string
  onModelConfigChange?: (modelConfigId: string) => void
  onChange: (patch: Partial<ContextManagementConfig>) => void
}): React.JSX.Element {
  const autoBudget = value.autoBudgetEnabled !== false
  const fieldsDisabled = disabled || autoBudget
  const { t } = useTranslation()
  const strategyMode = contextStrategyMode(value, showCustomStrategy)

  function setStrategyMode(mode: ContextStrategyMode): void {
    if (mode === 'custom') {
      onChange({ layeredEnabled: false, customStrategyEnabled: true })
      return
    }
    onChange({
      layeredEnabled: mode === 'layered',
      customStrategyEnabled: false,
    })
  }

  // Auto-apply formula budgets when model changes and autoBudget is enabled
  useEffect(() => {
    if (autoBudget && referenceModel) {
      const budgets = deriveContextBudgets(referenceModel.modelMaxContext, referenceModel.modelMaxOutputTokens)
      onChange({
        ...budgets,
        ...(strategyMode === 'layered' ? { filterEnabled: true, rewriteEnabled: true, truncateEnabled: true, recentKeepRounds: 20 } : {}),
      })
    }
  }, [autoBudget, referenceModel?.id, referenceModel?.modelMaxContext, referenceModel?.modelMaxOutputTokens, strategyMode])

  return (
    <div className="context-settings-fields">
      <Field label={t('contextStrategyMode')}>
        <Select
          disabled={disabled}
          value={strategyMode}
          onChange={(_, data) => setStrategyMode(data.value as ContextStrategyMode)}
        >
          <option value="default">{t('contextStrategyDefault')}</option>
          <option value="layered">{t('contextStrategyLayered')}</option>
          {showCustomStrategy && <option value="custom">{t('contextStrategyCustom')}</option>}
        </Select>
      </Field>

      {modelTargets !== undefined && modelTargets.length > 0 && (
        <>
          <Field label={t('modelConfiguration')}>
            <Select
              disabled={modelDisabled ?? disabled}
              value={activeModelConfigId ?? referenceModel?.id ?? ''}
              onChange={(_, data) => onModelConfigChange?.(data.value)}
            >
              {emptyModelOptionLabel !== undefined && <option value="">{emptyModelOptionLabel}</option>}
              {modelTargets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label}
                </option>
              ))}
            </Select>
          </Field>
          {referenceModel && (
            <div className="model-context-info">
              {t('modelMaxContext', { tokens: referenceModel.modelMaxContext.toLocaleString() })}
            </div>
          )}
        </>
      )}

      {strategyMode === 'custom' ? (
        <>
          <Field label={t('customContextStrategyScript')}>
            <Textarea
              disabled={disabled}
              resize="vertical"
              value={value.customStrategyScript ?? ''}
              onChange={(_, data) => onChange({ customStrategyScript: data.value })}
              placeholder={t('customContextStrategyPlaceholder')}
              rows={12}
              onKeyDown={(event) => {
                if (event.key !== 'Tab') return
                event.preventDefault()
                const textarea = event.currentTarget
                const start = textarea.selectionStart
                const end = textarea.selectionEnd
                const current = value.customStrategyScript ?? ''
                const next = `${current.slice(0, start)}\t${current.slice(end)}`
                onChange({ customStrategyScript: next })
                window.requestAnimationFrame(() => {
                  textarea.selectionStart = start + 1
                  textarea.selectionEnd = start + 1
                })
              }}
            />
          </Field>
          <Field label={t('customContextStrategyPrompt')} hint={t('customContextStrategyPromptHint')}>
            <Textarea
              disabled={disabled}
              resize="vertical"
              value={value.customStrategyPrompt ?? ''}
              onChange={(_, data) => onChange({ customStrategyPrompt: data.value })}
              placeholder={t('customContextStrategyPromptPlaceholder')}
              rows={4}
            />
          </Field>
        </>
      ) : (
        <>
          <Switch
            checked={value.filterEnabled}
            disabled={fieldsDisabled}
            label={t('contextFilter')}
            onChange={(_, data) => onChange({ filterEnabled: data.checked })}
          />
          <Switch
            checked={value.rewriteEnabled}
            disabled={fieldsDisabled}
            label={t('contextRewrite')}
            onChange={(_, data) => onChange({ rewriteEnabled: data.checked })}
          />
          <Switch
            checked={value.truncateEnabled}
            disabled={fieldsDisabled}
            label={t('contextTruncate')}
            onChange={(_, data) => onChange({ truncateEnabled: data.checked })}
          />
          <Field label={t('recentRounds')} required>
            <Input
              disabled={fieldsDisabled}
              max={20}
              min={1}
              type="number"
              value={String(value.recentKeepRounds)}
              onChange={(_, data) => onChange({ recentKeepRounds: Number(data.value) })}
            />
          </Field>
          <Switch
            checked={autoBudget}
            disabled={disabled}
            label={t('contextUseRecommendedValues')}
            onChange={(_, data) => {
              if (data.checked) {
                const budgets = referenceModel ? deriveContextBudgets(referenceModel.modelMaxContext, referenceModel.modelMaxOutputTokens) : {}
                onChange({
                  autoBudgetEnabled: true,
                  ...budgets,
                  ...(strategyMode === 'layered' ? { filterEnabled: true, rewriteEnabled: true, truncateEnabled: true, recentKeepRounds: 20 } : {}),
                })
              } else {
                onChange({ autoBudgetEnabled: false })
              }
            }}
          />
          {strategyMode === 'default' && (
            <Field label={t('maxInputTokens')} hint={t('maxInputTokensHint')}>
              <Input
                disabled={fieldsDisabled}
                min={0}
                step={1000}
                type="number"
                value={value.maxInputTokens >= 1 ? String(value.maxInputTokens) : ''}
                onChange={(_, data) => onChange({
                  maxInputTokens: data.value === '' || !Number.isFinite(Number(data.value)) || Number(data.value) < 1
                    ? 0
                    : Number(data.value),
                })}
              />
            </Field>
          )}
          {strategyMode === 'layered' && (
            <div className="context-budgets">
              <Field label={t('hotTokenBudget')} required>
                <Input
                  disabled={fieldsDisabled}
                  min={1000}
                  step={1000}
                  type="number"
                  value={String(value.hotTokenBudget)}
                  onChange={(_, data) => onChange({ hotTokenBudget: Number(data.value) })}
                />
              </Field>
              <Field label={t('hotLongTermTokenBudget')} required>
                <Input
                  disabled={disabled}
                  min={1}
                  step={100}
                  type="number"
                  value={String(value.hotLongTermTokenBudget ?? 1000)}
                  onChange={(_, data) => onChange({ hotLongTermTokenBudget: Number(data.value) })}
                />
              </Field>
              <Field label={t('warmTokenBudget')} required>
                <Input
                  disabled={fieldsDisabled}
                  min={0}
                  step={1000}
                  type="number"
                  value={String(value.warmTokenBudget)}
                  onChange={(_, data) => onChange({ warmTokenBudget: Number(data.value) })}
                />
              </Field>
              <Field label={t('coldRecallTokenBudget')} required>
                <Input
                  disabled={fieldsDisabled}
                  min={0}
                  step={1000}
                  type="number"
                  value={String(value.coldRecallTokenBudget)}
                  onChange={(_, data) => onChange({ coldRecallTokenBudget: Number(data.value) })}
                />
              </Field>
            </div>
          )}
        </>
      )}
    </div>
  )
}
