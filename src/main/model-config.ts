import type {
  AppConfig,
  Conversation,
  ModelConfig,
  ModelConfigSnapshot,
  Project,
} from '../shared/types'

export function resolveModelConfig(
  config: AppConfig,
  project: Project,
  conversation: Conversation,
): ModelConfig | undefined {
  const id = conversation.modelConfigId ?? project.defaultModelConfigId ?? config.activeModelConfigId
  return config.modelConfigs.find((model) => model.id === id)
}

export function createModelConfigSnapshot(config: ModelConfig): ModelConfigSnapshot {
  const { apiKey: _apiKey, ...snapshot } = config
  return snapshot
}
