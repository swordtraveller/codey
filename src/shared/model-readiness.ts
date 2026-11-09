import { resolveModelTarget, resolveModelTargets } from './model-targets'
import type { AppConfig, Conversation, Project, RuntimeModelConfig } from './types'

export type ModelReadinessIssue = 'sendModelRequired' | 'sendAuditModelRequired'

function usable(model: RuntimeModelConfig | undefined): boolean {
  return Boolean(model?.chain.length && model.chain.every(member => member.baseUrl && member.apiKey && member.modelName))
}

/** Same effective inheritance rules for the composer and all main-process sending entry points. */
export function modelReadinessIssue(config: AppConfig, project: Project, conversation: Conversation): ModelReadinessIssue | null {
  if (!usable(resolveModelTargets(config, project, conversation))) return 'sendModelRequired'
  if (!config.developerMode) return null
  const execution = conversation.commandExecution ?? project.commandExecutionDefault ?? config.commandExecutionGlobal
  if (!execution?.enabled) return null
  const review = execution.review ?? config.commandReviewGlobal
  if (review.reviewers.auditModel && !usable(resolveModelTarget(config, review.reviewers.auditModelConfigId))) return 'sendAuditModelRequired'
  return null
}

export function modelReadinessMessage(issue: ModelReadinessIssue, language: AppConfig['language']): string {
  if (language === 'zh-CN') return issue === 'sendModelRequired'
    ? '请先在会话、项目或全局配置中选择有效模型，再发送消息。'
    : '当前生效的命令审计已启用，但未配置有效审计模型，请先补齐配置再发送消息。'
  return issue === 'sendModelRequired'
    ? 'Choose a valid conversation, project or global model before sending a message.'
    : 'Command audit is enabled, but its effective audit model is missing. Configure it before sending a message.'
}
