import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function createTemporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function removeTemporaryDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

export function runGit(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trimEnd()
}

export function initializeGitRepository(directory: string): void {
  runGit(directory, 'init')
  runGit(directory, 'config', 'core.autocrlf', 'false')
  runGit(directory, 'config', 'user.name', 'Codey Tests')
  runGit(directory, 'config', 'user.email', 'codey-tests@example.invalid')
}
