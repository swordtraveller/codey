import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaultContextManagementConfig, defaultModelConfig } from '../src/shared/types'
import { locaUpstreamEndpoint, startLocaContextProxy, type LocaProxy } from '../src/main/loca-proxy'

type Strategy = 'builtin' | 'rhai'
export type Arguments = {
  official: boolean
  smoke: boolean
  strategy: Strategy
  config: string
  configProvided: boolean
  filesystemOnly: boolean
  longContext: boolean
  fixtureContextTokens?: number
  task?: string
  samples?: number
  model?: string
  maxContextSize: number
  modelContextSize: number
  maxTokens: number
  maxTokensProvided: boolean
  maxWorkers: number
  timeout: number
  totalTimeout?: number
  output?: string
  rhaiScript?: string
  install: boolean
}

export type LocaTaskConfiguration = {
  name?: string
  env_class?: string
  [key: string]: unknown
}

export type LocaConfigFile = {
  configurations: LocaTaskConfiguration[]
  [key: string]: unknown
}

export type LocaResultsSummary = {
  totalTasks: number
  totalSuccess: number
  totalError: number
}

type ProcessResult = {
  exitCode: number
  timedOut: boolean
}

const root = resolve(process.cwd())
const upstreamRoot = resolve(root, 'tests/performance/.cache/loca-upstream')
const resultRoot = resolve(root, 'tests/performance/results')

function value(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  const result = argv[index + 1]
  if (!result || result.startsWith('--')) throw new Error(`${name} requires a value`)
  return result
}

