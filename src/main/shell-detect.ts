import { spawn, spawnSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  commandExecutionSupported,
  dockerBashImage,
  dockerPwshImage,
  type CommandEnvironment,
  type CommandInterpreter,
  type ShellDetectionResult,
} from '../shared/types'

const GIT_BASH_CANDIDATES = (): string[] => [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
  join(homedir(), 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
]

/** git-bash.exe is a mintty launcher, not bash itself: spawning it opens a
 *  terminal window and the command output never reaches our pipes. The real
 *  interpreter lives at <install>\bin\bash.exe next to it. */
export function translateGitBashLauncher(path: string): string {
  if (basename(path).toLowerCase() !== 'git-bash.exe') return path
  return join(dirname(path), 'bin', 'bash.exe')
}

/** Git for Windows records its install directory in the registry; this catches
 *  non-standard locations (e.g. D:\Program Files\Git). */
function gitBashFromRegistry(): string | null {
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const result = spawnSync('reg', ['query', `${hive}\\SOFTWARE\\GitForWindows`, '/v', 'InstallPath'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 5_000,
      })
      if (result.status !== 0 || !result.stdout) continue
      const match = result.stdout.match(/InstallPath\s+REG_SZ\s+(.+)/i)
      const installPath = match?.[1]?.trim()
      if (installPath) return join(installPath, 'bin', 'bash.exe')
    } catch {
      // reg.exe unavailable or blocked; skip this probe.
    }
  }
  return null
}

let cachedDetection: ShellDetectionResult | null = null
let manualBashPath: string | null = null
/** Test seam: forces the bash executable used for bare execution. */
export const shellDetectTestHooks = {
  setBashOverride(path: string | null): void {
    manualBashPath = path?.trim() || null
    cachedDetection = null
  },
}

export function getCachedShellDetection(): ShellDetectionResult | null {
  return cachedDetection
}

export function setManualBashPath(path: string | null): void {
  manualBashPath = path?.trim() || null
  // A manual path changes bash availability; drop the cache so the next
  // detection reflects it.
  cachedDetection = null
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function probe(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, timeout: 10_000 })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.once('error', () => resolve(null))
    child.once('close', (code) => resolve(code === 0 ? stdout.trim() || '' : null))
  })
}

/** wsl.exe writes UTF-16LE; Node reads it as UTF-8 garbage without this. */
export function probeWsl(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', args, { windowsHide: true, shell: false, timeout: 15_000 })
    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', () => undefined)
    child.once('error', () => resolve(null))
    child.once('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const raw = Buffer.concat(chunks)
      const text = raw[0] === 0xff && raw[1] === 0xfe
        ? raw.subarray(2).toString('utf16le')
        : raw.toString('utf8')
      resolve(text.trim() || '')
    })
  })
}

type WslDistro = { name: string; running: boolean; default: boolean }
export type { WslDistro }

/** System-internal distros used by Docker Desktop; not usable as a user shell. */
const WSL_SYSTEM_DISTROS = new Set(['docker-desktop', 'docker-desktop-data'])

/** Parses `wsl --list --verbose` output into distro entries. */
export function parseWslDistros(listOutput: string | null): WslDistro[] {
  if (!listOutput) return []
  const distros: WslDistro[] = []
  for (const line of listOutput.split(/\r?\n/)) {
    const match = line.match(/^(\*?)\s*(\S+)\s+(\S+)\s+(\S+)\s*$/)
    if (!match) continue
    const [, marker, name, state] = match
    if (/^name$/i.test(name)) continue
    distros.push({ name, running: /^running$/i.test(state), default: marker === '*' })
  }
  return distros
}

async function detectBash(): Promise<{ available: boolean; path: string | null; detail: string }> {
  if (manualBashPath) {
    const translated = translateGitBashLauncher(manualBashPath)
    if (await executableExists(translated)) {
      return {
        available: true,
        path: translated,
        detail: translated === manualBashPath
          ? `configured at ${translated}`
          : `configured git-bash.exe translated to ${translated}`,
      }
    }
    return { available: false, path: null, detail: `configured bash.exe not found at ${manualBashPath}` }
  }
  const version = await probe('bash', ['--version'])
  if (version) {
    return { available: true, path: 'bash', detail: version.split('\n')[0] ?? 'bash on PATH' }
  }
  const registryCandidate = gitBashFromRegistry()
  if (registryCandidate && await executableExists(registryCandidate)) {
    return { available: true, path: registryCandidate, detail: `git bash at ${registryCandidate} (registry)` }
  }
  for (const candidate of GIT_BASH_CANDIDATES()) {
    if (await executableExists(candidate)) {
      return { available: true, path: candidate, detail: `git bash at ${candidate}` }
    }
  }
  return { available: false, path: null, detail: 'bash not found on PATH, the registry, or common Git Bash locations; choose git-bash.exe manually' }
}

async function detectPwsh7(): Promise<{ available: boolean; path: string | null; detail: string }> {
  const version = await probe('pwsh', ['--version'])
  if (version) {
    return { available: true, path: 'pwsh', detail: version.split('\n')[0] ?? 'pwsh on PATH' }
  }
  // Store installs register an execution alias under WindowsApps that some
  // Node/spawn configurations fail to resolve through PATH.
  const storeAlias = join(homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'pwsh.exe')
  if (await executableExists(storeAlias)) {
    const aliasVersion = await probe(storeAlias, ['--version'])
    if (aliasVersion) {
      return { available: true, path: storeAlias, detail: `${aliasVersion.split('\n')[0]} (Microsoft Store)` }
    }
  }
  return { available: false, path: null, detail: 'pwsh not found on PATH or in WindowsApps' }
}

