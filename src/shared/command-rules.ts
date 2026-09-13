import type { CommandReviewConfig, CommandReviewRule } from './types'

/** Splits a shell command into tokens, honoring double and single quotes so
 *  `git commit -m "a b"` keeps `a b` as one token. */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      hasToken = true
    } else if (/\s/.test(char)) {
      if (hasToken || current) tokens.push(current)
      current = ''
      hasToken = false
    } else {
      current += char
      hasToken = true
    }
  }
  if (hasToken || current) tokens.push(current)
  return tokens
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tokenToRegExpSource(token: string): string {
  if (token === '*') return '[^\\s]+(?:\\s+[^\\s]+)*'
  if (token === '?') return '[^\\s]+'
  // In-token wildcards stay within the token (`test*` matches `tests`).
  return token
    .split(/([*?])/)
    .map((part) => part === '*' ? '[^\\s]*' : part === '?' ? '[^\\s]' : escapeLiteral(part))
    .join('')
}

/** Compiles a shell-glob pattern into an anchored, case-insensitive RegExp
 *  over the token-joined command. `*` as a whole token matches one or more
 *  tokens; inside a token it matches non-space characters. Throws on an
 *  empty or effectively empty pattern. */
export function globPatternToRegExp(pattern: string): RegExp {
  const tokens = tokenizeCommand(pattern.trim())
  if (tokens.length === 0 || tokens.every((token) => token === '')) {
    throw new Error('Pattern is empty')
  }
  return new RegExp(`^${tokens.map(tokenToRegExpSource).join('\\s+')}$`, 'i')
}

export function isValidGlobPattern(pattern: string): boolean {
  try {
    globPatternToRegExp(pattern)
    return true
  } catch {
    return false
  }
}

export function isValidRegexPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, 'i')
    return true
  } catch {
    return false
  }
}

export function ruleMatches(rule: CommandReviewRule, command: string): boolean {
  if (!rule.enabled) return false
  try {
    if (rule.patternType === 'regex') {
      return new RegExp(rule.pattern, 'i').test(command)
    }
    return globPatternToRegExp(rule.pattern).test(tokenizeCommand(command).join(' '))
  } catch {
    // Invalid rules are rejected at save time; skip defensively here.
    return false
  }
}

export type CommandRuleLevel = 'runtime' | 'conversation' | 'project' | 'global'

export type CommandRuleLayer = {
  level: CommandRuleLevel
  rules: CommandReviewRule[]
}

export type CommandRuleVerdict = {
  decision: 'allow' | 'deny' | null
  rule: CommandReviewRule | null
  level: CommandRuleLevel | null
}

/** Pools the layers and applies the invariants: deny beats allow across every
 *  layer; within the same decision the higher layer wins
 *  (runtime > conversation > project > global). */
export function evaluateCommandRules(command: string, layers: CommandRuleLayer[]): CommandRuleVerdict {
  for (const layer of layers) {
    for (const rule of layer.rules) {
      if (rule.list === 'deny' && ruleMatches(rule, command)) {
        return { decision: 'deny', rule, level: layer.level }
      }
    }
  }
  for (const layer of layers) {
    for (const rule of layer.rules) {
      if (rule.list === 'allow' && ruleMatches(rule, command)) {
        return { decision: 'allow', rule, level: layer.level }
      }
    }
  }
  return { decision: null, rule: null, level: null }
}

/** Finds a rule with the same pattern in the opposite list (black/white
 *  mutual exclusion). */
export function findConflictingRule(rules: CommandReviewRule[], candidate: { pattern: string; list: 'allow' | 'deny' }): CommandReviewRule | undefined {
  return rules.find((rule) =>
    rule.list !== candidate.list &&
    rule.pattern.trim().toLowerCase() === candidate.pattern.trim().toLowerCase(),
  )
}

/** Builds a glob pattern from a decided command for approval memory:
 *  exact = the full command, prefix = first token + ` *`. */
export function buildMemoryPattern(command: string, kind: 'exact' | 'prefix'): string {
  const tokens = tokenizeCommand(command.trim())
  if (kind === 'exact') return tokens.join(' ')
  return tokens.length > 0 ? `${tokens[0]} *` : ''
}

/** Shared structural validation used by both the main-process save path and
 *  the renderer draft checks. */
export function validateCommandReviewConfig(config: CommandReviewConfig): boolean {
  if (!Number.isInteger(config.durationAllowSeconds)) return false
  if (config.durationAllowSeconds < 60 || config.durationAllowSeconds > 86_400) return false
  if (config.reviewers.auditModel && !config.reviewers.auditModelConfigId) return false
  const seen: Record<string, true> = {}
  for (const rule of config.contentRules) {
    if (!rule.pattern.trim()) return false
    if (rule.patternType === 'glob' ? !isValidGlobPattern(rule.pattern) : !isValidRegexPattern(rule.pattern)) return false
    const key = rule.pattern.trim().toLowerCase()
    if (seen[`${rule.list === 'allow' ? 'deny' : 'allow'}:${key}`]) return false
    seen[`${rule.list}:${key}`] = true
  }
  return true
}
