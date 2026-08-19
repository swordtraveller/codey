import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgentTools, runAgentTool, type ToolCall } from '../src/main/tools'
import type { Project } from '../src/shared/types'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

function toolCall(name: string, args: unknown): ToolCall {
  return {
    id: 'call-1',
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

describe('agent tools', () => {
  let root = ''
  let project: Project

  beforeEach(async () => {
    root = await createTemporaryDirectory('codey-tools-')
    project = {
      id: 'project',
      name: 'Project',
      defaultModelConfigId: null,
      contextConfigOverride: null,
      folders: [{ id: 'root', path: root }],
      pythonEnvironmentFolderId: 'root',
      conversations: [],
    }
  })

  afterEach(async () => {
    await removeTemporaryDirectory(root)
  })

  it('publishes unique OpenAI function definitions', () => {
    const definitions = createAgentTools(project) as Array<{ function: { name: string } }>
    const names = definitions.map((definition) => definition.function.name)

    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(expect.arrayContaining([
      'read_file',
      'write_file',
      'file_patch',
      'project_tree',
      'project_search_text',
      'python_execute',
      'git_status',
      'git_commit',
    ]))
  })

  it('writes and reads a file while recording the changed path', async () => {
    const writtenFiles: string[] = []

    const writeResult = JSON.parse(await runAgentTool(
      project,
      toolCall('write_file', { folder_id: 'root', path: 'src/example.ts', content: 'export {}\n' }),
      writtenFiles,
    )) as { success: boolean }
    const readResult = await runAgentTool(
      project,
      toolCall('read_file', { folder_id: 'root', path: 'src/example.ts' }),
      writtenFiles,
    )

    expect(writeResult.success).toBe(true)
    expect(readResult).toBe('export {}\n')
    expect(writtenFiles).toEqual([join(root, 'src/example.ts')])
  })

  it('patches a unique snippet and leaves an ambiguous file unchanged', async () => {
    const target = join(root, 'example.py')
    await writeFile(target, 'value = 1\n', 'utf8')
    const writtenFiles: string[] = []

    const patched = JSON.parse(await runAgentTool(
      project,
      toolCall('file_patch', {
        folder_id: 'root',
        path: 'example.py',
        old_snippet: 'value = 1',
        new_snippet: 'value = 2',
      }),
      writtenFiles,
    )) as { success: boolean; diff: string }

    expect(patched.success).toBe(true)
    expect(patched.diff).toContain('-value = 1')
    expect(await readFile(target, 'utf8')).toBe('value = 2\n')

    await writeFile(target, 'same\nsame\n', 'utf8')
    const ambiguous = JSON.parse(await runAgentTool(
      project,
      toolCall('file_patch', {
        folder_id: 'root',
        path: 'example.py',
        old_snippet: 'same',
        new_snippet: 'changed',
      }),
      writtenFiles,
    )) as { success: boolean; diff: null }

    expect(ambiguous).toEqual(expect.objectContaining({ success: false, diff: null }))
    expect(await readFile(target, 'utf8')).toBe('same\nsame\n')
  })

  it('does not start a file operation after the round is stopped', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(runAgentTool(
      project,
      toolCall('write_file', { folder_id: 'root', path: 'stopped.txt', content: 'should not be written' }),
      [],
      { conversationId: 'conversation', signal: controller.signal },
    )).rejects.toThrow('Operation stopped')

    await expect(readFile(join(root, 'stopped.txt'), 'utf8')).rejects.toThrow()
  })

  it('rejects path traversal before file access', async () => {
    await expect(runAgentTool(
      project,
      toolCall('write_file', { folder_id: 'root', path: '../outside.txt', content: 'unsafe' }),
      [],
    )).rejects.toThrow('Path is outside the project root')
  })

  it('builds a filtered tree and searches matching project text', async () => {
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'src/app.ts'), 'const Needle = true\n', 'utf8')
    await writeFile(join(root, 'src/app.py'), 'needle = false\n', 'utf8')
    await writeFile(join(root, 'node_modules/noise.ts'), 'Needle', 'utf8')

    const tree = JSON.parse(await runAgentTool(
      project,
      toolCall('project_tree', { folder_id: 'root', path: '.', max_depth: 3 }),
      [],
    )) as { tree: { children: Array<{ name: string }> } }
    const search = JSON.parse(await runAgentTool(
      project,
      toolCall('project_search_text', {
        query: 'needle',
        file_pattern: '**/*.ts',
        case_sensitive: false,
      }),
      [],
    )) as { matches: Array<{ folder_id: string; file_path: string; line_no: number; snippet: string }> }

    expect(tree.tree.children.map((child) => child.name)).toContain('src')
    expect(tree.tree.children.map((child) => child.name)).not.toContain('node_modules')
    expect(search.matches).toEqual([{
      folder_id: 'root',
      file_path: 'src/app.ts',
      line_no: 1,
      snippet: 'const Needle = true',
    }])
  })

  it('rejects invalid JSON arguments', async () => {
    const invalid: ToolCall = {
      id: 'call-1',
      type: 'function',
      function: { name: 'read_file', arguments: '{' },
    }

    await expect(runAgentTool(project, invalid, [])).rejects.toThrow(
      'Tool arguments must be valid JSON',
    )
  })
})
