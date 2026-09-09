import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type {
  CommandExecutionConfig,
  ContextAuditEvent,
  ModelConfig,
} from '../shared/types'
import {
  commandConfirmationThresholdSeconds,
  commandTimeoutClampSeconds,
  commandTimeoutMaxSeconds,
  commandTimeoutMinSeconds,
} from '../shared/types'
import { isAuditModelAllowed } from './command-execution-config'
import { resolveBareBashExecutable } from './shell-detect'

const OUTPUT_LIMIT = 2_000
const AUDIT_TIMEOUT_MS = 60_000
const CONFIRMATION_TIMEOUT_MS = 120_000

/** Built-in deny rules; matched case-insensitively against the whole command.
 *  Rule interception cannot be disabled. */
const BUILT_IN_DENY_RULES: RegExp[] = [
  /\bformat\s+[a-z]:/i,
  /\bcd\s+[a-z]:\\?\s*&&\s*(del|rd|format)/i,
  /\brd\s+\/s\s+\/q\s+%?(systemroot|windir|programfiles)/i,
  /\breg(\.exe)?\s+(delete|add)\s+(HKLM|HKCU)\\(system|software\\microsoft\\windows\\currentversion\\run)/i,
  /\bbcdedit\b/i,
  /\bdiskpart\b/i,
  /\bcipher\s+\/w/i,
  /\bshutdown\b|\brestart-computer\b/i,
  /\bvssadmin\b/i,
  /\bwevtutil\s+cl\b/i,
  /\bpowershell.+-enc(odedcommand)?\s+[a-z0-9+/=]{40,}/i,
  /\b(curl|wget|invoke-webrequest|invoke-restmethod)\b[^\n|;]*\|\s*(cmd|powershell|pwsh|bash|iex|invoke-expression)/i,
  /\bnet\s+user\b[^\n]*\/(add|delete)/i,
  /\bschtasks\b[^\n]*\/(create|delete)/i,
  /\bsc(\.exe)?\s+(config|delete|stop|start)\b/i,
  /\bremove-item\b[^\n]*-recurse[^\n]*-force[^\n]*(c:\\|\/etc\/|~\/?\s*$)/i,
  /\bgit\s+push\b[^\n]*--force/i,
]

export type CommandDecision =
  | { action: 'allow'; checks: string[] }
  | { action: 'deny'; reason: string; checks: string[] }

export type CommandExecutionAudit = Pick<ContextAuditEvent, 'description' | 'simulated'>

export type CommandExecutorRuntime = {
  conversationId: string
  signal?: AbortSignal
  sessionModelName?: string
  /** Resolves the audit model configuration by id. */
  resolveAuditModel: (configId: string) => Promise<ModelConfig | undefined>
  /** Shows a native confirmation; resolves false on timeout or dismissal. */
  requestConfirmation: (request: {
    command: string
    timeoutSeconds: number
    editable: boolean
    checks: string[]
  }) => Promise<{ approved: boolean; timeoutSeconds: number }>
  /** Optional audit sink (context-debug audit trail). */
  recordAudit?: (entry: CommandExecutionAudit) => void
}

/** Serial execution queue per conversation: commands run one at a time. */
const conversationQueues = new Map<string, Promise<unknown>>()

function enqueue<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
  const previous = conversationQueues.get(conversationId) ?? Promise.resolve()
  const next = previous.then(task, task)
  conversationQueues.set(conversationId, next)
  void next.finally(() => {
    if (conversationQueues.get(conversationId) === next) conversationQueues.delete(conversationId)
  })
  return next
}

export function evaluateDenyRules(command: string, extraRules: string[]): { denied: boolean; rule: string | null } {
  for (const rule of BUILT_IN_DENY_RULES) {
    if (rule.test(command)) return { denied: true, rule: `builtin: ${rule.source}` }
  }
  for (const source of extraRules) {
    try {
      if (new RegExp(source, 'i').test(command)) return { denied: true, rule: `user rule: ${source}` }
    } catch {
      // Invalid user rules are rejected at save time; skip defensively here.
    }
  }
  return { denied: false, rule: null }
}

function clip(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text
  const dropped = text.length - OUTPUT_LIMIT
  return `${text.slice(0, OUTPUT_LIMIT)}\n...[${dropped} characters truncated]`
}

