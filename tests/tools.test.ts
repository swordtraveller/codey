import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentTools, runAgentTool, type ToolCall } from '../src/main/tools'
import { defaultCommandExecutionConfig, type Project } from '../src/shared/types'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '.',
  },
}))

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
      archived: false,
      defaultModelConfigId: null,
      contextConfigOverride: null,
      commandExecutionDefault: { ...defaultCommandExecutionConfig },
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
    ]))
  })

  it('hides python, node, frontend, and git tools by default and shows find_hidden_toolset', () => {
    const definitions = createAgentTools(project) as Array<{ function: { name: string } }>
    const names = definitions.map((definition) => definition.function.name)

    const hidden = [
      'python_execute', 'python_run_script', 'python_install_package', 'python_env_info', 'python_list_symbols',
      'node_package_command', 'node_package_script', 'node_validate',
      'frontend_start_dev_server', 'frontend_get_dev_server_status', 'frontend_get_dev_server_logs', 'frontend_stop_dev_server',
      'git_status', 'git_diff', 'git_add', 'git_unstage', 'git_commit', 'git_log', 'git_get_current_branch',
    ]
    for (const tool of hidden) {
      expect(names).not.toContain(tool)
    }
    expect(names).toContain('find_hidden_toolset')
  })

  it('includes python tools once the python toolset is active', () => {
    const definitions = createAgentTools(project, false, undefined, null, ['python']) as Array<{ function: { name: string } }>
    const names = definitions.map((definition) => definition.function.name)

    expect(names).toContain('python_execute')
    expect(names).toContain('python_run_script')
    expect(names).toContain('python_install_package')
    expect(names).toContain('python_env_info')
    expect(names).toContain('python_list_symbols')
  })

  it('includes node, frontend, and git tools once their toolsets are active', () => {
    const definitions = createAgentTools(project, false, undefined, null, ['node', 'frontend', 'git']) as Array<{ function: { name: string } }>
    const names = definitions.map((definition) => definition.function.name)

    expect(names).toContain('node_package_command')
    expect(names).toContain('node_package_script')
    expect(names).toContain('node_validate')
    expect(names).toContain('frontend_start_dev_server')
    expect(names).toContain('frontend_get_dev_server_status')
    expect(names).toContain('frontend_get_dev_server_logs')
    expect(names).toContain('frontend_stop_dev_server')
    expect(names).toContain('git_status')
    expect(names).toContain('git_diff')
    expect(names).toContain('git_add')
    expect(names).toContain('git_unstage')
    expect(names).toContain('git_commit')
    expect(names).toContain('git_log')
    expect(names).toContain('git_get_current_branch')
    // Python stays hidden unless unlocked.
    expect(names).not.toContain('python_execute')
  })

  it('unlocks the python toolset via find_hidden_toolset and reports misses', async () => {
    const writtenFiles: string[] = []
    const unlocked: string[] = []
    const runtime = {
      conversationId: 'c',
      onToolsetUnlocked: (keyword: string): void => { unlocked.push(keyword) },
    }

    const hit = JSON.parse(await runAgentTool(
      project,
      toolCall('find_hidden_toolset', { keyword: 'python' }),
      writtenFiles,
      runtime,
    )) as { found: string[] }
    expect(hit.found).toEqual(['python'])
    expect(unlocked).toEqual(['python'])

    const miss = JSON.parse(await runAgentTool(
      project,
      toolCall('find_hidden_toolset', { keyword: 'nonexistent' }),
      writtenFiles,
      runtime,
    )) as { found: string[] }
    expect(miss.found).toEqual([])
    expect(unlocked).toEqual(['python'])
  })

  it('unlocks node, frontend, and git toolsets via find_hidden_toolset', async () => {
    const writtenFiles: string[] = []
    const unlocked: string[] = []
    const runtime = {
      conversationId: 'c',
      onToolsetUnlocked: (keyword: string): void => { unlocked.push(keyword) },
    }

    for (const keyword of ['node', 'frontend', 'git']) {
      const result = JSON.parse(await runAgentTool(
        project,
        toolCall('find_hidden_toolset', { keyword }),
        writtenFiles,
        runtime,
      )) as { found: string[] }
      expect(result.found).toEqual([keyword])
    }
    expect(unlocked).toEqual(['node', 'frontend', 'git'])
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

  it('patches CRLF files when snippets use LF line endings and preserves the file convention', async () => {
    const target = join(root, 'crlf.py')
    await writeFile(target, 'value = 1\r\nnext = 2\r\n', 'utf8')

    const patched = JSON.parse(await runAgentTool(
      project,
      toolCall('file_patch', {
        folder_id: 'root',
        path: 'crlf.py',
        old_snippet: 'value = 1\nnext = 2',
        new_snippet: 'value = 3\nnext = 4',
      }),
      [],
    )) as { success: boolean }

    expect(patched.success).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('value = 3\r\nnext = 4\r\n')
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
