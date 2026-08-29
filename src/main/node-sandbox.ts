import { spawn } from 'node:child_process'
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  runSandboxProcess,
  terminateSandboxProcess,
  safeResolveExistingPath,
  safeResolveWritablePath,
  truncateOutput,
  type SandboxProcessResult,
} from './sandbox'

export type PackageManager = 'npm' | 'pnpm'
export type PackageCommand = 'install' | 'ci' | 'update' | 'list' | 'outdated'

export type NodePackageExecutionResult = {
  success: boolean
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
  timed_out: boolean
}

const maxArgumentLength = 500
const maxPackageCount = 20

const nodeGuardSource = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const sandboxRoot = path.resolve(process.env.CODEY_NODE_SANDBOX_ROOT || process.cwd())
const enforce = Boolean(process.env.npm_lifecycle_event)
const originalExistsSync = fs.existsSync.bind(fs)
const originalRealpathNative = fs.realpath.native
const originalRealpathSyncNative = (fs.realpathSync.native || fs.realpathSync).bind(fs.realpathSync)
const allowedReadRoots = [
  path.dirname(process.execPath),
  ...(process.env.CODEY_NODE_ALLOWED_READ_ROOTS || '').split(path.delimiter).filter(Boolean),
].map((value) => path.resolve(value))
const allowedWriteRoots = [
  sandboxRoot,
  ...(process.env.CODEY_NODE_ALLOWED_WRITE_ROOTS || '').split(path.delimiter).filter(Boolean),
].map((value) => path.resolve(value))
const blockedNames = new Set(['.git', 'agent_venv'])

