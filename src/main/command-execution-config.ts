import {
  commandExecutionSupported,
  commandReviewDurationDefaultSeconds,
  commandReviewDurationMaxSeconds,
  commandReviewDurationMinSeconds,
  createBuiltinReviewRules,
  defaultCommandExecutionConfig,
  defaultCommandReviewConfig,
  type CommandEnvironment,
  type CommandExecutionConfig,
  type CommandInterpreter,
  type CommandReviewConfig,
  type CommandReviewRule,
} from '../shared/types'
import { validateCommandReviewConfig } from '../shared/command-rules'

/** Legacy persisted shape (pre-review-config). Migrated on load. */
type LegacyCommandExecutionFields = {
  ruleInterception?: true
  modelAuditEnabled?: boolean
  auditModelConfigId?: string | null
  manualConfirmationEnabled?: boolean
  denyRules?: string[]
}

type StorableCommandExecution = Partial<CommandExecutionConfig> & LegacyCommandExecutionFields & {
  review?: Partial<CommandReviewConfig> | null
}

function normalizeRule(value: unknown, index: number): CommandReviewRule | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const pattern = typeof record.pattern === 'string' ? record.pattern.trim() : ''
  if (!pattern) return null
  const patternType = record.patternType === 'regex' ? 'regex' : 'glob'
  const source = record.source === 'builtin' || record.source === 'approval' ? record.source : 'user'
  return {
    id: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `rule-${index + 1}-${Math.random().toString(36).slice(2, 8)}`,
    pattern,
    patternType,
    list: record.list === 'allow' ? 'allow' : 'deny',
    source,
    note: typeof record.note === 'string' && record.note.trim() ? record.note.trim() : undefined,
    enabled: record.enabled !== false,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
  }
}

export function normalizeCommandReviewConfig(value: Partial<CommandReviewConfig> | null | undefined): CommandReviewConfig {
  const reviewers: Partial<CommandReviewConfig['reviewers']> = value?.reviewers ?? {}
  const duration = Math.floor(Number(value?.durationAllowSeconds))
  return {
    durationAllowSeconds: Number.isFinite(duration)
      ? Math.min(commandReviewDurationMaxSeconds, Math.max(commandReviewDurationMinSeconds, duration))
      : commandReviewDurationDefaultSeconds,
    contentRules: Array.isArray(value?.contentRules)
      ? value.contentRules.map(normalizeRule).filter((rule): rule is CommandReviewRule => rule !== null)
      : [],
    reviewers: {
      auditModel: reviewers.auditModel === true,
      auditModelConfigId: typeof reviewers.auditModelConfigId === 'string' && reviewers.auditModelConfigId
        ? reviewers.auditModelConfigId
        : null,
      manualConfirmation: reviewers.manualConfirmation === true,
    },
  }
}

/** Migrates a legacy denyRules/manual-audit/confirmation config into the
 *  review structure, seeding the built-in deny rules so behavior is
 *  unchanged for existing installations. */
function migrateLegacyReview(legacy: LegacyCommandExecutionFields): CommandReviewConfig | null {
  const hasLegacy = legacy.modelAuditEnabled !== undefined ||
    legacy.manualConfirmationEnabled !== undefined ||
    (Array.isArray(legacy.denyRules) && legacy.denyRules.length > 0)
  if (!hasLegacy) return null
  const userDenyRules: CommandReviewRule[] = (legacy.denyRules ?? [])
    .filter((rule): rule is string => typeof rule === 'string' && rule.trim().length > 0)
    .map((pattern, index) => ({
      id: `migrated-deny-${index + 1}`,
      pattern: pattern.trim(),
      patternType: 'regex',
      list: 'deny',
      source: 'user',
      enabled: true,
      note: 'regex (legacy)',
    }))
  return {
    ...defaultCommandReviewConfig,
    contentRules: [...createBuiltinReviewRules(), ...userDenyRules],
    reviewers: {
      auditModel: legacy.modelAuditEnabled === true,
      auditModelConfigId: typeof legacy.auditModelConfigId === 'string' && legacy.auditModelConfigId
        ? legacy.auditModelConfigId
        : null,
      manualConfirmation: legacy.manualConfirmationEnabled === true,
    },
  }
}

