import type { ContextManagementConfig } from './types'
import { defaultContextManagementConfig } from './types'

export function normalizeContextManagementConfig(
  value: Partial<ContextManagementConfig> | null | undefined,
): ContextManagementConfig {
  const merged = {
    ...defaultContextManagementConfig,
    ...value,
  }
  // maxInputTokens = 0 means "not set"; runtime derives it from the model windows.
  const maxInputTokens = Number.isFinite(merged.maxInputTokens) && merged.maxInputTokens >= 1
    ? Math.floor(merged.maxInputTokens)
    : 0
  return {
    layeredEnabled: Boolean(merged.layeredEnabled),
    filterEnabled: Boolean(merged.filterEnabled),
    rewriteEnabled: Boolean(merged.rewriteEnabled),
    truncateEnabled: Boolean(merged.truncateEnabled),
    maxInputTokens,
    recentKeepRounds: Math.floor(merged.recentKeepRounds),
    hotTokenBudget: Math.floor(merged.hotTokenBudget),
    warmTokenBudget: Math.floor(merged.warmTokenBudget),
    coldRecallTokenBudget: Math.floor(merged.coldRecallTokenBudget),
    customStrategyEnabled: Boolean(merged.customStrategyEnabled),
    customStrategyScript: typeof merged.customStrategyScript === 'string' ? merged.customStrategyScript : '',
    customStrategyPrompt: typeof merged.customStrategyPrompt === 'string' ? merged.customStrategyPrompt : '',
  }
}

export function isValidContextManagementConfig(config: ContextManagementConfig): boolean {
  return Number.isInteger(config.maxInputTokens) && config.maxInputTokens >= 0 &&
    Number.isInteger(config.recentKeepRounds) && config.recentKeepRounds >= 1 && config.recentKeepRounds <= 20 &&
    Number.isInteger(config.hotTokenBudget) && config.hotTokenBudget >= 1_000 &&
    Number.isInteger(config.warmTokenBudget) && config.warmTokenBudget >= 0 &&
    Number.isInteger(config.coldRecallTokenBudget) && config.coldRecallTokenBudget >= 0
}

/** Validates a context config against the selected model's windows. A config
 *  is model-compatible when it is structurally valid and its explicit input
 *  budget fits the model context window. */
export function isContextConfigValidForModel(
  config: ContextManagementConfig | null | undefined,
  modelMaxContext: number | undefined,
): boolean {
  if (!config) return false
  if (!modelMaxContext || modelMaxContext < 1_000) return false
  if (!isValidContextManagementConfig(config)) return false
  // maxInputTokens = 0 derives from the model windows at runtime; always valid.
  if (config.maxInputTokens === 0) return true
  return config.maxInputTokens <= modelMaxContext
}
