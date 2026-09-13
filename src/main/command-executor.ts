import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type {
  CommandExecutionConfig,
  ContextAuditEvent,
  ModelConfig,
} from '../shared/types'
import {
  commandTimeoutMaxSeconds,
  commandTimeoutMinSeconds,
  defaultCommandReviewConfig,
} from '../shared/types'
import { isAuditModelAllowed } from './command-execution-config'
import { evaluateCommandRules, type CommandRuleLayer } from '../shared/command-rules'
import { log } from './logger'
import { resolveBareBashExecutable, resolveBarePwshExecutable } from './shell-detect'
import { commandExecutionSupported, dockerBashImage, dockerPwshImage, type CommandEnvironment, type CommandInterpreter, type CommandReviewStep } from '../shared/types'

const OUTPUT_LIMIT = 2_000
const AUDIT_TIMEOUT_MS = 120_000

/** Persistent review-history entry (command-review-history.jsonl). The
 *  recording sink adds projectId/conversationId context. */
export type CommandReviewDecision = {
  at: string
  command: string
  decision: 'rule-allow' | 'rule-deny' | 'audit-deny' | 'manual-deny' | 'manual-approve' | 'executed'
  detail?: string
  ruleId?: string
  layer?: string
  timeoutSeconds?: number
}

export type CommandDecision =
  | { action: 'allow'; checks: string[] }
  | { action: 'deny'; reason: string; checks: string[] }

export type CommandExecutionAudit = Pick<ContextAuditEvent, 'description' | 'simulated'>

