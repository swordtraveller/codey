import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { safeResolveExistingPath, safeResolveWritablePath, truncateOutput } from './sandbox'

type GitProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
}

const gitTimeoutMs = 30_000
const gitCommitTimeoutMs = 120_000
const maxGitPaths = 100
const maxGitOutputSize = 12_000
const blockedPathNames = new Set(['.git', 'agent_venv', '.agent_tmp', '.venv', 'venv', '__pycache__', 'node_modules'])

function killChild(child: ChildProcess): void {
  if (!child.killed) {
    child.kill()
  }
}

function abortError(): Error {
  const error = new Error('Operation stopped')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function appendOutput(current: string, chunk: Buffer | string): string {
  if (current.length > maxGitOutputSize) {
    return current
  }
  return `${current}${chunk.toString()}`.slice(0, maxGitOutputSize + 1)
}
function gitError(result: GitProcessResult): Error {
  return new Error(result.stderr.trim() || result.stdout.trim() || `Git exited with code ${result.exitCode}`)
}

function runGit(
  repositoryRoot: string,
  args: string[],
  acceptedExitCodes = [0],
  timeoutMs = gitTimeoutMs,
  signal?: AbortSignal,
): Promise<GitProcessResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    if (signal?.aborted) {
      rejectProcess(abortError())
      return
    }
    const child = spawn('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        GIT_EDITOR: 'true',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
      },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false
    const onAbort = (): void => {
      if (!settled) {
        aborted = true
        killChild(child)
      }
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true
        killChild(child)
      }
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = appendOutput(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = appendOutput(stderr, chunk)
    })
    child.once('error', (error) => {
      if (!settled) {
        settled = true
        cleanup()
        rejectProcess(aborted ? abortError() : error)
      }
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      cleanup()
      if (aborted) {
        rejectProcess(abortError())
        return
      }
      if (timedOut) {
        rejectProcess(new Error('Git command timed out'))
        return
      }
      const result = {
        exitCode: exitCode ?? -1,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
      }
      if (!acceptedExitCodes.includes(result.exitCode)) {
        rejectProcess(gitError(result))
        return
      }
      resolveProcess(result)
    })
  })
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

async function repositoryRoot(workspaceRoot: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  const root = await safeResolveExistingPath(workspaceRoot, '.')
  try {
    await lstat(resolve(root, '.git'))
  } catch {
    throw new Error('The selected project folder is not a Git repository root')
  }
  const detected = (await runGit(root, ['rev-parse', '--show-toplevel'], [0], gitTimeoutMs, signal)).stdout.trim()
  if (!detected || !samePath(root, await realpath(detected))) {
    throw new Error('The selected project folder must be the Git repository root')
  }
  return root
}

function assertExplicitPath(inputPath: string): void {
  if (
    !inputPath.trim()
    || inputPath.length > 500
    || inputPath.startsWith('-')
    || inputPath === '.'
    || inputPath === './'
    || inputPath === '.\\'
  ) {
    throw new Error('git_add requires explicit file paths; repository-wide paths are not allowed')
  }
  const segments = inputPath.split(/[\\/]+/)
  if (segments.some((segment) => blockedPathNames.has(segment.toLowerCase()))) {
    throw new Error('Path is not available to the coding agent')
  }
}

