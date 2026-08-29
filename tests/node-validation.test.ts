import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runNodeValidation } from '../src/main/node-validation'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory))
})

async function createPackage(): Promise<string> {
  const root = await createTemporaryDirectory('codey-node-validation-')
  temporaryDirectories.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: {
      pass: 'node pass.cjs',
      fail: 'node fail.cjs',
    },
  }), 'utf8')
  await writeFile(join(root, 'pass.cjs'), "console.log('validation passed')\n", 'utf8')
  await writeFile(join(root, 'fail.cjs'), "console.error('validation failed'); process.exitCode = 2\n", 'utf8')
  return root
}

describe('Node validation', () => {
  it('returns structured results for multiple package scripts', async () => {
    const root = await createPackage()

    const result = await runNodeValidation(root, 'pnpm', [
      { script: 'pass' },
      { script: 'fail' },
    ], 10)

    expect(result).toEqual(expect.objectContaining({
      success: false,
      status: 'failed',
      summary: expect.objectContaining({ total: 2, passed: 1, failed: 1 }),
    }))
    expect(result.checks).toEqual([
      expect.objectContaining({ script: 'pass', status: 'passed', exit_code: 0 }),
      expect.objectContaining({ script: 'fail', status: 'failed', exit_code: 2 }),
    ])
  })

  it('reports an unavailable package script as a failed check', async () => {
    const root = await createPackage()

    const result = await runNodeValidation(root, 'pnpm', [{ script: 'missing' }], 10)

    expect(result.status).toBe('failed')
    expect(result.checks[0]).toEqual(expect.objectContaining({
      script: 'missing',
      status: 'failed',
      exit_code: -1,
    }))
    expect(result.checks[0].stderr).toContain("Script 'missing' is not defined")
  })
})