function isWithin(root, target) {
  const relativePath = path.relative(root, target)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function resolvePath(value) {
  if (typeof value === 'number') return null
  if (value instanceof URL) value = fileURLToPath(value)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) value = value.toString()
  if (typeof value !== 'string') return null
  const target = path.resolve(process.cwd(), value)
  let current = target
  while (!originalExistsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  try {
    return path.join(originalRealpathSyncNative(current), path.relative(current, target))
  } catch {
    return target
  }
}

function assertPath(value, write) {
  if (!enforce) return
  const target = resolvePath(value)
  if (!target) return
  const parts = path.relative(sandboxRoot, target).split(/[\\/]+/)
  if (parts.some((part) => blockedNames.has(part.toLowerCase()))) {
    throw new Error('Node sandbox denied access to a protected project path')
  }
  if (write ? !allowedWriteRoots.some((root) => isWithin(root, target)) : !isWithin(sandboxRoot, target) && !allowedReadRoots.some((root) => isWithin(root, target))) {
    throw new Error('Node sandbox denied access outside the package workspace')
  }
}

function isSandboxAncestor(value) {
  const target = resolvePath(value)
  return Boolean(target && isWithin(target, sandboxRoot))
}

function wrap(target, name, indexes, write = false) {
  const original = target[name]
  if (typeof original !== 'function') return
  target[name] = function (...args) {
    for (const index of indexes) assertPath(args[index], write)
    return original.apply(this, args)
  }
}

for (const name of [
  'readFile', 'readFileSync', 'createReadStream',
]) wrap(fs, name, [0])
function wrapDirectoryRead(target, name, asynchronous) {
  const original = target[name]
  if (typeof original !== 'function') return
  target[name] = function (...args) {
    try {
      assertPath(args[0], false)
    } catch {
      if (asynchronous) {
        const callback = args.find((value) => typeof value === 'function')
        if (callback) process.nextTick(() => callback(null, []))
        return
      }
      return []
    }
    return original.apply(this, args)
  }
}
wrapDirectoryRead(fs, 'readdir', true)
wrapDirectoryRead(fs, 'readdirSync', false)
function wrapProbe(target, name, fallback) {
  const original = target[name]
  if (typeof original !== 'function') return
  target[name] = function (...args) {
    try {
      assertPath(args[0], false)
    } catch {
      if (isSandboxAncestor(args[0])) return original.apply(this, args)
      const targetPath = resolvePath(args[0]) || String(args[0])
      const unavailable = Object.assign(new Error('Path is unavailable: ' + name + ' ' + targetPath), { code: 'ENOENT' })
      const callback = args.find((value) => typeof value === 'function')
      if (callback) {
        process.nextTick(() => callback(unavailable))
        return
      }
      if (fallback !== undefined) return fallback
      throw unavailable
    }
    return original.apply(this, args)
  }
}
wrapProbe(fs, 'existsSync', false)
for (const name of ['stat', 'statSync', 'lstat', 'lstatSync', 'access', 'accessSync', 'realpath', 'realpathSync']) {
  wrapProbe(fs, name)
}
for (const name of [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync',
  'rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'truncate', 'truncateSync',
  'chmod', 'chmodSync', 'utimes', 'utimesSync', 'createWriteStream',
]) wrap(fs, name, [0], true)
for (const name of ['rename', 'renameSync', 'copyFile', 'copyFileSync', 'link', 'linkSync', 'cp', 'cpSync']) {
  wrap(fs, name, [0, 1], true)
}
for (const name of ['open', 'openSync']) wrap(fs, name, [0])
// Preserve Node's native realpath helpers used by package-manager internals.
if (originalRealpathNative) fs.realpath.native = originalRealpathNative
if (originalRealpathSyncNative) fs.realpathSync.native = originalRealpathSyncNative

const promises = fs.promises
for (const name of ['readFile', 'open']) wrap(promises, name, [0])
const originalPromisesReaddir = promises.readdir
promises.readdir = function (...args) {
  try {
    assertPath(args[0], false)
  } catch {
    return Promise.resolve([])
  }
  return originalPromisesReaddir.apply(this, args)
}
for (const name of ['stat', 'lstat', 'access', 'realpath']) {
  const original = promises[name]
  promises[name] = function (...args) {
    try {
      assertPath(args[0], false)
    } catch {
      if (isSandboxAncestor(args[0])) return original.apply(this, args)
      const targetPath = resolvePath(args[0]) || String(args[0])
      return Promise.reject(Object.assign(new Error('Path is unavailable: ' + name + ' ' + targetPath), { code: 'ENOENT' }))
    }
    return original.apply(this, args)
  }
}
for (const name of [
  'writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'truncate', 'chmod', 'utimes',
]) wrap(promises, name, [0], true)
for (const name of ['rename', 'copyFile', 'link', 'cp']) wrap(promises, name, [0, 1], true)

const childProcess = require('node:child_process')
function checkChildOptions(options) {
  if (options && typeof options === 'object' && options.cwd !== undefined) assertPath(options.cwd, false)
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[name]
  if (typeof original !== 'function') continue
  childProcess[name] = function (...args) {
    const optionsIndex = name.startsWith('exec') || name === 'fork' ? 1 : 2
    checkChildOptions(args[optionsIndex])
    return original.apply(this, args)
  }
}

const originalChdir = process.chdir
process.chdir = function (directory) {
  assertPath(directory, false)
  return originalChdir.call(this, directory)
}
`

function normalizeTimeout(timeoutSeconds: number): number {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) {
    throw new Error('timeout must be between 1 and 120 seconds')
  }
  return Math.round(timeoutSeconds * 1000)
}

function assertPackageManager(value: string): asserts value is PackageManager {
  if (value !== 'npm' && value !== 'pnpm') {
    throw new Error('package_manager must be npm or pnpm')
  }
}

function assertPackageCommand(value: string): asserts value is PackageCommand {
  if (!['install', 'ci', 'update', 'list', 'outdated'].includes(value)) {
    throw new Error('command must be install, ci, update, list, or outdated')
  }
}

function packagePathCandidates(manager: PackageManager): string[] {
  const directories = (process.env.PATH ?? '').split(';').filter(Boolean)
  return directories.flatMap((directory) => [
    join(directory, `${manager}.cmd`),
    join(directory, `${manager}.exe`),
    join(directory, manager),
  ])
}

async function managerInvocation(manager: PackageManager): Promise<{ command: string; prefixArgs: string[]; readRoot: string }> {
  if (process.platform !== 'win32') {
    return { command: manager, prefixArgs: [], readRoot: dirname(process.execPath) }
  }

  for (const candidate of packagePathCandidates(manager)) {
    try {
      await access(candidate)
      if (!candidate.toLowerCase().endsWith('.cmd')) {
        return { command: candidate, prefixArgs: [], readRoot: dirname(candidate) }
      }
      const shim = await readFile(candidate, 'utf8')
      const cli = shim.match(/"%dp0%\\([^"\r\n]*node_modules\\(?:npm|pnpm)\\[^"\r\n]+)"/i)?.[1]
      if (cli) {
        const root = dirname(candidate)
        const cliPath = join(root, cli)
        let readRoot = root
        try {
          readRoot = await realpath(dirname(dirname(dirname(dirname(cliPath)))))
        } catch {
          // Keep the shim directory when the package path cannot be resolved.
        }
        return {
          command: join(root, 'node.exe'),
          prefixArgs: [cliPath],
          readRoot,
        }
      }
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Unable to locate ${manager}; install it or add it to PATH`)
}

