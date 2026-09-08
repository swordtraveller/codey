import {
  defaultContextManagementConfig,
  type AppConfig,
  type ContextManagementConfig,
  type Conversation,
  type Project,
} from '../shared/types'

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
  }
}

export function isValidContextManagementConfig(config: ContextManagementConfig): boolean {
  return Number.isInteger(config.maxInputTokens) && config.maxInputTokens >= 0 &&
    Number.isInteger(config.recentKeepRounds) && config.recentKeepRounds >= 1 && config.recentKeepRounds <= 20 &&
    Number.isInteger(config.hotTokenBudget) && config.hotTokenBudget >= 1_000 &&
    Number.isInteger(config.warmTokenBudget) && config.warmTokenBudget >= 0 &&
    Number.isInteger(config.coldRecallTokenBudget) && config.coldRecallTokenBudget >= 0
}

export function resolveContextManagementConfig(
  config: AppConfig,
  project: Project,
  conversation: Conversation,
): ContextManagementConfig {
  return conversation.contextConfigOverride ?? project.contextConfigOverride ?? config.contextManagement
}
