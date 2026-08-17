import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  safeResolveExistingPath,
  safeResolvePath,
  safeResolveWritablePath,
  truncateOutput,
} from '../src/main/sandbox'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory))
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await createTemporaryDirectory(prefix)
  temporaryDirectories.push(directory)
  return directory
}

describe('sandbox paths', () => {
  it('resolves a relative path inside the project root', async () => {
    const root = await temporaryDirectory('codey-sandbox-')

    expect(safeResolvePath(root, 'src/main.py')).toBe(resolve(root, 'src/main.py'))
  })

  it.each(['../outside.txt', '..\\outside.txt', '/outside.txt', 'C:\\outside.txt'])(
    'rejects paths outside the project root: %s',
    async (inputPath) => {
      const root = await temporaryDirectory('codey-sandbox-')

      expect(() => safeResolvePath(root, inputPath)).toThrow('Path is outside the project root')
    },
  )

  it('rejects an existing symbolic link that escapes the project root', async () => {
    const root = await temporaryDirectory('codey-sandbox-root-')
    const outside = await temporaryDirectory('codey-sandbox-outside-')
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8')
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(safeResolveExistingPath(root, 'linked/secret.txt')).rejects.toThrow(
      'Path is outside the project root',
    )
    await expect(safeResolveWritablePath(root, 'linked/new.txt')).rejects.toThrow(
      'Path is outside the project root',
    )
  })

  it('allows creating a missing path beneath an existing project directory', async () => {
    const root = await temporaryDirectory('codey-sandbox-')
    await mkdir(join(root, 'src'))

    await expect(safeResolveWritablePath(root, 'src/new/file.py')).resolves.toBe(
      resolve(root, 'src/new/file.py'),
    )
  })
})

describe('truncateOutput', () => {
  it('leaves short output unchanged', () => {
    expect(truncateOutput('short', 10)).toBe('short')
  })

  it('marks output that exceeds the limit', () => {
    expect(truncateOutput('123456', 4)).toBe('1234\n[output truncated]')
  })
})