function isSafePackageSpecifier(value: string): boolean {
  return new RegExp('^(?:@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[a-z0-9*^~<>=|._+-]+)?$', 'i').test(value)
}

function validatePackages(packages: string[]): void {
  if (packages.length > maxPackageCount || packages.some((item) => (
    typeof item !== 'string' || item.length === 0 || item.length > maxArgumentLength || !isSafePackageSpecifier(item)
  ))) {
    throw new Error('packages must contain at most 20 valid registry package specifiers')
  }
}

function validateArguments(argv: string[]): void {
  if (argv.length > 20 || argv.some((item) => typeof item !== 'string' || item.length > maxArgumentLength || /[\r\n]/.test(item))) {
    throw new Error('argv must contain at most 20 short arguments')
  }
}

function resultFromProcess(result: SandboxProcessResult): NodePackageExecutionResult {
  return {
    success: !result.timedOut && result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.timedOut ? -1 : (result.exitCode ?? -1),
    duration_ms: result.durationMs,
    timed_out: result.timedOut,
  }
}

async function prepareNodeSandbox(root: string, withGuard = true): Promise<{ guardPath?: string; temporaryDirectory: string }> {
  const temporaryDirectory = await safeResolveWritablePath(root, '.agent_tmp')
  await mkdir(temporaryDirectory, { recursive: true })
  if (!withGuard) return { temporaryDirectory }
  const guardPath = await safeResolveWritablePath(root, '.agent_tmp/node-sandbox-guard.cjs')
  await writeFile(guardPath, nodeGuardSource, 'utf8')
  return { guardPath, temporaryDirectory }
}