function positive(valueToParse: string | undefined, fallback: number, name: string): number {
  if (valueToParse === undefined) return fallback
  const parsed = Number(valueToParse)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function optionalPositive(valueToParse: string | undefined, name: string): number | undefined {
  if (valueToParse === undefined) return undefined
  return positive(valueToParse, 1, name)
}

function modelContextSize(argv: string[]): number {
  const commandLineValue = value(argv, '--model-context-size')
  if (commandLineValue !== undefined) {
    return positive(commandLineValue, defaultModelConfig.modelMaxContext, '--model-context-size')
  }

  const environmentValue = process.env.LOCA_MODEL_MAX_CONTEXT ?? process.env.RULER_MODEL_MAX_CONTEXT
  return positive(environmentValue, defaultModelConfig.modelMaxContext, 'LOCA_MODEL_MAX_CONTEXT')
}

export function parseArguments(argv: string[]): Arguments {
  const smoke = argv.includes('--smoke')
  const config = value(argv, '--config')
  const strategy = (value(argv, '--strategy') ?? 'builtin') as Strategy
  if (strategy !== 'builtin' && strategy !== 'rhai') throw new Error('--strategy must be builtin or rhai')
  return {
    official: argv.includes('--official'),
    smoke,
    strategy,
    config: config ?? 'task-configs/final_8k_set_config.json',
    configProvided: config !== undefined,
    filesystemOnly: argv.includes('--filesystem-only'),
    longContext: argv.includes('--long-context'),
    fixtureContextTokens: optionalPositive(value(argv, '--fixture-context-tokens'), '--fixture-context-tokens'),
    task: value(argv, '--task'),
    samples: optionalPositive(value(argv, '--samples'), '--samples'),
    model: value(argv, '--model'),
    maxContextSize: positive(value(argv, '--max-context-size'), smoke ? 8_192 : 128_000, '--max-context-size'),
    modelContextSize: modelContextSize(argv),
    maxTokens: positive(value(argv, '--max-tokens'), smoke ? 256 : 4_096, '--max-tokens'),
    maxTokensProvided: value(argv, '--max-tokens') !== undefined,
    maxWorkers: positive(value(argv, '--max-workers'), smoke ? 1 : 4, '--max-workers'),
    timeout: positive(value(argv, '--timeout'), smoke ? 120 : 600, '--timeout'),
    totalTimeout: optionalPositive(value(argv, '--total-timeout'), '--total-timeout') ?? (smoke ? 300 : undefined),
    output: value(argv, '--output'),
    rhaiScript: value(argv, '--rhai-script'),
    install: argv.includes('--install'),
  }
}

function required(name: string, fallback?: string): string {
  const result = process.env[name]?.trim() || fallback?.trim()
  if (!result) throw new Error(`Missing ${name}. Set the remote model environment variable before running LOCA.`)
  return result
}

function commandName(): string {
  return process.platform === 'win32' ? join(upstreamRoot, '.venv', 'Scripts', 'loca.exe') : join(upstreamRoot, '.venv', 'bin', 'loca')
}

function pythonName(): string {
  return process.platform === 'win32' ? join(upstreamRoot, '.venv', 'Scripts', 'python.exe') : join(upstreamRoot, '.venv', 'bin', 'python')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function patchFastMcpCompatibility(): Promise<void> {
  const path = resolve(upstreamRoot, 'gem/tools/mcp_tool.py')
  if (!await exists(path)) return
  const source = await readFile(path, 'utf8')
  if (!source.includes('log_file=log_file')) return

  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n'
  const transportReplacement = [
    '            transport_kwargs = {',
    "                'command': self.command,",
    "                'args': self.args,",
    "                'env': self.env,",
    "                'cwd': self.cwd,",
    '            }',
    "            if 'log_file' in inspect.signature(StdioTransport).parameters:",
    "                transport_kwargs['log_file'] = log_file",
    '            return StdioTransport(**transport_kwargs)',
  ].join(lineEnding)

  const patched = source
    .replace(
      /        from pathlib import Path\r?\n(?!        import inspect\r?\n)/,
      `        from pathlib import Path${lineEnding}        import inspect${lineEnding}`,
    )
    .replace(
      /            return StdioTransport\(\r?\n                command=self\.command,\r?\n                args=self\.args,\r?\n                env=self\.env,\r?\n                cwd=self\.cwd,\r?\n                log_file=log_file,\r?\n            \)/,
      transportReplacement,
    )

  if (patched === source) {
    throw new Error(`Unsupported LOCA FastMCP compatibility patch format: ${path}`)
  }
  await writeFile(path, patched, 'utf8')
  console.log('Applied FastMCP compatibility patch for LOCA.')
}

export function patchLocaPythonExecutableSource(source: string): string {
  const patchMarker = '# Codey LOCA Python executable compatibility patch'
  if (source.includes(patchMarker)) return source

  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n'
  const returnMarker = '        return "python", args'
  if (!source.includes(returnMarker)) {
    throw new Error('Unsupported LOCA Python executable compatibility patch format')
  }

  let patched = source
  if (!/^import sys\r?$/m.test(patched)) {
    const importMarker = `import os${lineEnding}`
    if (!patched.includes(importMarker)) {
      throw new Error('Unsupported LOCA Python executable compatibility patch format')
    }
    patched = patched.replace(importMarker, `${importMarker}import sys${lineEnding}`)
  }

  return patched.replace(
    returnMarker,
    `        ${patchMarker}${lineEnding}        return sys.executable, args`,
  )
}

async function patchLocaPythonExecutable(): Promise<void> {
  const path = resolve(upstreamRoot, 'gem/tools/mcp_server/config_loader.py')
  const source = await readFile(path, 'utf8')
  const patched = patchLocaPythonExecutableSource(source)
  if (patched !== source) {
    await writeFile(path, patched, 'utf8')
    console.log('Configured LOCA Python MCP servers to use the benchmark virtual environment.')
  }
}

export function patchLocaPythonExecuteSource(source: string): string {
  const patchMarker = '# Codey LOCA python_execute compatibility patch'
  const timeoutMarker = '# Codey LOCA python_execute timeout patch'
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n'
  let patched = source

  if (!patched.includes(patchMarker)) {
    const suffixMarker = '        if not filename.endswith(".py"):'
    const commandMarker = '        cmd = f"uv run --directory {agent_workspace} ./.python_tmp/{filename}"'
    const shellMarker = '                shell=True,'
    if (!patched.includes(suffixMarker) || !patched.includes(commandMarker) || !patched.includes(shellMarker)) {
      throw new Error('Unsupported LOCA python_execute compatibility patch format')
    }
    patched = patched
      .replace(
        suffixMarker,
        `        ${patchMarker}${lineEnding}        filename = os.path.basename(filename)${lineEnding}${suffixMarker}`,
      )
      .replace(
        commandMarker,
        '        cmd = [sys.executable, os.path.abspath(file_path)]',
      )
      .replace(shellMarker, '                cwd=agent_workspace,')
  }

  if (!patched.includes(timeoutMarker)) {
    const helperAnchor = [
      'def get_workspace() -> str:',
      '    """Get the workspace directory from environment or use default."""',
      '    return os.environ.get("PYTHON_EXECUTE_WORKSPACE", DEFAULT_WORKSPACE)',
    ].join(lineEnding)
    const runAnchor = [
      '        try:',
      '            result = subprocess.run(',
      '                cmd,',
      '                cwd=agent_workspace,',
      '                capture_output=True,',
      '                text=True,',
      "                encoding='utf-8',",
      '                timeout=timeout',
      '            )',
      '        except subprocess.TimeoutExpired:',
      '            execution_time = time.time() - start_time',
      '            return f"=== EXECUTION TIMEOUT ===\\nExecution timed out after {timeout} seconds\\nExecution time: {execution_time:.3f} seconds"',
    ].join(lineEnding)
    if (!patched.includes(helperAnchor) || !patched.includes(runAnchor)) {
      throw new Error('Unsupported LOCA python_execute timeout patch format')
    }
    const helper = [
      '',
      '',
      'def _kill_process_tree(process):',
      `    # ${timeoutMarker}: a subprocess kill only terminates the direct child;`,
      '    # grandchildren inheriting the pipes keep communicate() blocked forever.',
      "    if sys.platform == 'win32':",
      "        subprocess.run(['taskkill', '/T', '/F', '/PID', str(process.pid)], capture_output=True)",
      '    else:',
      '        import signal',
      '        try:',
      '            os.killpg(os.getpgid(process.pid), signal.SIGKILL)',
      '        except (ProcessLookupError, PermissionError):',
      '            process.kill()',
    ].join(lineEnding)
    const replacement = [
      `        # ${timeoutMarker}`,
      '        if timeout > 30:',
      '            timeout = 30',
      '        try:',
      '            process = subprocess.Popen(',
      '                cmd,',
      '                cwd=agent_workspace,',
      '                stdin=subprocess.DEVNULL,',
      '                stdout=subprocess.PIPE,',
      '                stderr=subprocess.PIPE,',
      '                text=True,',
      "                encoding='utf-8',",
      "                start_new_session=sys.platform != 'win32',",
      '            )',
      '            try:',
      '                stdout, stderr = process.communicate(timeout=timeout)',
      '            except subprocess.TimeoutExpired:',
      '                _kill_process_tree(process)',
      '                stdout, stderr = process.communicate()',
      '                execution_time = time.time() - start_time',
      '                return f"=== EXECUTION TIMEOUT ===\\nExecution timed out after {timeout} seconds\\nExecution time: {execution_time:.3f} seconds"',
      '            result = subprocess.CompletedProcess(cmd, process.returncode, stdout, stderr)',
      '        except subprocess.TimeoutExpired:',
      '            execution_time = time.time() - start_time',
      '            return f"=== EXECUTION TIMEOUT ===\\nExecution timed out after {timeout} seconds\\nExecution time: {execution_time:.3f} seconds"',
    ].join(lineEnding)
    patched = patched
      .replace(helperAnchor, helperAnchor + helper)
      .replace(runAnchor, replacement)
  } else if (!patched.includes('stdin=subprocess.DEVNULL')) {
    // Upgrade v2 caches written before the stdin fix: a stdio MCP server's
    // stdin is the JSON-RPC pipe, and children inheriting it never start.
    const pipeAnchor = [
      '                cwd=agent_workspace,',
      '                stdout=subprocess.PIPE,',
    ].join(lineEnding)
    if (!patched.includes(pipeAnchor)) {
      throw new Error('Unsupported LOCA python_execute stdin patch upgrade format')
    }
    patched = patched.replace(
      pipeAnchor,
      [
        '                cwd=agent_workspace,',
        '                stdin=subprocess.DEVNULL,',
        '                stdout=subprocess.PIPE,',
      ].join(lineEnding),
    )
  }

  const truncationMarker = '# Codey LOCA python_execute output truncation patch'
  if (!patched.includes(truncationMarker)) {
    // Unbounded tool output can blow up the caller's context budget with a
    // single huge run (observed: one full-suite pytest dump ≈ 98k tokens).
    const buildAnchor = '        output_parts = []'
    const stdoutAnchor = '            output_parts.append(result.stdout.rstrip())'
    const stderrAnchor = '            output_parts.append(result.stderr.rstrip())'
    if (!patched.includes(buildAnchor) || !patched.includes(stdoutAnchor) || !patched.includes(stderrAnchor)) {
      throw new Error('Unsupported LOCA python_execute output truncation patch format')
    }
    const clipper = [
      '',
      `        # ${truncationMarker}`,
      '        def _clip(text: str, limit: int = 2000) -> str:',
      '            if len(text) <= limit:',
      '                return text',
      '            dropped = len(text) - limit',
      '            return (',
      '                text[:limit]',
      '                + "\\n...[" + str(dropped) + " characters truncated - narrow the output, e.g. a single test id with -q, or print a summary]"',
      '            )',
    ].join(lineEnding)
    patched = patched
      .replace(buildAnchor, buildAnchor + clipper)
      .replace(stdoutAnchor, '            output_parts.append(_clip(result.stdout.rstrip()))')
      .replace(stderrAnchor, '            output_parts.append(_clip(result.stderr.rstrip()))')
  }

  return patched
}

async function patchLocaPythonExecute(): Promise<void> {
  const path = resolve(upstreamRoot, 'gem/tools/mcp_server/python_execute/server.py')
  const source = await readFile(path, 'utf8')
  const patched = patchLocaPythonExecuteSource(source)
  if (patched !== source) {
    await writeFile(path, patched, 'utf8')
    console.log('Patched LOCA python_execute to run scripts with the benchmark interpreter.')
  }
}

export function patchLocaFilesystemLoggingSource(source: string): string {
  const patchMarker = '# Codey LOCA compatibility patch v2'
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n'
  if (source.includes(patchMarker)) return source

  // Upgrade the first-generation patch if a previous run modified the ignored
  // upstream checkout before the cache was cleared. This keeps the patch
  // idempotent while ensuring the stronger handler discovery/retry logic wins.
  const legacyHelperStart = source.indexOf('def _close_logging_handlers_under(path: str) -> None:')
  if (legacyHelperStart >= 0) {
    const functionStart = source.indexOf(`def nfs_safe_rmtree(path: str) -> None:`, legacyHelperStart)
    if (functionStart < 0) throw new Error('Unsupported LOCA filesystem compatibility patch format')
    let prefix = source.slice(0, legacyHelperStart)
    const loggingImport = `import logging${lineEnding}`
    if (prefix.endsWith(loggingImport)) prefix = prefix.slice(0, -loggingImport.length)
    source = `${prefix}${source.slice(functionStart)}`
  }
  const importMarker = `import shutil${lineEnding}`
  const removeMarker = `    shutil.rmtree(path, onerror=onerror)`
  if (!source.includes(importMarker) || !source.includes(removeMarker)) {
    throw new Error('Unsupported LOCA filesystem compatibility patch format')
  }

  const helper = [
    patchMarker,
    'import logging',
    'import time',
    '',
    '',
    'def _close_logging_handlers_under(path: str) -> None:',
    '    """Close task-local file handlers, including detached handlers, on Windows."""',
    '    root = os.path.normcase(os.path.abspath(path))',
    '    loggers = [logging.getLogger()]',
    '    loggers.extend(',
    '        logger for logger in logging.Logger.manager.loggerDict.values()',
    '        if isinstance(logger, logging.Logger)',
    '    )',
    '',
    '    handlers = []',
    '    for logger in loggers:',
    '        handlers.extend(list(logger.handlers))',
    '    # _handlerList also contains handlers removed from logger.handlers without close().',
    '    for handler_ref in getattr(logging, "_handlerList", ()):',
    '        handler = handler_ref() if callable(handler_ref) else handler_ref',
    '        if handler is not None:',
    '            handlers.append(handler)',
    '',
    '    seen_handlers = set()',
    '    for handler in handlers:',
    '        if id(handler) in seen_handlers:',
    '            continue',
    '        seen_handlers.add(id(handler))',
    '        filename = getattr(handler, "baseFilename", None)',
    '        if not filename:',
    '            continue',
    '        try:',
    '            handler_path = os.path.normcase(os.path.abspath(filename))',
    '            inside = os.path.commonpath((root, handler_path)) == root',
    '        except ValueError:',
    '            inside = False',
    '        if inside:',
    '            for logger in loggers:',
    '                if handler in logger.handlers:',
    '                    logger.removeHandler(handler)',
    '            try:',
    '                handler.flush()',
    '            finally:',
    '                handler.close()',
    '',
  ].join(lineEnding)

  const patched = source
    .replace(importMarker, `${importMarker}${helper}`)
    .replace(removeMarker, [
      '    _close_logging_handlers_under(path)',
      '    # Windows can briefly retain a sharing lock after a handler is closed.',
      '    for attempt in range(5):',
      '        try:',
      '            shutil.rmtree(path, onerror=onerror)',
      '            return',
      '        except OSError as exc:',
      '            if os.name != "nt" or getattr(exc, "winerror", None) != 32 or attempt == 4:',
      '                raise',
      '            time.sleep(0.05 * (attempt + 1))',
    ].join(lineEnding))

  if (patched === source) throw new Error('Unsupported LOCA filesystem compatibility patch format')
  return patched
}

async function patchLocaFilesystemLogging(): Promise<void> {
  const path = resolve(upstreamRoot, 'gem/utils/filesystem.py')
  if (!await exists(path)) return
  const source = await readFile(path, 'utf8')
  const patched = patchLocaFilesystemLoggingSource(source)
  if (patched === source) return
  await writeFile(path, patched, 'utf8')
  console.log('Applied Windows-safe LOCA filesystem logging patch.')
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return
  if (process.platform !== 'win32') {
    child.kill('SIGTERM')
    return
  }
  const taskkill = (): Promise<void> => new Promise<void>((resolveKill) => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    })
    killer.once('error', () => {
      child.kill('SIGKILL')
      resolveKill()
    })
    killer.once('close', () => resolveKill())
  })
  await taskkill()
  // A tree kill can miss blocked children; verify and escalate once.
  const exited = new Promise<void>((resolveExited) => child.once('close', resolveExited))
  await Promise.race([exited, new Promise<void>((resolveWait) => setTimeout(resolveWait, 10_000))])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await taskkill()
  }
}

