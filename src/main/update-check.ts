import { net } from 'electron'
import { checkUpdateVersions, type UpdateCheckResult } from '../shared/update-check'

const latestReleaseApiUrl = 'https://api.github.com/repos/swordtraveller/codey/releases/latest'
export const latestReleasePageUrl = 'https://github.com/swordtraveller/codey/releases/latest'
const requestTimeoutMs = 10_000

type GitHubLatestRelease = { tag_name?: unknown }

export async function checkForUpdates(currentVersion: string): Promise<UpdateCheckResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
  try {
    const response = await net.fetch(latestReleaseApiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Latest release check failed (HTTP ${response.status})`)

    const release = await response.json() as GitHubLatestRelease
    if (typeof release.tag_name !== 'string') throw new Error('Latest release response did not include a version tag')
    return checkUpdateVersions(currentVersion, release.tag_name)
  } finally {
    clearTimeout(timeout)
  }
}