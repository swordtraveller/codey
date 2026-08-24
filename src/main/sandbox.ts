import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, win32 } from 'node:path'

export type SandboxProcessResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

export type PythonExecutionResult = {
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
  traceback: string | null
}

export type PythonInstallResult = {
  success: boolean
  installed_versions: Record<string, string>
  log: string
}

export type PythonEnvironmentInfo = {
  python_version: string
  venv_path: string
  sys_path: string[]
  installed_packages: Array<{ name: string; version: string }>
}

export type PythonSymbol = {
  type: 'class' | 'function'
  name: string
  signature: string
  line_start: number
  bases: string[]
}

export type PythonSymbolsResult = {
  symbols: PythonSymbol[]
  truncated: boolean
}

const defaultTimeoutMs = 120_000
const maxOutputSize = 20_000
const environmentTasks = new Map<string, Promise<void>>()

const runnerSource = String.raw`import ast
import importlib.metadata as metadata
import json
import os
import runpy
import sys

mode = sys.argv[1]
project_roots = [os.path.realpath(path) for path in json.loads(sys.argv[2])]
protected_root = os.path.realpath(sys.argv[3])
blocked_roots = [os.path.realpath(path) for path in json.loads(sys.argv[4])]
allow_writes = mode == 'script'

runtime_roots = []
for path in [sys.base_prefix, sys.prefix, os.path.dirname(sys.executable), *sys.path]:
    if path:
        resolved = os.path.realpath(os.path.abspath(path))
        if resolved not in runtime_roots:
            runtime_roots.append(resolved)


def is_within(path, roots):
    for root in roots:
        try:
            if os.path.commonpath([root, path]) == root:
                return True
        except ValueError:
            pass
    return False


def resolve_path(path):
    if path is None:
        path = os.getcwd()
    if isinstance(path, int):
        if path in (0, 1, 2):
            return None
        raise PermissionError('File descriptor access is not allowed')
    return os.path.realpath(os.path.abspath(os.fsdecode(path)))


def check_path(path, write=False, project_only=False):
    resolved = resolve_path(path)
    if resolved is None:
        return
    if write and not allow_writes:
        raise PermissionError('Writing files is not allowed for this operation')
    roots = project_roots if write or project_only else project_roots + runtime_roots
    if not is_within(resolved, roots):
        raise PermissionError('Path is outside the project sandbox')
    if is_within(resolved, blocked_roots):
        raise PermissionError('Path is protected by the project sandbox')
    if write and is_within(resolved, [protected_root]):
        raise PermissionError('The project Python environment is protected')


def uses_dir_fd(arguments, index):
    return len(arguments) > index and arguments[index] not in (-1, None)


def audit(event, arguments):
    if event in {
        'subprocess.Popen', 'os.system', 'os.exec', 'os.spawn', 'os.posix_spawn',
        'os.posix_spawnp', 'os.startfile', 'pty.spawn'
    }:
        raise PermissionError('Starting child processes is not allowed')

    if event == 'open':
        path, mode_value, flags = arguments
        writing = (
            isinstance(mode_value, str) and any(character in mode_value for character in 'wax+')
        ) or (
            isinstance(flags, int)
            and bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
        )
        check_path(path, write=writing)
        return

    if event in {'os.listdir', 'os.scandir', 'os.stat', 'os.lstat', 'os.access', 'os.readlink'}:
        check_path(arguments[0] if arguments else None)
        return

    if event == 'os.chdir':
        check_path(arguments[0], project_only=True)
        return

    if event == 'os.mkdir':
        if uses_dir_fd(arguments, 2):
            raise PermissionError('dir_fd operations are not allowed')
        check_path(arguments[0], write=True)
        return

    if event in {
        'os.remove', 'os.unlink', 'os.rmdir', 'os.rename', 'os.link', 'os.symlink',
        'os.chmod', 'os.truncate'
    }:
        raise PermissionError('Destructive file operations are not allowed')

    if event == 'os.utime':
        if uses_dir_fd(arguments, 3):
            raise PermissionError('dir_fd operations are not allowed')
        check_path(arguments[0], write=True)


sys.addaudithook(audit)

if mode == 'code':
    source = sys.stdin.read()
    sys.argv = ['<memory>']
    exec(compile(source, '<memory>', 'exec'), {'__name__': '__main__'})
elif mode == 'script':
    script_path = os.path.realpath(sys.argv[5])
    check_path(script_path, project_only=True)
    sys.path.insert(0, os.path.dirname(script_path))
    sys.argv = [script_path, *sys.argv[6:]]
    runpy.run_path(script_path, run_name='__main__')
elif mode == 'symbols':
    file_path = os.path.realpath(sys.argv[5])
    check_path(file_path, project_only=True)
    with open(file_path, encoding='utf-8') as source_file:
        tree = ast.parse(source_file.read(), filename=file_path)
    symbols = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            all_bases = [ast.unparse(base) for base in node.bases]
            bases = [base[:100] for base in all_bases[:5]]
            signature = (f"{node.name}({', '.join(all_bases)})" if all_bases else node.name)[:300]
            symbols.append({
                'type': 'class', 'name': node.name[:100], 'signature': signature,
                'line_start': node.lineno, 'bases': bases,
            })
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            prefix = 'async ' if isinstance(node, ast.AsyncFunctionDef) else ''
            symbols.append({
                'type': 'function', 'name': node.name[:100],
                'signature': f"{prefix}{node.name}({ast.unparse(node.args)})"[:300],
                'line_start': node.lineno, 'bases': [],
            })
    symbols = sorted(symbols, key=lambda item: item['line_start'])
    print(json.dumps({
        'symbols': symbols[:20],
        'truncated': len(symbols) > 20,
    }))
elif mode == 'env_info':
    packages = sorted(
        ({'name': dist.metadata['Name'] or 'unknown', 'version': dist.version} for dist in metadata.distributions()),
        key=lambda item: item['name'].lower(),
    )
    packages = [
        {'name': item['name'][:100], 'version': item['version'][:50]}
        for item in packages
    ]
    if len(packages) > 50:
        packages = packages[:49] + [{'name': '[output truncated]', 'version': ''}]
    print(json.dumps({
        'python_version': sys.version.split()[0],
        'venv_path': sys.prefix,
        'sys_path': [path[:300] for path in sys.path[:20]],
        'installed_packages': packages,
    }))
elif mode == 'package_versions':
    versions = {}
    for name in json.loads(sys.stdin.read()):
        try:
            versions[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            pass
    print(json.dumps(versions))
else:
    raise ValueError('Unknown runner mode')
`