async function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  totalTimeout?: number,
): Promise<ProcessResult> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false, windowsHide: true })
    let timedOut = false
    const timer = totalTimeout
      ? setTimeout(() => {
        timedOut = true
        console.error(`LOCA evaluation exceeded the ${totalTimeout}-second total timeout; stopping its process tree.`)
        void terminateProcessTree(child)
      }, totalTimeout * 1_000)
      : undefined

    child.once('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolveExit({ exitCode: code ?? (signal ? 1 : 0), timedOut })
    })
  })
}

function taskName(configuration: LocaTaskConfiguration): string {
  const envClass = configuration.env_class?.split('.').at(-1)
  return configuration.name?.trim() || envClass?.trim() || 'unnamed task'
}

function matchesTask(configuration: LocaTaskConfiguration, requestedTask: string): boolean {
  const wanted = requestedTask.trim().toLocaleLowerCase()
  const names = [configuration.name, configuration.env_class?.split('.').at(-1)]
  return names.some((name) => name?.trim().toLocaleLowerCase() === wanted)
}

type ConfigurationFilterOptions = Pick<Arguments, 'task' | 'samples' | 'smoke'> & {
  filesystemOnly?: boolean
}

const filesystemOnlyServerTypes = new Set(['filesystem', 'claim_done'])