async function normalizeAddPaths(root: string, paths: string[], signal?: AbortSignal): Promise<string[]> {
  if (paths.length === 0 || paths.length > maxGitPaths || paths.some((path) => typeof path !== 'string')) {
    throw new Error(`paths must contain between 1 and ${maxGitPaths} file paths`)
  }

  const normalizedPaths: string[] = []
  for (const inputPath of paths) {
    throwIfAborted(signal)
    assertExplicitPath(inputPath)
    const target = await safeResolveWritablePath(root, inputPath)
    const normalized = relative(root, target).split(sep).join('/')
    if (!normalized) {
      throw new Error('git_add requires explicit file paths')
    }
    try {
      const entry = await lstat(target)
      if (!entry.isFile()) {
        throw new Error(`git_add only accepts files: ${inputPath}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      await runGit(root, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', normalized], [0], gitTimeoutMs, signal)
    }
    if (!normalizedPaths.includes(normalized)) {
      normalizedPaths.push(normalized)
    }
  }
  return normalizedPaths
}

export async function gitStatus(workspaceRoot: string, signal?: AbortSignal): Promise<{ status: string }> {
  const root = await repositoryRoot(workspaceRoot, signal)
  const result = await runGit(root, ['status', '--short', '--branch', '--untracked-files=all'], [0], gitTimeoutMs, signal)
  return { status: result.stdout.trimEnd() }
}

export async function gitDiff(workspaceRoot: string, staged: boolean, signal?: AbortSignal): Promise<{ staged: boolean; diff: string }> {
  const root = await repositoryRoot(workspaceRoot, signal)
  const args = ['diff', '--no-ext-diff', '--no-textconv']
  if (staged) {
    args.push('--cached')
  }
  const result = await runGit(root, args, [0], gitTimeoutMs, signal)
  return { staged, diff: result.stdout.trimEnd() }
}

export async function gitAdd(
  workspaceRoot: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<{ success: true; staged_paths: string[]; status: string }> {
  const root = await repositoryRoot(workspaceRoot, signal)
  const normalizedPaths = await normalizeAddPaths(root, paths, signal)
  await runGit(root, ['--literal-pathspecs', 'add', '--', ...normalizedPaths], [0], gitTimeoutMs, signal)
  const status = await runGit(root, ['status', '--short', '--untracked-files=all'], [0], gitTimeoutMs, signal)
  return { success: true, staged_paths: normalizedPaths, status: status.stdout.trimEnd() }
}

export async function gitCommit(
  workspaceRoot: string,
  message: string,
  signal?: AbortSignal,
): Promise<{ success: true; commit: string; output: string }> {
  const normalizedMessage = message.trim()
  if (!normalizedMessage || normalizedMessage.length > 5_000) {
    throw new Error('message must contain between 1 and 5000 characters')
  }
  const root = await repositoryRoot(workspaceRoot, signal)
  const staged = await runGit(
    root,
    ['diff', '--cached', '--quiet', '--exit-code', '--no-ext-diff', '--no-textconv'],
    [0, 1],
    gitTimeoutMs,
    signal,
  )
  if (staged.exitCode === 0) {
    throw new Error('Cannot create a commit because the staging area is empty')
  }
  const result = await runGit(
    root,
    ['-c', 'core.hooksPath=.agent_tmp/disabled-git-hooks', 'commit', '--no-gpg-sign', '--no-verify', '-m', normalizedMessage],
    [0],
    gitCommitTimeoutMs,
    signal,
  )
  const commit = (await runGit(root, ['rev-parse', 'HEAD'], [0], gitTimeoutMs, signal)).stdout.trim()
  return { success: true, commit, output: result.stdout.trimEnd() }
}

export async function gitLog(
  workspaceRoot: string,
  maxCount: number,
  signal?: AbortSignal,
): Promise<{ log: string }> {
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 50) {
    throw new Error('max_count must be an integer between 1 and 50')
  }
  const root = await repositoryRoot(workspaceRoot, signal)
  const result = await runGit(root, [
    'log',
    `--max-count=${maxCount}`,
    '--date=iso-strict',
    '--pretty=format:%H%x09%ad%x09%an%x09%s',
  ], [0], gitTimeoutMs, signal)
  return { log: result.stdout.trimEnd() }
}

export async function gitGetCurrentBranch(
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<{ branch: string | null; detached: boolean }> {
  const root = await repositoryRoot(workspaceRoot, signal)
  const result = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1], gitTimeoutMs, signal)
  const branch = result.exitCode === 0 ? result.stdout.trim() : null
  return { branch, detached: branch === null }
}