export function truncateOutput(value: string, limit = maxOutputSize): string {
  if (value.length <= limit) {
    return value
  }
  return `${value.slice(0, limit)}\n[output truncated]`
}

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

export function safeResolvePath(projectRoot: string, inputPath: string): string {
  if (!inputPath || inputPath.includes('\0')) {
    throw new Error('Path is required')
  }
  const segments = inputPath.split(/[\\/]+/)
  if (
    isAbsolute(inputPath) ||
    win32.isAbsolute(inputPath) ||
    /^[A-Za-z]:/.test(inputPath) ||
    segments.some((segment) => segment === '..')
  ) {
    throw new Error('Path is outside the project root')
  }
  const root = resolve(projectRoot)
  const target = resolve(root, inputPath)
  if (!isWithin(root, target)) {
    throw new Error('Path is outside the project root')
  }
  return target
}

export async function safeResolveExistingPath(
  projectRoot: string,
  inputPath: string,
): Promise<string> {
  const root = await realpath(safeResolvePath(projectRoot, '.'))
  const target = await realpath(safeResolvePath(root, inputPath))
  if (!isWithin(root, target)) {
    throw new Error('Path is outside the project root')
  }
  return target
}

function appendOutput(current: string, chunk: Buffer | string): string {
  if (current.length > maxOutputSize) {
    return current
  }
  return `${current}${chunk.toString()}`.slice(0, maxOutputSize + 1)
}