export function configurationServerTypes(configuration: LocaTaskConfiguration): string[] {
  const servers = configuration.mcp_servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return []

  return Object.entries(servers).flatMap(([name, server]) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) return []
    const details = server as { enabled?: unknown; type?: unknown }
    if (details.enabled === false) return []
    const type = typeof details.type === 'string' && details.type.trim() ? details.type : name
    return [type.trim().toLocaleLowerCase()]
  })
}

function unsupportedFilesystemOnlyServers(configuration: LocaTaskConfiguration): string[] {
  return [...new Set(configurationServerTypes(configuration).filter((type) => !filesystemOnlyServerTypes.has(type)))].sort()
}

export function isFilesystemOnlyConfiguration(configuration: LocaTaskConfiguration): boolean {
  const servers = configuration.mcp_servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false

  const serverTypes = configurationServerTypes(configuration)
  return serverTypes.length > 0 && unsupportedFilesystemOnlyServers(configuration).length === 0
}

function filesystemOnlyTaskError(task: string, configurations: LocaTaskConfiguration[]): Error {
  const unsupported = [...new Set(configurations.flatMap(unsupportedFilesystemOnlyServers))].sort()
  return new Error(
    `LOCA task "${task}" requires unsupported MCP server(s): ${unsupported.join(', ') || 'none'}. ` +
    '--filesystem-only permits only filesystem, claim_done.',
  )
}

