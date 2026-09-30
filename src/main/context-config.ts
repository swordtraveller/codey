import type { AppConfig, Conversation, Project } from '../shared/types'
import { normalizeContextManagementConfig as normalizeShared } from '../shared/context-validation'

export const normalizeContextManagementConfig = normalizeShared
export { isValidContextManagementConfig, isContextConfigValidForModel } from '../shared/context-validation'

export function resolveContextManagementConfig(
  config: AppConfig,
  project: Project,
  conversation: Conversation,
): import('../shared/types').ContextManagementConfig {
  return conversation.contextConfigOverride ?? project.contextConfigOverride ?? config.contextManagement
}