async function nearestExistingPath(target: string): Promise<string> {
  let current = target
  while (true) {
    try {
      return await realpath(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      const parent = dirname(current)
      if (parent === current) {
        throw error
      }
      current = parent
    }
  }
}

export async function safeResolveWritablePath(
  projectRoot: string,
  inputPath: string,
): Promise<string> {
  const root = await realpath(safeResolvePath(projectRoot, '.'))
  const target = safeResolvePath(root, inputPath)
  const existingPath = await nearestExistingPath(target)
  if (!isWithin(root, existingPath)) {
    throw new Error('Path is outside the project root')
  }
  return target
}

export function terminateSandboxProcess(child: ChildProcess): Promise<void> {
  if (child.killed) return Promise.resolve()
  if (process.platform === 'win32' && child.pid) {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        if (!child.killed) {
          try {
            child.kill()
          } catch {
            // The process may already have exited after taskkill completed.
          }
        }
        resolve()
      }
      killer.once('error', finish)
      killer.once('close', finish)
      setTimeout(finish, 2_000)
    })
  }
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return Promise.resolve()
    } catch {
      // Fall back to terminating the direct child.
    }
  }
  child.kill()
  return Promise.resolve()
}
function abortError(): Error {
  const error = new Error('Operation stopped')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

export function runSandboxProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  input?: string,
  signal?: AbortSignal,
): Promise<SandboxProcessResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    if (signal?.aborted) {
      rejectProcess(abortError())
      return
    }
    const startedAt = Date.now()
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    const onAbort = (): void => {
      if (!settled) {
        aborted = true
        terminateSandboxProcess(child)
      }
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true
        terminateSandboxProcess(child)
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
      resolveProcess({
        exitCode,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

function venvPath(projectRoot: string): string {
  return safeResolvePath(projectRoot, 'agent_venv')
}

function pythonPath(projectRoot: string): string {
  const venv = venvPath(projectRoot)
  return process.platform === 'win32'
    ? safeResolvePath(venv, 'Scripts/python.exe')
    : safeResolvePath(venv, 'bin/python')
}

function pipPath(projectRoot: string): string {
  const venv = venvPath(projectRoot)
  return process.platform === 'win32'
    ? safeResolvePath(venv, 'Scripts/pip.exe')
    : safeResolvePath(venv, 'bin/pip')
}

function runnerPath(projectRoot: string): string {
  return safeResolvePath(venvPath(projectRoot), '.codey_runner.py')
}

async function createVenv(projectRoot: string, signal?: AbortSignal): Promise<void> {
  const candidates = process.platform === 'win32'
    ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }]
  let failure = ''
  for (const candidate of candidates) {
    try {
      const result = await runSandboxProcess(
        candidate.command,
        [...candidate.args, '-m', 'venv', venvPath(projectRoot)],
        projectRoot,
        defaultTimeoutMs,
        undefined,
        undefined,
        signal,
      )
      if (!result.timedOut && result.exitCode === 0) {
        return
      }
      failure = result.stderr || result.stdout
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Python was not found'
    }
  }
  throw new Error(
    `Unable to create project Python environment${failure ? `: ${truncateOutput(failure)}` : ''}`,
  )
}

async function initializePythonEnvironment(projectRoot: string, signal?: AbortSignal): Promise<void> {
  try {
    await safeResolveExistingPath(projectRoot, 'agent_venv')
    await access(pythonPath(projectRoot))
    await access(pipPath(projectRoot))
  } catch {
    await createVenv(projectRoot, signal)
    await safeResolveExistingPath(projectRoot, 'agent_venv')
    await access(pythonPath(projectRoot))
    await access(pipPath(projectRoot))
  }
  await safeResolveWritablePath(projectRoot, 'agent_venv/.codey_runner.py')
  await writeFile(runnerPath(projectRoot), runnerSource, 'utf8')
}

export async function ensurePythonEnvironment(projectRoot: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  const root = await safeResolveExistingPath(projectRoot, '.')
  const existingTask = environmentTasks.get(root)
  if (existingTask) {
    await existingTask
    throwIfAborted(signal)
    return
  }
  const task = initializePythonEnvironment(root, signal).finally(() => environmentTasks.delete(root))
  environmentTasks.set(root, task)
  await task
  throwIfAborted(signal)
}

function normalizeTimeout(timeoutSeconds: number): number {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) {
    throw new Error('timeout must be between 1 and 120 seconds')
  }
  return Math.round(timeoutSeconds * 1000)
}