export function filterConfigurations(config: LocaConfigFile, options: ConfigurationFilterOptions): LocaConfigFile {
  if (!Array.isArray(config.configurations) || config.configurations.length === 0) {
    throw new Error('LOCA config contains no task configurations')
  }

  let selected = config.configurations
  if (options.task) {
    selected = selected.filter((configuration) => matchesTask(configuration, options.task!))
    if (selected.length === 0) {
      const available = [...new Set(config.configurations.map(taskName))].join(', ')
      throw new Error(`Unknown LOCA task "${options.task}". Available tasks: ${available}`)
    }
    if (options.filesystemOnly && selected.some((configuration) => !isFilesystemOnlyConfiguration(configuration))) {
      throw filesystemOnlyTaskError(options.task, selected)
    }
  } else if (options.filesystemOnly) {
    selected = selected.filter(isFilesystemOnlyConfiguration)
    if (selected.length === 0) {
      throw new Error(
        'No LOCA configurations use only filesystem/claim_done. Provide --config with a compatible task or run without --filesystem-only.',
      )
    }
  }

  if (options.smoke) {
    const preferred = options.filesystemOnly
      ? selected[0]
      : selected.find((configuration) => matchesTask(configuration, 'ABTestingS2LEnv')) ?? selected[0]
    selected = preferred ? [preferred] : []
  }

  const limit = options.samples ?? (options.smoke ? 1 : undefined)
  if (limit !== undefined) selected = selected.slice(0, limit)
  if (selected.length === 0) throw new Error('LOCA task selection produced no configurations')
  return { ...config, configurations: selected }
}

