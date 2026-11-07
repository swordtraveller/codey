import type { ModelConfig, RuntimeModelConfig, ModelChainMember, CommandReviewStep } from '../shared/types'

export type AuditModelTarget = ModelConfig | RuntimeModelConfig
export type AuditResult = {
  status: 'allow' | 'deny' | 'unavailable' | 'aborted'
  reason: string
  modelName?: string
}

function memberLabel(member: ModelChainMember): string {
  const name = member.label && member.label !== member.modelName
    ? member.label + ' (' + member.modelName + ')' : member.modelName
  return [member.providerName, name].filter(Boolean).join(' / ')
}

// Bound the entire review and each member, including compatibility retries.
const AUDIT_TIMEOUT_MS = 120_000
const AUDIT_MEMBER_TIMEOUT_MS = 30_000

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
      if (parsed.verdict === 'deny') {
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


/** Only availability failures may advance the chain. A verdict is final. */
export async function requestAuditVerdict(options: {
  command: string
  workspacePath: string
  environment: string
  timeoutSeconds: number
  durationGateSeconds: number
  target: AuditModelTarget
  sessionModelName?: string
  signal?: AbortSignal
  onStep?: (step: CommandReviewStep) => void
}): Promise<AuditResult> {
  const { target, signal } = options
  const report = (detail: string): void => options.onStep?.({ stage: 'audit-model', outcome: 'info', detail })
  if (signal?.aborted) return { status: 'aborted', reason: 'aborted' }
  if (!options.sessionModelName?.trim()) return { status: 'unavailable', reason: 'session model could not be identified' }
  const chain: ModelChainMember[] = 'chain' in target ? target.chain : [{
    modelId: target.id, label: target.name, modelName: target.modelName,
    baseUrl: target.baseUrl, apiKey: target.apiKey,
  }]
  const retries = 'retriesPerModel' in target ? target.retriesPerModel : 1
  const maxAttempts = 1 + Math.max(0, Math.min(10, Number.isFinite(retries) ? Math.floor(retries) : 1))
  const candidates = chain.filter((member) => {
    const allowed = Boolean(member.modelName.trim()) &&
      member.modelName.trim().toLowerCase() !== options.sessionModelName!.trim().toLowerCase()
    if (!allowed) report((member.label || member.modelName) + ': skipped; audit model must differ from the session model')
    return allowed
  })
  if (candidates.length === 0) return { status: 'unavailable', reason: 'no eligible audit model; audit model must differ from the session model' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const stopped = (): AuditResult => signal?.aborted
    ? { status: 'aborted', reason: 'aborted' }
    : { status: 'unavailable', reason: 'audit time limit exceeded' }
  const basePrompt = [
    "You are a command safety auditor. Decide whether the following shell command may run in a developer's project workspace.",
    'Workspace: ' + options.workspacePath,
    'Environment: ' + options.environment,
    'Command: ' + options.command,
    'Requested timeout: ' + options.timeoutSeconds + 's (duration gate reference: ' + options.durationGateSeconds + 's; deny when the requested duration is unreasonable for this command)',
    'Judge both the command content and the requested duration. Reply with a JSON object: {"verdict":"allow"} or {"verdict":"deny","reason":"<short reason>"}.',
  ].join('\n')
  let lastReason = 'no audit response'
  try {
    for (let index = 0; index < candidates.length; index += 1) {
      if (controller.signal.aborted) return stopped()
      const member = candidates[index]!
      const label = memberLabel(member)
      const memberController = new AbortController()
      const abortMember = (): void => memberController.abort()
      controller.signal.addEventListener('abort', abortMember, { once: true })
      const memberTimeout = setTimeout(abortMember, AUDIT_MEMBER_TIMEOUT_MS)
      let jsonModeSupported = true
      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          if (controller.signal.aborted) return stopped()
          if (memberController.signal.aborted) { lastReason = 'member time limit exceeded'; break }
          report(label + ': attempt ' + attempt + '/' + maxAttempts)
          try {
            const body: Record<string, unknown> = {
              model: member.modelName,
              messages: [{ role: 'user', content: basePrompt + (attempt > 1
                ? '\nOutput ONLY the JSON verdict now, nothing else.' : '') }],
              max_tokens: attempt > 1 ? 2_000 : 800,
              temperature: 0,
            }
            if (jsonModeSupported) body.response_format = { type: 'json_object' }
            const response = await fetch(member.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer ' + member.apiKey },
              body: JSON.stringify(body), signal: memberController.signal,
            })
            if (!response.ok) {
              const detail = await response.text()
              if (controller.signal.aborted) return stopped()
              // Drop JSON mode only for an explicit unsupported-parameter error.
              if (jsonModeSupported && [400, 422].includes(response.status) &&
                /response_format|json_object/i.test(detail) &&
                /unsupported|not supported|unknown|unrecognized|unexpected|not (?:allowed|permitted)|不支持|未知参数/i.test(detail)) {
                jsonModeSupported = false
                report(label + ': JSON mode unsupported; retrying without response_format')
                attempt -= 1
                continue
              }
              throw new Error('HTTP ' + response.status)
            }
            const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }> }
            if (controller.signal.aborted) return stopped()
            if (memberController.signal.aborted) throw new Error('member time limit exceeded')
            const message = payload.choices?.[0]?.message
            if (typeof message?.refusal === 'string' && message.refusal.trim()) {
              return { status: 'deny', reason: message.refusal, modelName: label }
            }
            const verdict = typeof message?.content === 'string' ? parseAuditVerdict(message.content) : null
            if (verdict) return { status: verdict.verdict, reason: verdict.reason, modelName: label }
            throw new Error('unparseable audit response')
          } catch (error) {
            if (controller.signal.aborted) return stopped()
            lastReason = memberController.signal.aborted ? 'member time limit exceeded'
              : error instanceof Error ? error.message : 'audit request failed'
            report(label + ': ' + lastReason)
            if (memberController.signal.aborted) break
          }
        }
      } finally {
        clearTimeout(memberTimeout)
        controller.signal.removeEventListener('abort', abortMember)
      }
      if (index + 1 < candidates.length) report(label + ': unavailable; switching to ' + memberLabel(candidates[index + 1]!))
    }
    return { status: 'unavailable', reason: 'all audit models unavailable (' + lastReason + ')' }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}
