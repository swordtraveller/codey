import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitAdd, gitCommit, gitDiff, gitGetCurrentBranch, gitLog, gitStatus, gitUnstage } from '../src/main/git'
import { createTemporaryDirectory, initializeGitRepository, removeTemporaryDirectory, runGit } from './helpers'

describe('git tools', () => {
  let repository = ''

  beforeEach(async () => {
    repository = await createTemporaryDirectory('codey-git-')
    initializeGitRepository(repository)
    await writeFile(join(repository, 'tracked.txt'), 'initial\n', 'utf8')
    runGit(repository, 'add', 'tracked.txt')
    runGit(repository, 'commit', '-m', 'initial commit')
  })

  afterEach(async () => {
    await removeTemporaryDirectory(repository)
  })

  it('reports repository status and the current branch', async () => {
    await writeFile(join(repository, 'tracked.txt'), 'changed\n', 'utf8')

    await expect(gitStatus(repository)).resolves.toEqual(
      expect.objectContaining({ status: expect.stringContaining('tracked.txt') }),
    )
    await expect(gitGetCurrentBranch(repository)).resolves.toEqual({
      branch: expect.any(String),
      detached: false,
    })
  })

  it.each(['.', './', '.\\', '../outside.txt', 'node_modules/file.js'])(
    'rejects unsafe git_add path %s',
    async (path) => {
      await expect(gitAdd(repository, [path])).rejects.toThrow()
    },
  )

  it('stages only explicitly selected files', async () => {
    await writeFile(join(repository, 'selected.txt'), 'selected\n', 'utf8')
    await writeFile(join(repository, 'unselected.txt'), 'unselected\n', 'utf8')

    const result = await gitAdd(repository, ['selected.txt'])

    expect(result.staged_paths).toEqual(['selected.txt'])
    await expect(gitDiff(repository, true)).resolves.toEqual(
      expect.objectContaining({ diff: expect.stringContaining('selected.txt') }),
    )
    expect(runGit(repository, 'diff', '--cached', '--name-only')).toBe('selected.txt')
    expect(runGit(repository, 'status', '--short')).toContain('?? unselected.txt')
  })

  it('rejects a commit when the staging area is empty', async () => {
    await expect(gitCommit(repository, 'empty commit')).rejects.toThrow(
      'Cannot create a commit because the staging area is empty',
    )
  })

  it('unstages selected files without changing their working tree contents', async () => {
    await writeFile(join(repository, 'selected.txt'), 'changed\n', 'utf8')
    await gitAdd(repository, ['selected.txt'])

    const result = await gitUnstage(repository, ['selected.txt'])

    expect(result.unstaged_paths).toEqual(['selected.txt'])
    expect(await readFile(join(repository, 'selected.txt'), 'utf8')).toBe('changed\n')
    expect(runGit(repository, 'diff', '--cached', '--name-only')).toBe('')
    expect(runGit(repository, 'status', '--short')).toContain('?? selected.txt')
  })

  it.each(['.', './', '.\\', '../outside.txt', '-A'])(
    'rejects unsafe git_unstage path %s',
    async (path) => {
      await expect(gitUnstage(repository, [path])).rejects.toThrow()
    },
  )
  it('commits staged changes and returns them from git_log', async () => {
    await writeFile(join(repository, 'feature.txt'), 'feature\n', 'utf8')
    await gitAdd(repository, ['feature.txt'])

    const result = await gitCommit(repository, 'add feature')

    expect(result.commit).toMatch(/^[0-9a-f]{40}$/)
    await expect(gitLog(repository, 1)).resolves.toEqual(
      expect.objectContaining({ log: expect.stringContaining('add feature') }),
    )
  })

  it('requires the selected folder to be the repository root', async () => {
    const child = join(repository, 'child')
    await mkdir(child)

    await expect(gitStatus(child)).rejects.toThrow(
      'The selected project folder is not a Git repository root',
    )
  })
})