function tracebackFrom(stderr: string): string | null {
  const index = stderr.lastIndexOf('Traceback (most recent call last):')
  return index === -1 ? null : truncateOutput(stderr.slice(index))
}

async function projectRoots(projectFolders: string[]): Promise<string[]> {
  return Promise.all(projectFolders.map((folder) => safeResolveExistingPath(folder, '.')))
}

function runnerArguments(mode: string, roots: string[], root: string): string[] {
  return [
    '-I',
    '-u',
    runnerPath(root),
    mode,
    JSON.stringify(roots),
    venvPath(root),
    JSON.stringify(roots.map((folder) => safeResolvePath(folder, '.git'))),
  ]
}

async function runSandboxMode(
  root: string,
  roots: string[],
  mode: string,
  modeArgs: string[],
  timeoutMs: number,
  cwd: string,
  input?: string,
  signal?: AbortSignal,
): Promise<SandboxProcessResult> {
  const temporaryDirectory = await safeResolveWritablePath(root, '.agent_tmp')
  await ensurePythonEnvironment(root, signal)
  throwIfAborted(signal)
  await mkdir(temporaryDirectory, { recursive: true })
  return runSandboxProcess(
    pythonPath(root),
    [...runnerArguments(mode, roots, root), ...modeArgs],
    cwd,
    timeoutMs,
    {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
      TMPDIR: temporaryDirectory,
      HOME: temporaryDirectory,
      USERPROFILE: temporaryDirectory,
      XDG_CACHE_HOME: temporaryDirectory,
    },
    input,
    signal,
  )
}

function executionResult(result: SandboxProcessResult, timeoutMs: number): PythonExecutionResult {
  const stderr = result.timedOut
    ? truncateOutput(`${result.stderr}${result.stderr ? '\n' : ''}Execution timed out after ${timeoutMs / 1000} seconds`)
    : result.stderr
  return {
    stdout: result.stdout,
    stderr,
    exit_code: result.timedOut ? -1 : (result.exitCode ?? -1),
    duration_ms: result.durationMs,
    traceback: tracebackFrom(stderr),
  }
}

