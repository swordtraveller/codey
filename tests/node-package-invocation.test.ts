import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runPackageManagerCommand, runPackageScript } from '../src/main/node-sandbox'
import { runSandboxProcess } from '../src/main/sandbox'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

vi.mock('../src/main/sandbox', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/sandbox')>(),
  runSandboxProcess: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false })),
}))

const temporaryDirectories: string[] = []
const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!

afterEach(async () => {
  Object.defineProperty(process, 'execPath', execPathDescriptor)
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory))
})

async function fixture(manager: 'npm' | 'pnpm', extensionless = false) {
  const root = await createTemporaryDirectory('codey-node-invocation-')
  temporaryDirectories.push(root)
  const managerDirectory = join(root, 'package manager')
  const nodeDirectory = join(root, 'node runtime')
  await mkdir(managerDirectory)
  await mkdir(nodeDirectory)
  const cli = extensionless ? manager : manager === 'npm' ? 'npm-cli.js' : 'pnpm.cjs'
  const cliPath = join(managerDirectory, cli)
  await writeFile(cliPath, '#!/usr/bin/env node\n')
  if (!extensionless) {
    await writeFile(join(managerDirectory, `${manager}.cmd`), `@\"%dp0%\\\\node.exe\" \"%dp0%\\\\${cli}\" %*`)
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { probe: 'node probe.cjs' } }))
  vi.stubEnv('PATH', `${managerDirectory};\"${nodeDirectory}\"`)
  Object.defineProperty(process, 'execPath', { ...execPathDescriptor, value: join(root, 'electron.exe') })
  return { root, managerDirectory, nodeDirectory, cliPath }
}

describe.skipIf(process.platform !== 'win32')('Windows package invocation inside Electron', () => {
  it.each(['npm', 'pnpm'] as const)('runs %s and its scripts with real Node from PATH', async (manager) => {
    const { root, managerDirectory, nodeDirectory, cliPath } = await fixture(manager)
    const executable = join(nodeDirectory, 'node.exe')
    await writeFile(executable, '')

    await runPackageManagerCommand(root, manager, 'list')
    await runPackageScript(root, manager, 'probe')

    const calls = vi.mocked(runSandboxProcess).mock.calls
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call[0]).toBe(executable)
      expect(call[1][0]).toBe(cliPath)
      expect(call[4]?.PATH).toBe(`${nodeDirectory};${managerDirectory};${nodeDirectory}`)
      expect(call[4]?.Path).toBeUndefined()
      expect(call[4]?.ELECTRON_RUN_AS_NODE).toBeUndefined()
    }
    expect(calls[0][4]?.NODE_OPTIONS).toBeUndefined()
    expect(calls[1][4]?.NODE_OPTIONS).toContain('node-sandbox-guard.cjs')
  })

  it('prefers Node beside the package manager over another PATH installation', async () => {
    const { root, managerDirectory, nodeDirectory } = await fixture('pnpm')
    await writeFile(join(managerDirectory, 'node.exe'), '')
    await writeFile(join(nodeDirectory, 'node.exe'), '')

    await runPackageManagerCommand(root, 'pnpm', 'list')

    expect(vi.mocked(runSandboxProcess).mock.calls[0][0]).toBe(join(managerDirectory, 'node.exe'))
  })

  it('uses real Node for an extensionless package manager script', async () => {
    const { root, nodeDirectory, cliPath } = await fixture('pnpm', true)
    await writeFile(join(nodeDirectory, 'node.exe'), '')

    await runPackageManagerCommand(root, 'pnpm', 'list')

    expect(vi.mocked(runSandboxProcess).mock.calls[0].slice(0, 2)).toEqual([
      join(nodeDirectory, 'node.exe'), [cliPath, 'list'],
    ])
  })

  it('fails without spawning Electron when Node is missing', async () => {
    const { root, nodeDirectory } = await fixture('pnpm')
    await mkdir(join(nodeDirectory, 'node.exe'))

    await expect(runPackageManagerCommand(root, 'pnpm', 'list')).rejects.toThrow('Unable to locate node.exe')
    await expect(runPackageScript(root, 'pnpm', 'probe')).rejects.toThrow('Unable to locate node.exe')
    expect(runSandboxProcess).not.toHaveBeenCalled()
  })

  it('runs a standalone package manager executable without requiring Node', async () => {
    const { root, nodeDirectory } = await fixture('pnpm')
    const executable = join(nodeDirectory, 'pnpm.exe')
    await writeFile(executable, '')
    vi.stubEnv('PATH', nodeDirectory)

    await runPackageManagerCommand(root, 'pnpm', 'list')

    expect(vi.mocked(runSandboxProcess).mock.calls[0].slice(0, 2)).toEqual([executable, ['list']])
  })
})
