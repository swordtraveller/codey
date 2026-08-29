import { runPackageScript, type NodePackageExecutionResult, type PackageManager } from './node-sandbox'
import { truncateOutput } from './sandbox'

export type NodeValidationStatus = 'passed' | 'failed' | 'timed_out' | 'cancelled'

export type NodeValidationCheckInput = {
  script: string
  argv?: string[]
}

export type NodeValidationCheck = {
  script: string
  status: NodeValidationStatus
  exit_code: number
  duration_ms: number
  stdout: string
  stderr: string
}

export type NodeValidationResult = {
  success: boolean
  status: NodeValidationStatus
  summary: {
    total: number
    passed: number
    failed: number
    timed_out: number
    cancelled: number
    duration_ms: number
  }
  checks: NodeValidationCheck[]
}

const maxValidationChecks = 5
const maxValidationLogSize = 1_500

function checkStatus(result: NodePackageExecutionResult, aborted: boolean): NodeValidationStatus {
  if (aborted) return 'cancelled'
  if (result.timed_out) return 'timed_out'
  return result.success ? 'passed' : 'failed'
}

function overallStatus(checks: NodeValidationCheck[]): NodeValidationStatus {
  if (checks.some((check) => check.status === 'cancelled')) return 'cancelled'
  if (checks.some((check) => check.status === 'timed_out')) return 'timed_out'
  if (checks.some((check) => check.status === 'failed')) return 'failed'
  return 'passed'
}

function validateChecks(checks: NodeValidationCheckInput[]): void {
  if (
    checks.length === 0 ||
    checks.length > maxValidationChecks ||
    checks.some((check) => (
      !check ||
      typeof check.script !== 'string' ||
      !Array.isArray(check.argv ?? []) ||
      (check.argv ?? []).some((argument) => typeof argument !== 'string')
    ))
  ) {
    throw new Error('checks must contain between 1 and 5 package script definitions')
  }
}

export async function runNodeValidation(
  projectRoot: string,
  packageManager: PackageManager,
  checks: NodeValidationCheckInput[],
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<NodeValidationResult> {
  validateChecks(checks)
  const startedAt = Date.now()
  const results: NodeValidationCheck[] = []

  for (const check of checks) {
    if (signal?.aborted) break
    const checkStartedAt = Date.now()
    try {
      const result = await runPackageScript(
        projectRoot,
        packageManager,
        check.script,
        check.argv ?? [],
        timeoutSeconds,
        signal,
      )
      results.push({
        script: check.script,
        status: checkStatus(result, signal?.aborted === true),
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        stdout: truncateOutput(result.stdout, maxValidationLogSize),
        stderr: truncateOutput(result.stderr, maxValidationLogSize),
      })
    } catch (error) {
      results.push({
        script: check.script,
        status: signal?.aborted ? 'cancelled' : 'failed',
        exit_code: -1,
        duration_ms: Date.now() - checkStartedAt,
        stdout: '',
        stderr: truncateOutput(error instanceof Error ? error.message : String(error), maxValidationLogSize),
      })
    }
    if (signal?.aborted) break
  }

  const status = signal?.aborted && !results.some((check) => check.status === 'cancelled')
    ? 'cancelled'
    : overallStatus(results)
  const count = (value: NodeValidationStatus): number => results.filter((check) => check.status === value).length

  return {
    success: status === 'passed',
    status,
    summary: {
      total: checks.length,
      passed: count('passed'),
      failed: count('failed'),
      timed_out: count('timed_out'),
      cancelled: count('cancelled') + (checks.length - results.length),
      duration_ms: Date.now() - startedAt,
    },
    checks: results,
  }
}