export async function executePythonCode(
  projectRoot: string,
  projectFolders: string[],
  workingRoot: string,
  code: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<PythonExecutionResult> {
  const root = await safeResolveExistingPath(projectRoot, '.')
  const roots = await projectRoots(projectFolders)
  const workingDirectory = await safeResolveExistingPath(workingRoot, '.')
  if (!roots.includes(workingDirectory)) {
    throw new Error('Working directory is outside the project folders')
  }
  const timeoutMs = normalizeTimeout(timeoutSeconds)
  const result = await runSandboxMode(root, roots, 'code', [], timeoutMs, workingDirectory, code, signal)
  return executionResult(result, timeoutMs)
}

export async function runPythonScript(
  projectRoot: string,
  projectFolders: string[],
  scriptRoot: string,
  filePath: string,
  argv: string[],
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<PythonExecutionResult> {
  if (!filePath.toLowerCase().endsWith('.py')) {
    throw new Error('file_path must reference a .py file')
  }
  const root = await safeResolveExistingPath(projectRoot, '.')
  const selectedRoot = await safeResolveExistingPath(scriptRoot, '.')
  const script = await safeResolveExistingPath(selectedRoot, filePath)
  const roots = await projectRoots(projectFolders)
  if (!roots.includes(selectedRoot)) {
    throw new Error('Script folder is outside the project folders')
  }
  const timeoutMs = normalizeTimeout(timeoutSeconds)
  const result = await runSandboxMode(root, roots, 'script', [script, ...argv], timeoutMs, selectedRoot, undefined, signal)
  return executionResult(result, timeoutMs)
}

function isPackageName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:===|==|~=|!=|>=|<=|>|<)?[A-Za-z0-9.*+!_-]*$/.test(value)
}

function distributionName(specifier: string): string {
  return specifier.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0] ?? specifier
}

export async function installPythonPackages(
  projectRoot: string,
  packages: string[],
  signal?: AbortSignal,
): Promise<PythonInstallResult> {
  if (packages.length === 0 || packages.length > 20 || packages.some((item) => !isPackageName(item))) {
    throw new Error('Provide 1 to 20 valid Python package names')
  }
  const root = await safeResolveExistingPath(projectRoot, '.')
  const temporaryDirectory = await safeResolveWritablePath(root, '.agent_tmp')
  await ensurePythonEnvironment(root, signal)
  throwIfAborted(signal)
  await mkdir(temporaryDirectory, { recursive: true })
  const result = await runSandboxProcess(
    pipPath(root),
    ['install', '--isolated', '--disable-pip-version-check', '--no-cache-dir', ...packages],
    root,
    defaultTimeoutMs,
    { ...process.env, TEMP: temporaryDirectory, TMP: temporaryDirectory, TMPDIR: temporaryDirectory },
    undefined,
    signal,
  )
  const roots = [root]
  const names = packages.map(distributionName)
  const versionResult = await runSandboxMode(
    root,
    roots,
    'package_versions',
    [],
    30_000,
    root,
    JSON.stringify(names),
    signal,
  )
  let installedVersions: Record<string, string> = {}
  try {
    installedVersions = JSON.parse(versionResult.stdout) as Record<string, string>
  } catch {
    // Keep an empty version map when metadata cannot be read.
  }
  const log = truncateOutput([result.stdout, result.stderr].filter(Boolean).join('\n'))
  return {
    success: !result.timedOut && result.exitCode === 0,
    installed_versions: installedVersions,
    log: result.timedOut ? truncateOutput(`${log}\npip install timed out`) : log,
  }
}

export async function getPythonEnvironmentInfo(
  projectRoot: string,
  signal?: AbortSignal,
): Promise<PythonEnvironmentInfo> {
  const root = await safeResolveExistingPath(projectRoot, '.')
  const result = await runSandboxMode(root, [root], 'env_info', [], 30_000, root, undefined, signal)
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(result.stderr || 'Unable to inspect Python environment')
  }
  return JSON.parse(result.stdout) as PythonEnvironmentInfo
}

export async function listPythonSymbols(
  projectRoot: string,
  fileRoot: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<PythonSymbolsResult> {
  if (!filePath.toLowerCase().endsWith('.py')) {
    throw new Error('file_path must reference a .py file')
  }
  const root = await safeResolveExistingPath(projectRoot, '.')
  const selectedRoot = await safeResolveExistingPath(fileRoot, '.')
  const target = await safeResolveExistingPath(selectedRoot, filePath)
  const result = await runSandboxMode(root, [selectedRoot], 'symbols', [target], 30_000, selectedRoot, undefined, signal)
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(result.stderr || 'Unable to parse Python symbols')
  }
  return JSON.parse(result.stdout) as PythonSymbolsResult
}