export function validateLocaResults(result: unknown): LocaResultsSummary {
  if (!result || typeof result !== 'object') throw new Error('LOCA results.json is not an object')
  const value = result as {
    metadata?: { total_tasks?: unknown }
    summary?: { total_success?: unknown; total_error?: unknown }
  }
  const totalTasks = value.metadata?.total_tasks
  const totalSuccess = value.summary?.total_success
  const totalError = value.summary?.total_error
  if (typeof totalTasks !== 'number' || !Number.isInteger(totalTasks) || totalTasks < 1) {
    throw new Error('LOCA results.json is missing a positive metadata.total_tasks value')
  }
  if (typeof totalSuccess !== 'number' || !Number.isInteger(totalSuccess) || totalSuccess < 0) {
    throw new Error('LOCA results.json is missing a valid summary.total_success value')
  }
  if (typeof totalError !== 'number' || !Number.isInteger(totalError) || totalError < 0) {
    throw new Error('LOCA results.json is missing a valid summary.total_error value')
  }
  if (totalSuccess === 0) {
    throw new Error(`LOCA completed ${totalTasks} task(s), but none succeeded (${totalError} error(s)). See results.json and task trajectories for details.`)
  }
  return { totalTasks, totalSuccess, totalError }
}

async function prepare(args: Arguments): Promise<void> {
  if (!await exists(upstreamRoot)) {
    throw new Error(`LOCA-bench source is missing: ${upstreamRoot}. Clone it there or run the project setup first.`)
  }
  const python = pythonName()
  if (!await exists(python)) {
    throw new Error(`LOCA-bench Python environment is missing: ${python}. Create it with Python 3.10-3.12 inside the ignored cache directory.`)
  }
  await patchFastMcpCompatibility()
  await patchLocaPythonExecutable()
  await patchLocaFilesystemLogging()
  await patchLocaPythonExecute()
  if (args.install) {
    const result = await runProcess(python, ['-m', 'pip', 'install', '-e', upstreamRoot], process.env, upstreamRoot)
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`LOCA-bench installation failed with exit code ${result.exitCode}`)
  }
  if (!await exists(commandName())) {
    throw new Error(`LOCA-bench is not installed. Run: ${python} -m pip install -e "${upstreamRoot}"`)
  }
}