function pwsh51Path(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

async function detectWsl2(): Promise<{ available: boolean; detail: string }> {
  const list = await probeWsl(['--list', '--verbose'])
  if (list === null) {
    return { available: false, detail: 'wsl is not installed or no distribution exists' }
  }
  const userDistros = parseWslDistros(list).filter((distro) => !WSL_SYSTEM_DISTROS.has(distro.name))
  if (userDistros.length === 0) {
    return { available: false, detail: 'wsl is installed but has no user distribution (only system distros)' }
  }
  const bashCheck = await probeWsl(['--', 'bash', '-c', 'echo ok'])
  const describe = (distro: WslDistro): string =>
    `${distro.name} (${distro.running ? 'Running' : 'Stopped'}${distro.default ? ', default' : ''})`
  if (!bashCheck) {
    return {
      available: false,
      detail: `user distributions exist but bash is unavailable in the default one: ${userDistros.map(describe).join(', ')}`,
    }
  }
  return {
    available: true,
    detail: `bash available in the default distribution; distros: ${userDistros.map(describe).join(', ')}`,
  }
}

async function detectDocker(): Promise<{ available: boolean; detail: string }> {
  const info = await probe('docker', ['info', '--format', '{{.ServerVersion}}'])
  if (!info) {
    return { available: false, detail: 'docker CLI not found or the daemon is not running' }
  }
  const bashImage = await probe('docker', ['image', 'inspect', dockerBashImage, '--format', 'ok'])
  const pwshImage = await probe('docker', ['image', 'inspect', dockerPwshImage, '--format', 'ok'])
  const missing = [
    ...(!bashImage ? [dockerBashImage] : []),
    ...(!pwshImage ? [dockerPwshImage] : []),
  ]
  return {
    available: true,
    detail: missing.length
      ? `docker server ${info}; missing images (auto-pulled on first use): ${missing.join(', ')}`
      : `docker server ${info}`,
  }
}

/** Detects interpreters and environments on demand. Only combos that are both
 *  detected and implemented are reported as usable; the architecture leaves
 *  room for more interpreters and environments. */
export async function detectShells(): Promise<ShellDetectionResult> {
  const [bash, pwsh7, wsl2, docker] = await Promise.all([detectBash(), detectPwsh7(), detectWsl2(), detectDocker()])
  const pwsh51Available = process.platform === 'win32' && await executableExists(pwsh51Path())
  const result: ShellDetectionResult = {
    interpreters: [
      {
        kind: 'bash' satisfies CommandInterpreter,
        available: bash.available,
        executablePath: bash.path ?? undefined,
        detail: bash.detail,
      },
      {
        kind: 'pwsh7' satisfies CommandInterpreter,
        available: pwsh7.available,
        executablePath: pwsh7.path ?? undefined,
        detail: pwsh7.detail,
      },
      {
        kind: 'pwsh51' satisfies CommandInterpreter,
        available: pwsh51Available,
        executablePath: pwsh51Available ? pwsh51Path() : undefined,
        detail: pwsh51Available ? `Windows PowerShell 5.1 at ${pwsh51Path()}` : 'not available on this platform',
      },
    ],
    environments: [
      { kind: 'bare' satisfies CommandEnvironment, available: true, detail: 'commands run directly on the host' },
      { kind: 'wsl2' satisfies CommandEnvironment, available: wsl2.available, detail: wsl2.detail },
      { kind: 'docker' satisfies CommandEnvironment, available: docker.available, detail: docker.detail },
      { kind: 'windows-sandbox' satisfies CommandEnvironment, available: false, detail: 'not implemented yet' },
    ],
    detectedAt: new Date().toISOString(),
  }
  cachedDetection = result
  return result
}

/** The bash executable to use for the bare environment, from the last
 *  detection or manual configuration. */
export async function resolveBareBashExecutable(): Promise<string> {
  if (manualBashPath) return manualBashPath
  const cached = cachedDetection ?? await detectShells()
  const bash = cached.interpreters.find((entry) => entry.kind === 'bash')
  if (bash?.available && bash.executablePath) return bash.executablePath
  throw new Error('bash is unavailable. Run environment detection in settings and configure git-bash.exe if needed.')
}

/** The pwsh executable for the bare environment. Falls back to a fresh
 *  detection when nothing is cached. */
export async function resolveBarePwshExecutable(kind: 'pwsh7' | 'pwsh51'): Promise<string> {
  const cached = cachedDetection ?? await detectShells()
  const entry = cached.interpreters.find((item) => item.kind === kind)
  if (entry?.available && entry.executablePath) return entry.executablePath
  throw new Error(`${kind === 'pwsh7' ? 'pwsh 7' : 'Windows PowerShell 5.1'} is unavailable. Run environment detection in settings.`)
}

export function commandComboUsable(
  interpreter: CommandInterpreter,
  environment: CommandEnvironment,
  detection: ShellDetectionResult | null,
): boolean {
  if (!commandExecutionSupported(interpreter, environment)) return false
  if (!detection) return false
  const interpreterOk = detection.interpreters.some((entry) => entry.kind === interpreter && entry.available)
  const environmentOk = detection.environments.some((entry) => entry.kind === environment && entry.available)
  return interpreterOk && environmentOk
}
