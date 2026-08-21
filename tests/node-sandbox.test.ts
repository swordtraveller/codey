import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runPackageManagerCommand, runPackageScript } from '../src/main/node-sandbox'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await createTemporaryDirectory('codey-node-sandbox-')
  temporaryDirectories.push(directory)
  return directory
}

describe('Node package sandbox', () => {
  it('runs an explicitly defined package script with arguments', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'package.json'), JSON.stringify({
      scripts: { echo: 'node script.cjs' },
    }), 'utf8')
    await writeFile(join(root, 'script.cjs'), "console.log(process.argv.slice(2).join(','))\n", 'utf8')

    for (const packageManager of ['npm', 'pnpm'] as const) {
      const result = await runPackageScript(root, packageManager, 'echo', ['one', 'two'], 10)

      expect(result).toEqual(expect.objectContaining({ success: true, exit_code: 0 }))
      expect(result.stdout).toContain('one,two')
    }
  })

  it('preserves configured host Rust toolchain paths', async () => {
    const root = await temporaryDirectory()
    const cargoHome = join(root, 'host-cargo')
    const rustupHome = join(root, 'host-rustup')
    const previousCargoHome = process.env.CARGO_HOME
    const previousRustupHome = process.env.RUSTUP_HOME
    process.env.CARGO_HOME = cargoHome
    process.env.RUSTUP_HOME = rustupHome
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({
        scripts: { rust: 'node rust-env.cjs' },
      }), 'utf8')
      await writeFile(
        join(root, 'rust-env.cjs'),
        "console.log(JSON.stringify({ cargoHome: process.env.CARGO_HOME, rustupHome: process.env.RUSTUP_HOME }))\n",
        'utf8',
      )

      const result = await runPackageScript(root, 'pnpm', 'rust', [], 10)
      const environment = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>

      expect(result).toEqual(expect.objectContaining({ success: true, exit_code: 0 }))
      expect(environment.cargoHome).toBe(cargoHome)
      expect(environment.rustupHome).toBe(rustupHome)
    } finally {
      if (previousCargoHome === undefined) delete process.env.CARGO_HOME
      else process.env.CARGO_HOME = previousCargoHome
      if (previousRustupHome === undefined) delete process.env.RUSTUP_HOME
      else process.env.RUSTUP_HOME = previousRustupHome
    }
  })

  it('rejects scripts that are not defined in package.json', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {} }), 'utf8')

    await expect(runPackageScript(root, 'pnpm', 'missing', [], 10)).rejects.toThrow(
      "Script 'missing' is not defined in package.json",
    )
  })

  it('prevents Node package scripts from writing outside the package root', async () => {
    const parent = await temporaryDirectory()
    const root = join(parent, 'package')
    await mkdir(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({
      scripts: { escape: 'node escape.cjs' },
    }), 'utf8')
    await writeFile(
      join(root, 'escape.cjs'),
      "console.log(process.env.NODE_OPTIONS); require('node:fs').writeFileSync('../outside.txt', 'unsafe')\n",
      'utf8',
    )

    for (const packageManager of ['npm', 'pnpm'] as const) {
      const result = await runPackageScript(root, packageManager, 'escape', [], 10)

      expect(result.success).toBe(false)
      expect(result.stderr).toContain('Node sandbox denied access outside the package workspace')
      await expect(readFile(join(parent, 'outside.txt'), 'utf8')).rejects.toThrow()
    }
  })

  it('hides outside metadata probes while rejecting outside reads', async () => {
    const parent = await temporaryDirectory()
    const root = join(parent, 'package')
    await mkdir(root)
    await writeFile(join(parent, 'outside.txt'), 'secret', 'utf8')
    await writeFile(join(root, 'package.json'), JSON.stringify({
      scripts: { probe: 'node probe.cjs' },
    }), 'utf8')
    await writeFile(
      join(root, 'probe.cjs'),
      "const fs = require('node:fs'); console.log(fs.existsSync('../outside.txt')); fs.readFileSync('../outside.txt', 'utf8')\n",
      'utf8',
    )

    const result = await runPackageScript(root, 'pnpm', 'probe', [], 10)

    expect(result.success).toBe(false)
    expect(result.stdout).toContain('false')
    expect(result.stderr).toContain('Node sandbox denied access outside the package workspace')
  })

  it('rejects unsafe package specifiers before invoking a package manager', async () => {
    const root = await temporaryDirectory()

    await expect(runPackageManagerCommand(root, 'pnpm', 'install', ['../local'], 10)).rejects.toThrow(
      'valid registry package specifiers',
    )
  })
})