export function contextConfig(args: Pick<Arguments, 'modelContextSize' | 'maxTokens' | 'maxTokensProvided'>): typeof defaultContextManagementConfig {
  const modelMaxContext = args.modelContextSize
  const explicitMargin = process.env.LOCA_SAFE_OUTPUT_MARGIN ?? process.env.RULER_SAFE_OUTPUT_MARGIN
  if (explicitMargin !== undefined && (!Number.isFinite(Number(explicitMargin)) || Number(explicitMargin) < 0)) {
    throw new Error('LOCA_SAFE_OUTPUT_MARGIN must be a non-negative number')
  }
  // The margin must shrink with small windows: clamping the 16k default to a 4k window
  // collapses the compression trigger threshold to ~1 token and every request overflows.
  const fallbackMargin = Math.min(defaultContextManagementConfig.safeOutputMargin, Math.floor(modelMaxContext / 8))
  const safeOutputMargin = explicitMargin !== undefined ? Number(explicitMargin)
    : args.maxTokensProvided ? args.maxTokens
      : fallbackMargin
  return {
    ...defaultContextManagementConfig,
    layeredEnabled: process.env.LOCA_LAYERED !== 'false',
    hotTokenBudget: Number(process.env.LOCA_HOT_TOKEN_BUDGET ?? process.env.RULER_HOT_TOKEN_BUDGET ?? defaultContextManagementConfig.hotTokenBudget),
    warmTokenBudget: Number(process.env.LOCA_WARM_TOKEN_BUDGET ?? process.env.RULER_WARM_TOKEN_BUDGET ?? defaultContextManagementConfig.warmTokenBudget),
    coldRecallTokenBudget: Number(process.env.LOCA_COLD_RECALL_TOKEN_BUDGET ?? process.env.RULER_COLD_RECALL_TOKEN_BUDGET ?? defaultContextManagementConfig.coldRecallTokenBudget),
    safeOutputMargin: Math.min(Math.max(0, modelMaxContext - 1), Math.max(0, safeOutputMargin)),
  }
}

function outputPath(args: Arguments): string {
  if (args.output) return resolve(args.output)
  return resolve(resultRoot, `loca-${args.strategy}-${Date.now()}`)
}

export function locaConfigSourcePath(args: Pick<Arguments, 'config' | 'configProvided' | 'filesystemOnly' | 'longContext'>): string {
  if (args.filesystemOnly && !args.configProvided) {
    return resolve(root, args.longContext
      ? 'tests/performance/loca/configs/filesystem_only_long.json'
      : 'tests/performance/loca/configs/filesystem_only.json')
  }
  if (isAbsolute(args.config)) return args.config
  // 仓库内相对路径(如 tests/performance/loca/configs/*.json)优先于上游缓存路径
  const repoRelative = resolve(root, args.config)
  return existsSync(repoRelative) ? repoRelative : resolve(upstreamRoot, args.config)
}


export function applyFixtureContextTokens(config: LocaConfigFile, contextTokens: number | undefined): LocaConfigFile {
  if (contextTokens === undefined) return config
  return {
    ...config,
    configurations: config.configurations.map((configuration) => ({
      ...configuration,
      env_params: {
        ...(configuration.env_params && typeof configuration.env_params === 'object' && !Array.isArray(configuration.env_params)
          ? configuration.env_params
          : {}),
        context_tokens: contextTokens,
      },
    })),
  }
}
async function effectiveConfigPath(args: Arguments, output: string): Promise<string> {
  const sourcePath = locaConfigSourcePath(args)
  const shouldFilter = args.filesystemOnly || args.smoke || args.task !== undefined || args.samples !== undefined || args.longContext || args.fixtureContextTokens !== undefined
  if (!shouldFilter) return sourcePath
  if (args.longContext && !args.filesystemOnly) {
    throw new Error('--long-context requires --filesystem-only')
  }
  if (args.fixtureContextTokens !== undefined && !args.longContext) {
    throw new Error('--fixture-context-tokens requires --long-context')
  }
  const raw = await readFile(sourcePath, 'utf8')
  const config = JSON.parse(raw) as LocaConfigFile
  const filtered = applyFixtureContextTokens(filterConfigurations(config, args), args.fixtureContextTokens)
  const path = resolve(output, 'effective-config.json')
  await writeFile(path, `${JSON.stringify(filtered, null, 2)}\n`, 'utf8')
  return path
}