function sandboxEnvironment(root: string, temporaryDirectory: string, managerRoot: string, guardPath?: string): NodeJS.ProcessEnv {
  const hostHome = process.env.USERPROFILE ?? process.env.HOME
  const hostCargoHome = process.env.CARGO_HOME ?? (hostHome ? join(hostHome, '.cargo') : undefined)
  const hostRustupHome = process.env.RUSTUP_HOME ?? (hostHome ? join(hostHome, '.rustup') : undefined)
  const inheritedEnvironment = Object.fromEntries(
    [
      'PATH', 'Path', 'SystemRoot', 'ComSpec', 'COMSPEC', 'PATHEXT', 'LOCALAPPDATA', 'APPDATA', 'ProgramData',
      'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
      'RUSTUP_TOOLCHAIN', 'RUSTUP_DIST_SERVER', 'RUSTUP_UPDATE_ROOT',
      'VSINSTALLDIR', 'VCINSTALLDIR', 'VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSDKVersion',
      'INCLUDE', 'LIB', 'LIBPATH',
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key] as string]),
  )
  const environment: NodeJS.ProcessEnv = {
    ...inheritedEnvironment,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    npm_config_global: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_cache: join(temporaryDirectory, 'npm-cache'),
    npm_config_tmp: temporaryDirectory,
    npm_config_userconfig: join(temporaryDirectory, '.npmrc'),
    npm_config_globalconfig: join(temporaryDirectory, '.npm-globalrc'),
    pnpm_config_global: 'false',
    pnpm_config_ignore_scripts: 'true',
    pnpm_config_store_dir: join(temporaryDirectory, 'pnpm-store'),
    PNPM_HOME: temporaryDirectory,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
    XDG_CACHE_HOME: temporaryDirectory,
    ...(hostCargoHome ? { CARGO_HOME: hostCargoHome } : {}),
    ...(hostRustupHome ? { RUSTUP_HOME: hostRustupHome } : {}),
    CODEY_NODE_SANDBOX_ROOT: root,
    CODEY_NODE_ALLOWED_READ_ROOTS: [managerRoot, temporaryDirectory].join(process.platform === 'win32' ? ';' : ':'),
    CODEY_NODE_ALLOWED_WRITE_ROOTS: temporaryDirectory,
  }
  if (guardPath) {
    environment.NODE_OPTIONS = '--require=' + guardPath.replaceAll('\\', '/')
  } else {
    delete environment.NODE_OPTIONS
  }
  return environment
}

async function readPackageScripts(root: string): Promise<Record<string, string>> {
  let raw: string
  try {
    raw = await readFile(join(root, 'package.json'), 'utf8')
  } catch {
    throw new Error('package.json was not found in the selected project folder')
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(raw)
  } catch {
    throw new Error('package.json is not valid JSON')
  }
  const scripts = (manifest as { scripts?: unknown })?.scripts
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return {}
  return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

export async function runPackageManagerCommand(
  projectRoot: string,
  packageManager: PackageManager,
  command: PackageCommand,
  packages: string[] = [],
  timeoutSeconds = 120,
  signal?: AbortSignal,
): Promise<NodePackageExecutionResult> {
  assertPackageManager(packageManager)
  assertPackageCommand(command)
  validatePackages(packages)
  if (command === 'ci' && packages.length > 0) throw new Error('packages are not supported with the ci command')
  if ((command === 'list' || command === 'outdated') && packages.length > 0) throw new Error(`packages are not supported with the ${command} command`)
  const root = await safeResolveExistingPath(projectRoot, '.')
  const { command: executable, prefixArgs, readRoot } = await managerInvocation(packageManager)
  const { temporaryDirectory } = await prepareNodeSandbox(root, false)
  const args: string[] = [...prefixArgs, command]
  if (packageManager === 'pnpm' && command === 'ci') {
    args.splice(args.length - 1, 1, 'install')
    args.push('--frozen-lockfile', '--ignore-scripts')
  } else if (command === 'install' || command === 'ci' || command === 'update') {
    args.push('--ignore-scripts')
  }
  if (command === 'install' || command === 'update') args.push(...packages)
  const result = await runSandboxProcess(executable, args, root, normalizeTimeout(timeoutSeconds), sandboxEnvironment(root, temporaryDirectory, readRoot), undefined, signal)
  return resultFromProcess(result)
}

export type RunningNodePackageScript = {
  pid: number | null
  onOutput(listener: (stream: 'stdout' | 'stderr', chunk: string) => void): () => void
  stop(): Promise<void>
  done: Promise<NodePackageExecutionResult>
}

function appendProcessOutput(current: string, chunk: Buffer | string): string {
  if (current.endsWith('[output truncated]')) return current
  return truncateOutput(`${current}${chunk.toString()}`)
}

async function preparePackageScript(
  projectRoot: string,
  packageManager: PackageManager,
  script: string,
  argv: string[],
): Promise<{ root: string; executable: string; args: string[]; environment: NodeJS.ProcessEnv }> {
  assertPackageManager(packageManager)
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(script)) throw new Error('script must be a package.json script name')
  validateArguments(argv)
  const root = await safeResolveExistingPath(projectRoot, '.')
  const scripts = await readPackageScripts(root)
  if (!Object.hasOwn(scripts, script)) throw new Error(`Script '${script}' is not defined in package.json`)
  const { command: executable, prefixArgs, readRoot } = await managerInvocation(packageManager)
  const { temporaryDirectory, guardPath } = await prepareNodeSandbox(root)
  const args: string[] = [...prefixArgs, 'run', script]
  if (argv.length > 0) args.push('--', ...argv)
  return {
    root,
    executable,
    args,
    environment: sandboxEnvironment(root, temporaryDirectory, readRoot, guardPath),
  }
}