/** Parses an audit verdict from a model reply. Tolerates code fences,
 *  surrounding prose, and reasoning noise by scanning every balanced {...}
 *  candidate from the end backwards. */
export function parseAuditVerdict(content: string): { verdict: 'allow' | 'deny'; reason: string } | null {
  const text = content.replace(/```(?:json)?/gi, '')
  const candidates: string[] = []
  const stack: number[] = []
  let depth = 0
  let start = -1
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '{') {
      if (depth === 0) start = index
      depth += 1
      stack.push(index)
    } else if (text[index] === '}' && depth > 0) {
      depth -= 1
      stack.pop()
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate) as { verdict?: unknown; reason?: unknown }
      if (parsed.verdict === 'allow') return { verdict: 'allow', reason: '' }
      if (parsed.verdict === 'deny' && (typeof parsed.reason === 'string' || parsed.reason === undefined)) {
        return { verdict: 'deny', reason: typeof parsed.reason === 'string' ? parsed.reason : 'denied by the audit model' }
      }
    } catch {
      // Not the verdict object; try the next candidate.
    }
  }
  return null
}

async function requestAuditVerdict(
  command: string,
  workspacePath: string,
  environment: string,
  auditModel: ModelConfig,
  signal?: AbortSignal,
): Promise<{ allow: boolean; reason: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let attempt = 0
  try {
    while (attempt < 2) {
      attempt += 1
      try {
        const response = await fetch(`${auditModel.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${auditModel.apiKey}`,
          },
          body: JSON.stringify({
            model: auditModel.modelName,
            messages: [
              {
                role: 'user',
                content: [
                  `You are a command safety auditor. Decide whether the following shell command may run in a developer's project workspace.`,
                  `Workspace: ${workspacePath}`,
                  `Environment: ${environment}`,
                  `Command: ${command}`,
                  `Reply with exactly one JSON object: {"verdict":"allow"} or {"verdict":"deny","reason":"<short reason>"} and nothing else.`,
                ].join('\n'),
              },
            ],
            max_tokens: 200,
            temperature: 0,
          }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
        const content = payload.choices?.[0]?.message?.content ?? ''
        const verdict = parseAuditVerdict(content)
        if (verdict) return { allow: verdict.verdict === 'allow', reason: verdict.reason }
        throw new Error('unparseable audit response')
      } catch (error) {
        if (signal?.aborted) return { allow: false, reason: 'aborted' }
        if (attempt >= 2) {
          return { allow: false, reason: `audit model unavailable (${error instanceof Error ? error.message : String(error)})` }
        }
      }
    }
    return { allow: false, reason: 'audit model unavailable' }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function runBareBash(command: string, workspacePath: string, timeoutSeconds: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const bash = await resolveBareBashExecutable()
  return new Promise((resolve) => {
    const child = spawn(bash, ['-c', command], {
      cwd: workspacePath,
      windowsHide: true,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, Math.max(commandTimeoutMinSeconds, timeoutSeconds) * 1_000)
    const onAbort = () => {
      timedOut = true
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ stdout: '', stderr: clip(error.message), exitCode: null, timedOut: false })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ stdout: clip(stdout), stderr: clip(stderr), exitCode: code, timedOut })
    })
  })
}

export type RunCommandOutcome = {
  ok: boolean
  output: string
  audit: CommandExecutionAudit[]
}