export type CommandExecutorRuntime = {
  conversationId: string
  signal?: AbortSignal
  sessionModelName?: string
  /** Rule pool for this conversation, highest precedence first (runtime
   *  memory, conversation, project, global). Settings live in config.review. */
  ruleLayers?: CommandRuleLayer[]
  /** Resolves the audit model configuration by id. */
  resolveAuditModel: (configId: string) => Promise<ModelConfig | undefined>
  /** Shows the in-app approval card; resolves denied when dismissed. */
  requestConfirmation: (request: {
    command: string
    timeoutSeconds: number
    editable: boolean
    checks: string[]
    workspacePath: string
    environment: string
    /** Audit-model display name when that reviewer ran and allowed. */
    auditModelName?: string
    /** Audit-model reason text (may be empty when it simply allowed). */
    auditNote?: string
  }) => Promise<{ approved: boolean; timeoutSeconds: number }>
  /** Optional audit sink (context-debug audit trail). */
  recordAudit?: (entry: CommandExecutionAudit) => void
  /** Optional persistent review-history sink. */
  recordDecision?: (entry: CommandReviewDecision) => void
  /** Optional live per-step review sink (streams the chain as it unfolds). */
  onReviewStep?: (step: CommandReviewStep) => void
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

/** The audit prompt template; exposed for the settings prompt viewer. */
export function buildAuditPromptTemplate(): string {
  return [
    `You are a command safety auditor. Decide whether the following shell command may run in a developer's project workspace.`,
    `Workspace: <workspace path>`,
    `Environment: <interpreter>/<environment>`,
    `Command: <the command>`,
    `Requested timeout: <seconds>s (duration gate reference: <gate>s; deny when the requested duration is unreasonable for this command)`,
    `Judge both the command content and the requested duration. Reply with a JSON object: {"verdict":"allow"} or {"verdict":"deny","reason":"<short reason>"}.`,
  ].join('\n')
}

async function requestAuditVerdict(
  command: string,
  workspacePath: string,
  environment: string,
  timeoutSeconds: number,
  durationGateSeconds: number,
  auditModel: ModelConfig,
  signal?: AbortSignal,
): Promise<{ allow: boolean; reason: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const basePrompt = [
    `You are a command safety auditor. Decide whether the following shell command may run in a developer's project workspace.`,
    `Workspace: ${workspacePath}`,
    `Environment: ${environment}`,
    `Command: ${command}`,
    `Requested timeout: ${timeoutSeconds}s (duration gate reference: ${durationGateSeconds}s; deny when the requested duration is unreasonable for this command)`,
    `Judge both the command content and the requested duration. Reply with a JSON object: {"verdict":"allow"} or {"verdict":"deny","reason":"<short reason>"}.`,
  ].join('\n')
  try {
    // Pass 1: JSON mode (API-enforced schema; chatty models cannot lead with
    // prose). Falls back without it when the endpoint rejects the parameter.
    // Pass 2 (rescue): JSON-only prompt with a large budget, for endpoints
    // without JSON mode or replies still truncated (finish_reason=length).
    let jsonModeSupported = true
    for (let pass = 1; pass <= 2; pass += 1) {
      const rescue = pass === 2
      try {
        const body: Record<string, unknown> = {
          model: auditModel.modelName,
          messages: [
            {
              role: 'user',
              content: rescue
                ? `Output ONLY the JSON verdict now, nothing else: {"verdict":"allow"} or {"verdict":"deny","reason":"<short reason>"}`
                : basePrompt,
            },
          ],
          max_tokens: rescue ? 2_000 : 800,
          temperature: 0,
        }
        if (jsonModeSupported) body.response_format = { type: 'json_object' }
        const response = await fetch(`${auditModel.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${auditModel.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (response.status === 400 && jsonModeSupported) {
          // Endpoint does not implement response_format; retry without it.
          jsonModeSupported = false
          pass -= 1
          continue
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
        const content = payload.choices?.[0]?.message?.content ?? ''
        const finishReason = (payload.choices?.[0] as { finish_reason?: string } | undefined)?.finish_reason ?? 'unknown'
        const verdict = parseAuditVerdict(content)
        if (verdict) return { allow: verdict.verdict === 'allow', reason: verdict.reason }
        // Diagnostic: capture the raw audit reply so unparseable responses can
        // be analyzed in main.log instead of guessing at the parser.
        log.warn('command.audit.unparseable', {
          command: command.slice(0, 200),
          content: content.slice(0, 500),
          finishReason,
          pass,
          jsonMode: jsonModeSupported,
        })
        // A truncated reply is not a model failure — go straight to the rescue
        // pass instead of denying.
        if (!rescue) continue
        throw new Error('unparseable audit response')
      } catch (error) {
        if (signal?.aborted) return { allow: false, reason: 'aborted' }
        const message = error instanceof Error ? error.message : String(error)
        if (rescue) {
          return { allow: false, reason: `audit model unavailable (${message})` }
        }
        // Non-rescue failures (network, 5xx): one rescue attempt remains.
        log.warn('command.audit.request-failed', { command: command.slice(0, 200), error: message, pass })
      }
    }
    return { allow: false, reason: 'audit model unavailable' }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}

type RawRunResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }

function runProcess(
  executable: string,
  args: string[],
  workspacePath: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<RawRunResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
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

async function runBare(
  interpreter: CommandInterpreter,
  command: string,
  workspacePath: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<RawRunResult> {
  if (interpreter === 'bash') {
    const bash = await resolveBareBashExecutable()
    return runProcess(bash, ['-c', command], workspacePath, timeoutSeconds, signal)
  }
  const pwsh = await resolveBarePwshExecutable(interpreter)
  return runProcess(
    pwsh,
    ['-NoProfile', '-NonInteractive', '-Command', command],
    workspacePath,
    timeoutSeconds,
    signal,
  )
}

/** WSL accepts Windows paths and translates them itself; quoting guards
 *  paths with spaces. The 8-second grace handles a distro being started. */
async function runWsl2(
  command: string,
  windowsWorkspacePath: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<RawRunResult> {
  return runProcess('wsl.exe', ['--', 'bash', '-c', command], windowsWorkspacePath, Math.max(timeoutSeconds, 8), signal)
}

/** Docker: mounts the workspace at /work inside a disposable container.
 *  The mount source must be a project-registered folder — never anything
 *  else on the host. */
async function runDocker(
  interpreter: CommandInterpreter,
  command: string,
  windowsWorkspacePath: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<RawRunResult> {
  const isPwsh = interpreter === 'pwsh7' || interpreter === 'pwsh51'
  const image = isPwsh ? dockerPwshImage : dockerBashImage
  const containerCommand = isPwsh
    ? ['pwsh', '-NoProfile', '-NonInteractive', '-Command', command]
    : ['sh', '-c', command]
  return runProcess(
    'docker',
    ['run', '--rm', '-v', `${windowsWorkspacePath}:/work`, '-w', '/work', image, ...containerCommand],
    windowsWorkspacePath,
    Math.max(timeoutSeconds, 8),
    signal,
  )
}

/** Resolves the workspace for sandboxed runs and enforces the mount policy:
 *  only folders registered under the project may be mounted. */
function assertMountableWorkspace(workspacePath: string, allowedFolderPaths: string[]): string {
  const normalized = workspacePath.replace(/[\\/]+$/, '').toLowerCase()
  const allowed = allowedFolderPaths.some((folder) => folder.replace(/[\\/]+$/, '').toLowerCase() === normalized)
  if (!allowed) {
    throw new Error('The command workspace is not a folder registered under this project. Sandboxed execution is limited to project folders.')
  }
  return workspacePath
}

export type RunCommandOutcome = {
  ok: boolean
  output: string
  audit: CommandExecutionAudit[]
  /** Structured review chain for the tool-call card (and future sinks). */
  steps: CommandReviewStep[]
}

export async function executeCommand(options: {
  project: { folders: Array<{ id: string; path: string }> }
  conversationId: string
  config: CommandExecutionConfig
  command: string
  /** Optional per-call overrides; must be within the enabled combos. */
  overrideInterpreter?: CommandInterpreter
  overrideEnvironment?: CommandEnvironment
  requestedTimeoutSeconds?: number
  workspaceFolderId: string
  workspacePath: string
  runtime: CommandExecutorRuntime
}): Promise<RunCommandOutcome> {
  const { config, command, runtime } = options
  const audit: CommandExecutionAudit[] = []
  const checks: string[] = []
  const earlySteps: CommandReviewStep[] = []
  if (!config.enabled) {
    return { ok: false, output: 'Command execution is disabled for this conversation.', audit, steps: earlySteps }
  }
  const trimmed = command.trim()
  if (!trimmed) {
    return { ok: false, output: 'The command is empty.', audit, steps: earlySteps }
  }

  // Resolve the effective interpreter/environment (model may override).
  const effectiveInterpreter = options.overrideInterpreter ?? config.interpreter
  const effectiveEnvironment = options.overrideEnvironment ?? config.environment

  // Combo validation: the effective combo must be enabled and supported.
  const enabledForInterpreter = config.enabledEnvironments[effectiveInterpreter] ?? []
  if (!enabledForInterpreter.includes(effectiveEnvironment)) {
    const available = Object.entries(config.enabledEnvironments)
      .flatMap(([interpreter, envs]) => envs.map((env) => `${interpreter}/${env}`))
      .join(', ')
    return {
      ok: false,
      output: `Combo ${effectiveInterpreter}/${effectiveEnvironment} is not enabled. Available combos: ${available || 'none'}.`,
      audit,
      steps: earlySteps,
    }
  }
  if (!commandExecutionSupported(effectiveInterpreter, effectiveEnvironment)) {
    return {
      ok: false,
      output: `Combo ${effectiveInterpreter}/${effectiveEnvironment} is not supported in this version.`,
      audit,
      steps: earlySteps,
    }
  }

  // Mount policy: sandboxed environments may only mount project folders.
  const allowedFolderPaths = options.project.folders.map((folder) => folder.path)
  if (effectiveEnvironment === 'docker' || effectiveEnvironment === 'wsl2') {
    try {
      assertMountableWorkspace(options.workspacePath, allowedFolderPaths)
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : 'Workspace rejected', audit, steps: earlySteps }
  }
  }

  return enqueue(options.conversationId, async () => {
    const review = config.review ?? defaultCommandReviewConfig
    const decide = (entry: CommandReviewDecision): void => runtime.recordDecision?.(entry)
    const steps: CommandReviewStep[] = []
    const recordStep = (entry: CommandReviewStep): void => {
      steps.push(entry)
      runtime.onReviewStep?.(entry)
    }

    // Reviewer 1: program rules (always on). Duration legality is a hard
    // check that precedes the lists — an illegal duration denies even a
    // whitelisted command. The duration never authorizes passage: commands
    // unmatched by the lists enter the reviewer chain regardless of duration.
    const declared = options.requestedTimeoutSeconds
    const declaredLegal = declared === undefined ||
      (Number.isFinite(declared) && Math.floor(declared) === declared &&
        declared >= commandTimeoutMinSeconds && declared <= commandTimeoutMaxSeconds)
    if (!declaredLegal) {
      checks.push('rules')
      recordStep({ stage: 'duration', outcome: 'deny', detail: `declared duration ${String(declared)}s is not a legal value` })
      decide({ at: new Date().toISOString(), command: trimmed, decision: 'rule-deny', detail: `illegal declared duration: ${String(declared)}s` })
      return {
        ok: false,
        output: `Blocked by command rules: the declared duration (${String(declared)}s) is not a legal value. It must be an integer between ${commandTimeoutMinSeconds} and ${commandTimeoutMaxSeconds} seconds.`,
        audit,
        steps,
      }
    }
    let timeoutSeconds = declared === undefined ? review.durationAllowSeconds : Math.floor(declared)
    recordStep({ stage: 'duration', outcome: 'pass', detail: declared === undefined ? `undeclared; defaults to ${timeoutSeconds}s` : `declared ${timeoutSeconds}s` })

    const verdict = evaluateCommandRules(trimmed, runtime.ruleLayers ?? [])
    checks.push('rules')
    audit.push({ description: `rule check: ${verdict.decision === 'deny' ? `denied (${verdict.rule?.pattern})` : verdict.decision === 'allow' ? `allowed (${verdict.rule?.pattern})` : 'no match'}`, simulated: false })
    if (verdict.decision === 'deny') {
      recordStep({ stage: 'rules', outcome: 'deny', detail: `${verdict.level} layer: ${verdict.rule?.pattern}` })
      decide({ at: new Date().toISOString(), command: trimmed, decision: 'rule-deny', ruleId: verdict.rule?.id, layer: verdict.level ?? undefined, detail: verdict.rule?.pattern })
      return { ok: false, output: `Blocked by command rules (${verdict.level} layer): ${verdict.rule?.pattern}. Adjust the command or the rules in command review settings.`, audit, steps }
    }
    recordStep(
      verdict.decision === 'allow'
        ? { stage: 'rules', outcome: 'pass', detail: `whitelist: ${verdict.rule?.pattern} (skips the remaining reviewers)` }
        : { stage: 'rules', outcome: 'pass', detail: 'no rule matched; entering the reviewer chain' },
    )

    if (verdict.decision === 'allow') {
      decide({ at: new Date().toISOString(), command: trimmed, decision: 'rule-allow', ruleId: verdict.rule?.id, layer: verdict.level ?? undefined, detail: verdict.rule?.pattern, timeoutSeconds })
    } else {
      // Reviewer 2: model audit (optional, fail-closed). An audit "allow"
      // means no objection — the chain continues; it never replaces the human.
      // The audit judges the command content AND the requested duration.
      let auditNote: string | undefined
      let auditModelName: string | undefined
      if (review.reviewers.auditModel) {
        checks.push('model-audit')
        const auditModel = review.reviewers.auditModelConfigId
          ? await runtime.resolveAuditModel(review.reviewers.auditModelConfigId)
          : undefined
        if (!auditModel) {
          audit.push({ description: 'model audit: no audit model resolved; denied', simulated: false })
          recordStep({ stage: 'audit-model', outcome: 'deny', detail: 'audit model unresolved' })
          decide({ at: new Date().toISOString(), command: trimmed, decision: 'audit-deny', detail: 'audit model unresolved' })
          return { ok: false, output: 'Command denied: the audit model could not be resolved. Configure a valid audit model in command review settings.', audit, steps }
        }
        if (!isAuditModelAllowed(review, runtime.sessionModelName, auditModel.modelName)) {
          audit.push({ description: 'model audit: audit model has the same name as the session model; denied', simulated: false })
          recordStep({ stage: 'audit-model', outcome: 'deny', detail: 'audit model equals session model' })
          decide({ at: new Date().toISOString(), command: trimmed, decision: 'audit-deny', detail: 'audit model equals session model' })
          return { ok: false, output: 'Command denied: the audit model must differ from the session model.', audit, steps }
        }
        const auditVerdict = await requestAuditVerdict(trimmed, options.workspacePath, `${effectiveInterpreter}/${effectiveEnvironment}`, timeoutSeconds, review.durationAllowSeconds, auditModel, runtime.signal)
        audit.push({ description: `model audit: ${auditVerdict.allow ? 'allowed' : `denied (${auditVerdict.reason})`}`, simulated: false })
        if (!auditVerdict.allow) {
          recordStep({ stage: 'audit-model', outcome: 'deny', detail: auditVerdict.reason })
          decide({ at: new Date().toISOString(), command: trimmed, decision: 'audit-deny', detail: auditVerdict.reason })
          return { ok: false, output: `Command denied by the audit model: ${auditVerdict.reason}`, audit, steps }
        }
        auditNote = auditVerdict.reason
        auditModelName = auditModel.name || auditModel.modelName
        recordStep({ stage: 'audit-model', outcome: 'pass', detail: auditNote || 'no objection' })
      } else {
        recordStep({ stage: 'audit-model', outcome: 'skipped', detail: 'reviewer disabled' })
      }

      // Reviewer 3: manual confirmation (optional, on by default). The check
      // only counts as passed after the user actually approves it.
      if (review.reviewers.manualConfirmation) {
        const confirmation = await runtime.requestConfirmation({
          command: trimmed,
          timeoutSeconds,
          editable: true,
          checks,
          workspacePath: options.workspacePath,
          environment: `${effectiveInterpreter}/${effectiveEnvironment}`,
          auditModelName,
          auditNote,
        })
        if (!confirmation.approved) {
          audit.push({ description: `manual confirmation: denied (timeout ${timeoutSeconds}s)`, simulated: false })
          recordStep({ stage: 'manual-confirmation', outcome: 'deny', detail: 'rejected by the user' })
          decide({ at: new Date().toISOString(), command: trimmed, decision: 'manual-deny', timeoutSeconds })
          return { ok: false, output: 'Command denied by the user.', audit, steps }
        }
        checks.push('manual-confirmation')
        recordStep({ stage: 'manual-confirmation', outcome: 'pass', detail: 'approved by the user' })
        decide({ at: new Date().toISOString(), command: trimmed, decision: 'manual-approve', timeoutSeconds })
        timeoutSeconds = Math.min(commandTimeoutMaxSeconds, Math.max(commandTimeoutMinSeconds, confirmation.timeoutSeconds))
      } else {
        recordStep({ stage: 'manual-confirmation', outcome: 'skipped', detail: 'reviewer disabled' })
      }
    }

    const startedAt = Date.now()
    let result: RawRunResult
    try {
      if (effectiveEnvironment === 'wsl2') {
        result = await runWsl2(trimmed, options.workspacePath, timeoutSeconds, runtime.signal)
      } else if (effectiveEnvironment === 'docker') {
        result = await runDocker(effectiveInterpreter, trimmed, options.workspacePath, timeoutSeconds, runtime.signal)
      } else {
        result = await runBare(effectiveInterpreter, trimmed, options.workspacePath, timeoutSeconds, runtime.signal)
      }
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : 'Command execution failed to start.',
        audit,
        steps,
      }
    }
    const durationMs = Date.now() - startedAt
    audit.push({
      description: `executed (${config.interpreter}/${config.environment}) exit=${result.exitCode ?? 'n/a'} timeout=${timeoutSeconds}s duration=${Math.round(durationMs / 100) / 10}s`,
      simulated: false,
    })
    decide({ at: new Date().toISOString(), command: trimmed, decision: 'executed', timeoutSeconds })
    const sections: string[] = []
    if (result.stdout) sections.push(`=== STDOUT ===\n${result.stdout}`)
    if (result.stderr) sections.push(`=== STDERR ===\n${result.stderr}`)
    if (result.timedOut) sections.push(`=== EXECUTION TIMEOUT ===\nTerminated after exceeding the declared duration of ${timeoutSeconds} seconds. Declare a longer timeout next time.`)
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      output: sections.join('\n\n') || `RC: ${result.exitCode ?? 'n/a'}`,
      audit,
      steps,
    }
  })
}

export function commandFingerprint(command: string): string {
  return createHash('sha256').update(command).digest('hex').slice(0, 16)
}