export function normalizeCommandExecutionConfig(
  value: StorableCommandExecution | null | undefined,
): CommandExecutionConfig {
  const merged = { ...defaultCommandExecutionConfig, ...value }
  const enabledEnvironments: Record<CommandInterpreter, CommandEnvironment[]> = {
    bash: normalizeEnvironmentList(merged.enabledEnvironments?.bash, defaultCommandExecutionConfig.enabledEnvironments.bash),
    pwsh7: normalizeEnvironmentList(merged.enabledEnvironments?.pwsh7, defaultCommandExecutionConfig.enabledEnvironments.pwsh7),
    pwsh51: normalizeEnvironmentList(merged.enabledEnvironments?.pwsh51, defaultCommandExecutionConfig.enabledEnvironments.pwsh51),
  }
  const review = value?.review !== undefined && value?.review !== null
    ? normalizeCommandReviewConfig(value.review)
    : migrateLegacyReview(value ?? {})
  return {
    enabled: merged.enabled === true,
    interpreter: isInterpreter(merged.interpreter) ? merged.interpreter : defaultCommandExecutionConfig.interpreter,
    environment: isEnvironment(merged.environment) ? merged.environment : defaultCommandExecutionConfig.environment,
    enabledEnvironments,
    review,
  }
}

function normalizeEnvironmentList(
  value: unknown,
  fallback: CommandEnvironment[],
): CommandEnvironment[] {
  // An explicitly stored list — even an empty one — is the user's choice;
  // only a missing/malformed field falls back to the defaults. Returning the
  // fallback for an empty list silently resurrected rows the user had
  // unchecked when the config was saved.
  if (!Array.isArray(value)) return fallback
  return value.filter((env): env is CommandEnvironment => isEnvironment(env))
}

function isInterpreter(value: unknown): value is CommandInterpreter {
  return value === 'pwsh51' || value === 'pwsh7' || value === 'bash'
}

function isEnvironment(value: unknown): value is CommandEnvironment {
  return value === 'bare' || value === 'wsl2' || value === 'docker' || value === 'windows-sandbox'
}

export function isValidCommandReviewConfig(config: CommandReviewConfig): boolean {
  return validateCommandReviewConfig(config)
}

export function isValidCommandExecutionConfig(config: CommandExecutionConfig): boolean {
  if (!commandExecutionSupported(config.interpreter, config.environment)) return false
  // Every enabled combo must be supported.
  for (const [interpreter, envs] of Object.entries(config.enabledEnvironments)) {
    for (const env of envs) {
      if (!commandExecutionSupported(interpreter as CommandInterpreter, env)) return false
    }
  }
  if (config.review !== null && !isValidCommandReviewConfig(config.review)) return false
  return true
}

/** The audit model must not share a model name with the session model. */
export function isAuditModelAllowed(
  review: CommandReviewConfig,
  sessionModelName: string | undefined,
  auditModelName: string | undefined,
): boolean {
  if (!review.reviewers.auditModel) return true
  if (!sessionModelName || !auditModelName) return false
  return sessionModelName.trim().toLowerCase() !== auditModelName.trim().toLowerCase()
}

/** Resolves the effective config: conversation override ?? project default ??
 *  global execution default ?? built-in matrix, with review defaulting to
 *  the global review config whenever the winning layer did not define its
 *  own review. */
export function resolveCommandExecutionConfig(
  project: ProjectLike,
  conversation: ConversationLike,
  appConfig: AppConfigLike,
): CommandExecutionConfig {
  const base = conversation.commandExecution ?? project.commandExecutionDefault ?? appConfig.commandExecutionGlobal
  const matrix = base ? structuredClone(base) : structuredClone(defaultCommandExecutionConfig)
  return {
    ...matrix,
    review: matrix.review !== null ? matrix.review : structuredClone(appConfig.commandReviewGlobal),
  }
}

type ProjectLike = { commandExecutionDefault: CommandExecutionConfig | null }
type ConversationLike = { commandExecution?: CommandExecutionConfig | null }
type AppConfigLike = {
  commandReviewGlobal: CommandReviewConfig
  commandExecutionGlobal?: CommandExecutionConfig | null
}