export async function executeCommand(options: {
  project: { folders: Array<{ id: string; path: string }> }
  conversationId: string
  config: CommandExecutionConfig
  command: string
  requestedTimeoutSeconds?: number
  workspaceFolderId: string
  workspacePath: string
  runtime: CommandExecutorRuntime
}): Promise<RunCommandOutcome> {
  const { config, command, runtime } = options
  const audit: CommandExecutionAudit[] = []
  const checks: string[] = []
  if (!config.enabled) {
    return { ok: false, output: 'Command execution is disabled for this conversation.', audit }
  }
  const trimmed = command.trim()
  if (!trimmed) {
    return { ok: false, output: 'The command is empty.', audit }
  }

  return enqueue(options.conversationId, async () => {
    // Gate 1: rule interception (always on).
    const rules = evaluateDenyRules(trimmed, config.denyRules)
    checks.push('rules')
    audit.push({ description: `rule check: ${rules.denied ? `denied (${rules.rule})` : 'passed'}`, simulated: false })
    if (rules.denied) {
      return { ok: false, output: `Blocked by command rules: ${rules.rule}. Adjust the command or the deny rules in command execution settings.`, audit }
    }

    // Timeout normalization.
    let timeoutSeconds = Math.floor(Number(options.requestedTimeoutSeconds ?? commandTimeoutClampSeconds))
    if (!Number.isFinite(timeoutSeconds)) timeoutSeconds = commandTimeoutClampSeconds
    timeoutSeconds = Math.min(commandTimeoutMaxSeconds, Math.max(commandTimeoutMinSeconds, timeoutSeconds))
    let clamped = false
    if (!config.manualConfirmationEnabled && timeoutSeconds > commandTimeoutClampSeconds) {
      timeoutSeconds = commandTimeoutClampSeconds
      clamped = true
    }

    // Gate 2: model audit (optional, fail-closed).
    if (config.modelAuditEnabled) {
      checks.push('model-audit')
      const auditModel = config.auditModelConfigId
        ? await runtime.resolveAuditModel(config.auditModelConfigId)
        : undefined
      if (!auditModel) {
        audit.push({ description: 'model audit: no audit model resolved; denied', simulated: false })
        return { ok: false, output: 'Command denied: the audit model could not be resolved. Configure a valid audit model in command execution settings.', audit }
      }
      if (!isAuditModelAllowed(config, runtime.sessionModelName, auditModel.modelName)) {
        audit.push({ description: 'model audit: audit model has the same name as the session model; denied', simulated: false })
        return { ok: false, output: 'Command denied: the audit model must differ from the session model.', audit }
      }
      const verdict = await requestAuditVerdict(trimmed, options.workspacePath, `${config.interpreter}/${config.environment}`, auditModel, runtime.signal)
      audit.push({ description: `model audit: ${verdict.allow ? 'allowed' : `denied (${verdict.reason})`}`, simulated: false })
      if (!verdict.allow) {
        return { ok: false, output: `Command denied by the audit model: ${verdict.reason}`, audit }
      }
    }

    // Gate 3: manual confirmation (optional; also required for long timeouts).
    if (config.manualConfirmationEnabled) {
      checks.push('manual-confirmation')
      if (timeoutSeconds > commandConfirmationThresholdSeconds) {
        const confirmation = await runtime.requestConfirmation({
          command: trimmed,
          timeoutSeconds,
          editable: true,
          checks,
        })
        if (!confirmation.approved) {
          audit.push({ description: `manual confirmation: denied (timeout ${timeoutSeconds}s)`, simulated: false })
          return { ok: false, output: 'Command denied by the user.', audit }
        }
        timeoutSeconds = Math.min(commandTimeoutMaxSeconds, Math.max(commandTimeoutMinSeconds, confirmation.timeoutSeconds))
      }
    }

    const startedAt = Date.now()
    const result = await runBareBash(trimmed, options.workspacePath, timeoutSeconds, runtime.signal)
    const durationMs = Date.now() - startedAt
    audit.push({
      description: `executed (${config.interpreter}/${config.environment}) exit=${result.exitCode ?? 'n/a'} timeout=${timeoutSeconds}s duration=${Math.round(durationMs / 100) / 10}s`,
      simulated: false,
    })
    const sections: string[] = []
    if (result.stdout) sections.push(`=== STDOUT ===\n${result.stdout}`)
    if (result.stderr) sections.push(`=== STDERR ===\n${result.stderr}`)
    if (result.timedOut) sections.push(`=== EXECUTION TIMEOUT ===\nExecution timed out after ${timeoutSeconds} seconds`)
    if (clamped) sections.push(`=== NOTE ===\nTimeout clamped to ${commandTimeoutClampSeconds}s because manual confirmation is disabled.`)
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      output: sections.join('\n\n') || `RC: ${result.exitCode ?? 'n/a'}`,
      audit,
    }
  })
}

export function commandFingerprint(command: string): string {
  return createHash('sha256').update(command).digest('hex').slice(0, 16)
}
