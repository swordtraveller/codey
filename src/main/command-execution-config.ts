import {
  commandExecutionSupported,
  defaultCommandExecutionConfig,
  type CommandExecutionConfig,
  type CommandEnvironment,
  type CommandInterpreter,
} from '../shared/types'

export function normalizeCommandExecutionConfig(
  value: Partial<CommandExecutionConfig> | null | undefined,
): CommandExecutionConfig {
  const merged = { ...defaultCommandExecutionConfig, ...value }
  const denyRules = Array.isArray(merged.denyRules)
    ? merged.denyRules.filter((rule): rule is string => typeof rule === 'string' && rule.trim().length > 0)
    : []
  return {
    enabled: merged.enabled === true,
    interpreter: isInterpreter(merged.interpreter) ? merged.interpreter : defaultCommandExecutionConfig.interpreter,
    environment: isEnvironment(merged.environment) ? merged.environment : defaultCommandExecutionConfig.environment,
    ruleInterception: true,
    modelAuditEnabled: merged.modelAuditEnabled === true,
    auditModelConfigId: typeof merged.auditModelConfigId === 'string' && merged.auditModelConfigId ? merged.auditModelConfigId : null,
    manualConfirmationEnabled: merged.manualConfirmationEnabled === true,
    denyRules,
  }
}

function isInterpreter(value: unknown): value is CommandInterpreter {
  return value === 'pwsh51' || value === 'pwsh7' || value === 'bash'
}

function isEnvironment(value: unknown): value is CommandEnvironment {
  return value === 'bare' || value === 'wsl2' || value === 'docker' || value === 'windows-sandbox'
}

export function isValidCommandExecutionConfig(config: CommandExecutionConfig): boolean {
  if (!commandExecutionSupported(config.interpreter, config.environment)) return false
  if (config.modelAuditEnabled && !config.auditModelConfigId) return false
  try {
    for (const rule of config.denyRules) {
      new RegExp(rule, 'i')
    }
    return true
  } catch {
    return false
  }
}

/** The audit model must not share a model name with the session model. */
export function isAuditModelAllowed(
  config: CommandExecutionConfig,
  sessionModelName: string | undefined,
  auditModelName: string | undefined,
): boolean {
  if (!config.modelAuditEnabled) return true
  if (!sessionModelName || !auditModelName) return false
  return sessionModelName.trim().toLowerCase() !== auditModelName.trim().toLowerCase()
}

export function resolveCommandExecutionConfig(
  project: Project,
  conversation: Conversation,
): CommandExecutionConfig {
  return conversation.commandExecution ?? project.commandExecutionDefault
}

type Project = { commandExecutionDefault: CommandExecutionConfig }
type Conversation = { commandExecution?: CommandExecutionConfig }
