import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectFolder } from '../shared/types'

export type DetectedRuntime = 'node' | 'python' | 'rust'
export type DetectedProjectKind = 'frontend' | 'desktop'

export type ProjectFolderDetection = {
  folderId: string
  runtimes: DetectedRuntime[]
  kinds: DetectedProjectKind[]
  frameworks: string[]
  packageManager?: 'pnpm' | 'npm' | 'yarn'
  packageName?: string
  scripts: string[]
  evidence: string[]
}

const markerFiles = [
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'pyproject.toml',
  'requirements.txt',
  'requirements-dev.txt',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'Cargo.toml',
] as const

const maxPackageJsonBytes = 128 * 1024
const maxDirectoryEntries = 200

async function readTextIfPresent(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const content = await readFile(path, 'utf8')
    return content.length > maxBytes ? content.slice(0, maxBytes) : content
  } catch {
    return undefined
  }
}

async function hasFile(folderPath: string, fileName: string): Promise<boolean> {
  try {
    const entries = await readdir(folderPath, { withFileTypes: true })
    return entries.some((entry) => entry.isFile() && entry.name === fileName)
  } catch {
    return false
  }
}

function dependencyNames(packageJson: Record<string, unknown>): Set<string> {
  const names = new Set<string>()
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const dependencies = packageJson[section]
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
    for (const name of Object.keys(dependencies)) names.add(name)
  }
  return names
}

function addUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value)
}

function detectPackageFacts(
  packageJson: Record<string, unknown>,
  result: ProjectFolderDetection,
): void {
  addUnique(result.runtimes, 'node')
  const dependencies = dependencyNames(packageJson)
  const scriptsValue = packageJson.scripts
  if (scriptsValue && typeof scriptsValue === 'object' && !Array.isArray(scriptsValue)) {
    result.scripts = Object.keys(scriptsValue)
  }
  if (typeof packageJson.name === 'string' && packageJson.name.trim()) {
    result.packageName = packageJson.name
  }

  const frameworkSignals: Array<[string, string[]]> = [
    ['React', ['react', 'react-dom']],
    ['Vue', ['vue']],
    ['Svelte', ['svelte']],
    ['Angular', ['@angular/core']],
    ['Vite', ['vite']],
    ['Next.js', ['next']],
    ['Nuxt', ['nuxt']],
  ]
  for (const [framework, names] of frameworkSignals) {
    if (names.some((name) => dependencies.has(name))) addUnique(result.frameworks, framework)
  }

  if (dependencies.has('@tauri-apps/api') || dependencies.has('@tauri-apps/cli')) {
    addUnique(result.frameworks, 'Tauri')
    addUnique(result.kinds, 'desktop')
    addUnique(result.runtimes, 'rust')
    addUnique(result.evidence, 'package.json declares Tauri packages')
  }

  const hasFrontendFramework = result.frameworks.some((framework) => framework !== 'Tauri')
  const hasFrontendScript = result.scripts.some((script) => ['dev', 'build', 'preview', 'serve', 'start'].includes(script))
  if (hasFrontendFramework || (dependencies.has('vite') && hasFrontendScript)) {
    addUnique(result.kinds, 'frontend')
  }
  if (result.frameworks.length > 0) {
    addUnique(result.evidence, `package.json dependencies indicate ${result.frameworks.join(', ')}`)
  }
  if (hasFrontendScript && result.kinds.includes('frontend')) {
    addUnique(result.evidence, `package.json exposes frontend scripts: ${result.scripts.filter((script) => ['dev', 'build', 'preview', 'serve', 'start'].includes(script)).join(', ')}`)
  }
}