async function runLoca(args: Arguments): Promise<LocaResultsSummary> {
  await prepare(args)
  const apiKey = required('LOCA_API_KEY', process.env.RULER_API_KEY)
  const targetBaseUrl = required('LOCA_BASE_URL', process.env.RULER_BASE_URL)
  const model = required('LOCA_MODEL', process.env.RULER_MODEL)
  const modelConfig = {
    ...defaultModelConfig,
    id: 'loca-evaluation',
    name: 'LOCA evaluation model',
    baseUrl: targetBaseUrl,
    apiKey,
    modelName: model,
    modelMaxContext: args.modelContextSize,
  }
  const output = outputPath(args)
  await mkdir(output, { recursive: true })
  const tracePath = resolve(output, 'codey-context-trace.jsonl')
  const configPath = await effectiveConfigPath(args, output)
  const script = args.rhaiScript ? await readFile(resolve(args.rhaiScript), 'utf8') : undefined
  let proxy: LocaProxy | undefined
  let baseUrl = targetBaseUrl
  if (!args.official) {
    proxy = await startLocaContextProxy({
      targetBaseUrl,
      targetApiKey: apiKey,
      modelConfig,
      contextConfig: contextConfig(args),
      rhaiScript: args.strategy === 'rhai' ? script : undefined,
      tracePath,
      upstreamTimeoutMs: positive(process.env.LOCA_UPSTREAM_TIMEOUT_MS, 300_000, 'LOCA_UPSTREAM_TIMEOUT_MS') * 1_000,
    })
    baseUrl = `http://127.0.0.1:${proxy.port}/v1`
  }

  const pythonPathSeparator = process.platform === 'win32' ? ';' : ':'
  const pythonPath = [root, process.env.PYTHONPATH].filter((entry): entry is string => Boolean(entry?.trim())).join(pythonPathSeparator)
  const environment = {
    ...process.env,
    LOCA_OPENAI_API_KEY: apiKey,
    LOCA_OPENAI_BASE_URL: baseUrl,
    PYTHONPATH: pythonPath,
  }
  const commandArgs = [
    'run', '--config-file', configPath,
    '-m', args.model ?? model,
    '--max-context-size', String(args.maxContextSize),
    '--max-tokens', String(args.maxTokens),
    '--max-workers', String(args.maxWorkers),
    '--timeout', String(args.timeout),
    '--output-dir', output,
  ]
  if (!args.official) commandArgs.push('--strategy', 'react')
  const endpointMessage = args.official
    ? `LOCA endpoint: ${targetBaseUrl} (direct)`
    : [
        `LOCA endpoint: ${baseUrl} (Codey context proxy)`,
        `Upstream endpoint: ${targetBaseUrl}`,
        `Forward URL: ${locaUpstreamEndpoint(targetBaseUrl)}`,
      ].join('\n')
  console.log(
    `LOCA mode: ${args.official ? 'official' : `Codey ${args.strategy}`}\n` +
    `${endpointMessage}\n` +
    `LOCA benchmark context: ${args.maxContextSize} tokens\n` +
    `Codey model context: ${args.modelContextSize} tokens\n` +
    `Filesystem-only: ${args.filesystemOnly ? 'enabled' : 'disabled'}\n` +
    `Long context fixture: ${args.longContext ? `${args.fixtureContextTokens ?? 1400} target filler tokens` : 'disabled'}\n` +
    `Config: ${configPath}\nOutput: ${output}`,
  )
  try {
    const result = await runProcess(commandName(), commandArgs, environment, upstreamRoot, args.totalTimeout)
    if (result.timedOut) throw new Error(`LOCA evaluation exceeded the ${args.totalTimeout}-second total timeout and was stopped.`)
    if (result.exitCode !== 0) throw new Error(`LOCA process failed with exit code ${result.exitCode}. See ${output} for task logs and trajectories.`)
    const resultsPath = resolve(output, 'results.json')
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(resultsPath, 'utf8'))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`LOCA did not produce a readable results.json at ${resultsPath}: ${detail}`)
    }
    return validateLocaResults(parsed)
  } finally {
    await proxy?.close()
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  if (args.strategy === 'rhai' && !args.rhaiScript) throw new Error('--rhai-script is required when --strategy rhai is selected')
  const summary = await runLoca(args)
  console.log(`LOCA evaluation completed successfully: ${summary.totalSuccess}/${summary.totalTasks} task(s) succeeded; ${summary.totalError} error(s).`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