export async function startPackageScript(
  projectRoot: string,
  packageManager: PackageManager,
  script: string,
  argv: string[] = [],
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void,
): Promise<RunningNodePackageScript> {
  const prepared = await preparePackageScript(projectRoot, packageManager, script, argv)
  const child = spawn(prepared.executable, prepared.args, {
    cwd: prepared.root,
    env: prepared.environment,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let stopped = false
  let settled = false
  let resolveDone: ((result: NodePackageExecutionResult) => void) | null = null
  const listeners = new Set<(stream: 'stdout' | 'stderr', chunk: string) => void>()
  if (onOutput) listeners.add(onOutput)
  const notify = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
    const text = chunk.toString()
    if (stream === 'stdout') stdout = appendProcessOutput(stdout, text)
    else stderr = appendProcessOutput(stderr, text)
    for (const listener of listeners) listener(stream, text)
  }
  const startedAt = Date.now()
  const done = new Promise<NodePackageExecutionResult>((resolveResult, rejectResult) => {
    resolveDone = resolveResult
    child.stdout?.on('data', (chunk: Buffer | string) => notify('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => notify('stderr', chunk))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      if (stopped) {
        resolveResult({ success: false, stdout, stderr: `${stderr}\n${error.message}`.trim(), exit_code: -1, duration_ms: Date.now() - startedAt, timed_out: false })
      } else {
        rejectResult(error)
      }
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      resolveResult({
        success: !stopped && exitCode === 0,
        stdout,
        stderr,
        exit_code: stopped ? -1 : (exitCode ?? -1),
        duration_ms: Date.now() - startedAt,
        timed_out: false,
      })
    })
  })
  let stopPromise: Promise<void> | null = null
  return {
    pid: child.pid ?? null,
    onOutput(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stop() {
      if (stopPromise) return stopPromise
      if (settled) return Promise.resolve()
      stopped = true
      stopPromise = (async () => {
        const startupDelay = 1_000 - (Date.now() - startedAt)
        if (process.platform === 'win32' && startupDelay > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, startupDelay))
        }
        await terminateSandboxProcess(child)
        await Promise.race([
          done.then(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
        ])
        child.stdout?.destroy()
        child.stderr?.destroy()
        if (!settled) {
          settled = true
          resolveDone?.({
            success: false,
            stdout,
            stderr,
            exit_code: -1,
            duration_ms: Date.now() - startedAt,
            timed_out: false,
          })
        }
      })()
      return stopPromise
    },
    done,
  }
}
export async function runPackageScript(
  projectRoot: string,
  packageManager: PackageManager,
  script: string,
  argv: string[] = [],
  timeoutSeconds = 120,
  signal?: AbortSignal,
): Promise<NodePackageExecutionResult> {
  const prepared = await preparePackageScript(projectRoot, packageManager, script, argv)
  const result = await runSandboxProcess(
    prepared.executable,
    prepared.args,
    prepared.root,
    normalizeTimeout(timeoutSeconds),
    prepared.environment,
    undefined,
    signal,
  )
  return resultFromProcess(result)
}

export function packageResultSummary(result: NodePackageExecutionResult): string {
  return truncateOutput(JSON.stringify(result))
}