export async function detectProjectFolder(folder: ProjectFolder): Promise<ProjectFolderDetection> {
  const result: ProjectFolderDetection = {
    folderId: folder.id,
    runtimes: [],
    kinds: [],
    frameworks: [],
    scripts: [],
    evidence: [],
  }

  const presentMarkers = new Set<string>()
  try {
    const entries = (await readdir(folder.path, { withFileTypes: true })).slice(0, maxDirectoryEntries)
    for (const entry of entries) {
      if (entry.isFile() && markerFiles.includes(entry.name as typeof markerFiles[number])) {
        presentMarkers.add(entry.name)
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.py')) {
        addUnique(result.runtimes, 'python')
        addUnique(result.evidence, 'root contains Python source files')
      }
    }
  } catch {
    addUnique(result.evidence, 'folder could not be inspected')
    return result
  }

  const packageJson = await readTextIfPresent(join(folder.path, 'package.json'), maxPackageJsonBytes)
  if (packageJson !== undefined) {
    try {
      const parsed = JSON.parse(packageJson) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        detectPackageFacts(parsed as Record<string, unknown>, result)
        addUnique(result.evidence, 'package.json found')
      }
    } catch {
      addUnique(result.runtimes, 'node')
      addUnique(result.evidence, 'package.json found but could not be parsed')
    }
  } else if (presentMarkers.has('pnpm-lock.yaml') || presentMarkers.has('package-lock.json') || presentMarkers.has('yarn.lock')) {
    addUnique(result.runtimes, 'node')
    addUnique(result.evidence, 'Node package-manager lockfile found')
  }

  if (presentMarkers.has('pnpm-lock.yaml')) result.packageManager = 'pnpm'
  else if (presentMarkers.has('package-lock.json')) result.packageManager = 'npm'
  else if (presentMarkers.has('yarn.lock')) result.packageManager = 'yarn'
  if (result.packageManager) addUnique(result.evidence, `${result.packageManager} lockfile found`)

  const pythonMarkers = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'setup.py', 'setup.cfg', 'Pipfile']
  if (pythonMarkers.some((marker) => presentMarkers.has(marker))) {
    addUnique(result.runtimes, 'python')
    addUnique(result.evidence, `Python project files found: ${pythonMarkers.filter((marker) => presentMarkers.has(marker)).join(', ')}`)
  }

  const rootCargo = presentMarkers.has('Cargo.toml')
  const tauriCargo = await hasFile(join(folder.path, 'src-tauri'), 'Cargo.toml')
  if (rootCargo || tauriCargo) {
    addUnique(result.runtimes, 'rust')
    if (tauriCargo) {
      addUnique(result.kinds, 'desktop')
      addUnique(result.frameworks, 'Tauri')
      addUnique(result.evidence, 'src-tauri/Cargo.toml found')
    } else {
      addUnique(result.evidence, 'Cargo.toml found')
    }
  }

  return result
}

export async function detectProjectFolders(folders: ProjectFolder[]): Promise<ProjectFolderDetection[]> {
  return Promise.all(folders.map((folder) => detectProjectFolder(folder)))
}

export function formatProjectDetections(
  folders: ProjectFolder[],
  detections: ProjectFolderDetection[],
): string[] {
  return detections.map((detection) => {
    const folder = folders.find((candidate) => candidate.id === detection.folderId)
    const labels = [
      `runtimes=${detection.runtimes.length ? detection.runtimes.join(',') : 'unknown'}`,
      `kinds=${detection.kinds.length ? detection.kinds.join(',') : 'general'}`,
      detection.frameworks.length ? `frameworks=${detection.frameworks.join(',')}` : undefined,
      detection.packageManager ? `packageManager=${detection.packageManager}` : undefined,
      detection.packageName ? `package=${detection.packageName}` : undefined,
      detection.scripts.length ? `scripts=${detection.scripts.join(',')}` : undefined,
      detection.evidence.length ? `evidence=${detection.evidence.join('; ')}` : undefined,
    ].filter((value): value is string => Boolean(value))
    return `- ${detection.folderId} (${folder?.path ?? 'unknown path'}): ${labels.join(' | ')}`
  })
}
