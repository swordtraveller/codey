import {
  defaultAgentLimitsConfig,
  maximumAgentLimit,
  type AgentLimitsConfig,
} from '../shared/types'

export function normalizeAgentLimitsConfig(
  value?: Partial<AgentLimitsConfig>,
): AgentLimitsConfig {
  return {
    modelRequestsPerRound: Math.floor(
      value?.modelRequestsPerRound ?? defaultAgentLimitsConfig.modelRequestsPerRound,
    ),
    toolCallsPerRequest: Math.floor(
      value?.toolCallsPerRequest ?? defaultAgentLimitsConfig.toolCallsPerRequest,
    ),
  }
}

export function isValidAgentLimitsConfig(value: AgentLimitsConfig): boolean {
  return Number.isInteger(value.modelRequestsPerRound) &&
    value.modelRequestsPerRound >= 1 &&
    value.modelRequestsPerRound <= maximumAgentLimit &&
    Number.isInteger(value.toolCallsPerRequest) &&
    value.toolCallsPerRequest >= 1 &&
    value.toolCallsPerRequest <= maximumAgentLimit
}
