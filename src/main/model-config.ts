import type {
  AppConfig,
  Conversation,
  Project,
  RuntimeModelConfig,
} from '../shared/types'
import { flattenModelLink, resolveModelTarget, resolveModelTargets } from '../shared/model-targets'
import type { ModelConfig, ModelConfigSnapshot } from '../shared/types'

/** Resolves the effective target (model or model group) with its failover
 *  chain: conversation ?? project default ?? global default. */
export function resolveConversationModel(
  config: AppConfig,
  project: Project,
  conversation: Conversation,
): RuntimeModelConfig | undefined {
  return resolveModelTargets(config, project, conversation)
}

/** Flattens a single model link (audit-model resolution path). */
export function resolveModelById(config: AppConfig, modelId: string): ModelConfig | undefined {
  const link = config.models.find((model) => model.id === modelId)
  if (!link) return undefined
  return flattenModelLink(config, link)
}

/** Resolves any target id (model or group) for validation. */
export function isValidModelTargetId(config: AppConfig, targetId: string | null): boolean {
  if (!targetId) return false
  return resolveModelTarget(config, targetId) !== undefined
}

export function createModelConfigSnapshot(config: RuntimeModelConfig | ModelConfig): ModelConfigSnapshot {
  const { apiKey: _apiKey, ...rest } = config
  const { chain: _chain, retriesPerModel: _retries, ...snapshot } = rest as RuntimeModelConfig
  return snapshot
}
