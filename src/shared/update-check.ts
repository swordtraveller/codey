export type UpdateCheckStatus = 'ahead' | 'current' | 'behind'

export type UpdateCheckResult = {
  status: UpdateCheckStatus
  currentVersion: string
  latestVersion: string
}

type SemanticVersion = {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const semanticVersionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseVersion(value: string): SemanticVersion {
  const match = semanticVersionPattern.exec(value.trim())
  if (!match) throw new Error(`Unsupported version format: ${value}`)

  const [major, minor, patch] = match.slice(1, 4).map(Number)
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`Unsupported version format: ${value}`)
  }

  return {
    major,
    minor,
    patch,
    prerelease: match[4]?.split('.') ?? [],
  }
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0) return right.length === 0 ? 0 : 1
  if (right.length === 0) return -1

  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index]
    const rightPart = right[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue

    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left)
  const rightVersion = parseVersion(right)
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (leftVersion[field] !== rightVersion[field]) return leftVersion[field] < rightVersion[field] ? -1 : 1
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease)
}

export function normalizeVersion(value: string): string {
  const version = parseVersion(value)
  const prerelease = version.prerelease.length > 0 ? `-${version.prerelease.join('.')}` : ''
  return `${version.major}.${version.minor}.${version.patch}${prerelease}`
}

export function checkUpdateVersions(currentVersion: string, latestVersion: string): UpdateCheckResult {
  const current = normalizeVersion(currentVersion)
  const latest = normalizeVersion(latestVersion)
  const comparison = compareVersions(current, latest)
  return {
    status: comparison > 0 ? 'ahead' : comparison < 0 ? 'behind' : 'current',
    currentVersion: current,
    latestVersion: latest,
  }
}