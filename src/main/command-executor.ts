import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type {
  CommandExecutionConfig,
  ContextAuditEvent,
} from '../shared/types'
import {
  commandTimeoutMaxSeconds,
  commandTimeoutMinSeconds,
  defaultCommandReviewConfig,
} from '../shared/types'
import { requestAuditVerdict, type AuditModelTarget } from './command-audit'
export { parseAuditVerdict, buildAuditPromptTemplate } from './command-audit'
import { evaluateCommandRules, type CommandRuleLayer } from '../shared/command-rules'
import { resolveBareBashExecutable, resolveBarePwshExecutable } from './shell-detect'
import { commandExecutionSupported, dockerBashImage, dockerPwshImage, type CommandEnvironment, type CommandInterpreter, type CommandReviewStep } from '../shared/types'

const OUTPUT_LIMIT = 2_000

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
  /** Resolves a single audit model or an ordered model group by id. */
  resolveAuditModel: (configId: string) => Promise<AuditModelTarget | undefined>
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
 *  paths with spaces. The 8-second grace handles a distro being started.
 *  `-e` (exec) hands the argv straight to the interpreter: the `--` form
 *  instead re-parses the rejoined command line through the distro's default
 *  shell, which would expand $vars/backticks and misread redirects before
 *  the real interpreter ever sees them. pwsh7 runs PowerShell 7 installed
 *  inside the distro (Linux pwsh, same flavor as the docker combo). */
async function runWsl2(
  interpreter: CommandInterpreter,
  command: string,
  windowsWorkspacePath: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<RawRunResult> {
  const wslArgs = interpreter === 'pwsh7'
    ? ['-e', 'pwsh', '-NoProfile', '-NonInteractive', '-Command', command]
    : ['-e', 'bash', '-c', command]
  return runProcess('wsl.exe', wslArgs, windowsWorkspacePath, Math.max(timeoutSeconds, 8), signal)
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
        const auditVerdict = await requestAuditVerdict({
          command: trimmed, workspacePath: options.workspacePath,
          environment: `${effectiveInterpreter}/${effectiveEnvironment}`,
          timeoutSeconds, durationGateSeconds: review.durationAllowSeconds,
          target: auditModel, sessionModelName: runtime.sessionModelName, signal: runtime.signal,
          onStep: (step) => {
            recordStep(step)
            audit.push({ description: 'model audit: ' + step.detail, simulated: false })
          },
        })
        const detail = [auditVerdict.modelName, auditVerdict.reason || auditVerdict.status].filter(Boolean).join(': ')
        audit.push({ description: 'model audit: ' + detail, simulated: false })
        if (auditVerdict.status !== 'allow') {
          recordStep({ stage: 'audit-model', outcome: 'deny', detail })
          decide({ at: new Date().toISOString(), command: trimmed, decision: 'audit-deny', detail })
          return { ok: false, output: 'Command denied by the audit model: ' + detail, audit, steps }
        }
        auditNote = auditVerdict.reason
        auditModelName = auditVerdict.modelName
        recordStep({ stage: 'audit-model', outcome: 'pass', detail })
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

    if (runtime.signal?.aborted) {
      recordStep({ stage: 'execution', outcome: 'skipped', detail: 'aborted before execution' })
      return { ok: false, output: 'Command cancelled before execution.', audit, steps }
    }
    const startedAt = Date.now()
    let result: RawRunResult
    try {
      if (effectiveEnvironment === 'wsl2') {
        result = await runWsl2(effectiveInterpreter, trimmed, options.workspacePath, timeoutSeconds, runtime.signal)
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
