import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Project, ProjectFolder } from '../shared/types'
import { readContextRecords, searchConversationContext } from './conversation-store'
import {
  gitAdd,
  gitCommit,
  gitDiff,
  gitGetCurrentBranch,
  gitLog,
  gitStatus,
} from './git'
import {
  executePythonCode,
  getPythonEnvironmentInfo,
  installPythonPackages,
  listPythonSymbols,
  runPythonScript,
  safeResolveExistingPath,
  safeResolveWritablePath,
  truncateOutput,
} from './sandbox'

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type ToolArguments = {
  folder_id?: string
  folder_ids?: string[]
  path?: string
  content?: string
  code?: string
  timeout?: number
  argv?: string[]
  packages?: string[]
  old_snippet?: string
  new_snippet?: string
  max_depth?: number
  query?: string
  file_pattern?: string | null
  case_sensitive?: boolean
  paths?: string[]
  message?: string
  staged?: boolean
  max_count?: number
  ids?: string[]
  limit?: number
}

type TreeNode = {
  name: string
  type: 'directory' | 'file'
  children?: TreeNode[]
}

type SearchMatch = {
  folder_id: string
  file_path: string
  line_no: number
  snippet: string
}

const maxFileSize = 200_000
const maxWriteSize = 1_000_000
const maxTreeNodes = 100
const maxSearchMatches = 30
const ignoredNames = new Set([
  '.git',
  '__pycache__',
  'agent_venv',
  '.agent_tmp',
  '.venv',
  'venv',
  'node_modules',
])

function abortError(): Error {
  const error = new Error('Operation stopped')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function assertAgentPath(inputPath: string): void {
  const segments = inputPath.split(/[\\/]+/)
  if (segments.some((segment) => ignoredNames.has(segment.toLowerCase()))) {
    throw new Error('Path is not available to the coding agent')
  }
}

function getFolder(project: Project, folderId: string): ProjectFolder {
  const folder = project.folders.find((item) => item.id === folderId)
  if (!folder) {
    throw new Error('folder_id is not part of this project')
  }
  return folder
}

function getEnvironmentFolder(project: Project): ProjectFolder {
  if (!project.pythonEnvironmentFolderId) {
    throw new Error('Add a project folder first')
  }
  return getFolder(project, project.pythonEnvironmentFolderId)
}

function projectFolderPaths(project: Project): string[] {
  return project.folders.map((folder) => folder.path)
}

async function resolveFolderPath(
  folder: ProjectFolder,
  inputPath: string,
  allowMissing: boolean,
): Promise<string> {
  assertAgentPath(inputPath || '.')
  return allowMissing
    ? safeResolveWritablePath(folder.path, inputPath || '.')
    : safeResolveExistingPath(folder.path, inputPath || '.')
}

function stringifyResult(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized.length <= 20_000) {
    return serialized
  }
  return JSON.stringify({ error: 'Tool result exceeded output limit', message: '[output truncated]' })
}

function markWritten(writtenFiles: string[], target: string): void {
  if (!writtenFiles.includes(target)) {
    writtenFiles.push(target)
  }
}

function simpleDiff(oldSnippet: string, newSnippet: string): string {
  return truncateOutput(
    [
      '--- old',
      '+++ new',
      ...oldSnippet.split(/\r?\n/).map((line) => `-${line}`),
      ...newSnippet.split(/\r?\n/).map((line) => `+${line}`),
    ].join('\n'),
    4_000,
  )
}

async function patchFile(
  folder: ProjectFolder,
  filePath: string,
  oldSnippet: string,
  newSnippet: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; message: string; diff: string | null; target?: string }> {
  throwIfAborted(signal)
  if (!oldSnippet) {
    throw new Error('old_snippet is required')
  }
  if (Buffer.byteLength(newSnippet, 'utf8') > maxWriteSize) {
    throw new Error('new_snippet is too large')
  }
  const target = await resolveFolderPath(folder, filePath, false)
  const file = await stat(target)
  if (!file.isFile() || file.size > maxWriteSize) {
    throw new Error('Target must be a writable text file no larger than 1 MB')
  }
  const content = await readFile(target, 'utf8')
  const firstMatch = content.indexOf(oldSnippet)
  if (firstMatch === -1) {
    return { success: false, message: 'old_snippet was not found; file was not modified', diff: null }
  }
  if (content.indexOf(oldSnippet, firstMatch + oldSnippet.length) !== -1) {
    return { success: false, message: 'old_snippet matched more than once; file was not modified', diff: null }
  }
  const updated = `${content.slice(0, firstMatch)}${newSnippet}${content.slice(firstMatch + oldSnippet.length)}`
  throwIfAborted(signal)
  await writeFile(target, updated, 'utf8')
  return {
    success: true,
    message: `Patched ${filePath}`,
    diff: simpleDiff(oldSnippet, newSnippet),
    target,
  }
}

async function buildTree(
  folder: ProjectFolder,
  rootPath: string,
  maxDepth: number,
  signal?: AbortSignal,
): Promise<{ tree: TreeNode; warnings: string[] }> {
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 8) {
    throw new Error('max_depth must be an integer between 0 and 8')
  }
  const warnings: string[] = []
  let nodeCount = 0

  async function visit(relativePath: string, depth: number): Promise<TreeNode> {
    throwIfAborted(signal)
    const target = await resolveFolderPath(folder, relativePath, false)
    const info = await stat(target)
    const name = relativePath === '.' ? '.' : relativePath.split(/[\\/]/).at(-1) || '.'
    const node: TreeNode = {
      name: name.slice(0, 100),
      type: info.isDirectory() ? 'directory' : 'file',
    }
    nodeCount += 1
    if (!info.isDirectory() || depth >= maxDepth || nodeCount >= maxTreeNodes) {
      if (nodeCount >= maxTreeNodes && !warnings.includes('[output truncated]')) {
        warnings.push('[output truncated]')
      }
      return node
    }

    const entries = await readdir(target, { withFileTypes: true })
    const children: TreeNode[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      throwIfAborted(signal)
      if (nodeCount >= maxTreeNodes) {
        break
      }
      if (ignoredNames.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) {
        continue
      }
      const childPath = relativePath === '.' ? entry.name : `${relativePath}/${entry.name}`
      try {
        children.push(await visit(childPath, depth + 1))
      } catch (error) {
        warnings.push(`${childPath}: ${error instanceof Error ? error.message : 'Unable to read path'}`)
      }
    }
    node.children = children
    return node
  }

  return { tree: await visit(rootPath || '.', 0), warnings: warnings.slice(0, 20) }
}

function globExpression(pattern: string | null | undefined): RegExp | null {
  if (!pattern) {
    return null
  }
  if (pattern.includes('..') || pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)) {
    throw new Error('file_pattern must be a relative glob')
  }
  let expression = '^'
  const normalized = pattern.replaceAll('\\', '/')
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]
    if (character === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        expression += '(?:.*/)?'
        index += 2
      } else {
        expression += '.*'
        index += 1
      }
    } else if (character === '*') {
      expression += '[^/]*'
    } else if (character === '?') {
      expression += '[^/]'
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${expression}$`)
}

async function searchFolder(
  folder: ProjectFolder,
  matcher: RegExp,
  fileMatcher: RegExp | null,
  matches: SearchMatch[],
  signal?: AbortSignal,
): Promise<boolean> {
  async function visit(relativeDirectory: string): Promise<boolean> {
    throwIfAborted(signal)
    const directory = await resolveFolderPath(folder, relativeDirectory, false)
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      throwIfAborted(signal)
      if (ignoredNames.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) {
        continue
      }
      const relativePath = relativeDirectory === '.' ? entry.name : `${relativeDirectory}/${entry.name}`
      if (entry.isDirectory()) {
        if (await visit(relativePath)) return true
        continue
      }
      if (fileMatcher && !fileMatcher.test(relativePath)) {
        continue
      }
      const target = await resolveFolderPath(folder, relativePath, false)
      const info = await stat(target)
      if (!info.isFile() || info.size > 1_000_000) {
        continue
      }
      const buffer = await readFile(target)
      if (buffer.includes(0)) {
        continue
      }
      const lines = buffer.toString('utf8').split(/\r?\n/)
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (matcher.test(lines[lineIndex])) {
          matches.push({
            folder_id: folder.id,
            file_path: relativePath.slice(0, 300),
            line_no: lineIndex + 1,
            snippet: truncateOutput(lines[lineIndex].trim(), 200),
          })
          if (matches.length >= maxSearchMatches) {
            return true
          }
        }
      }
    }
    return false
  }

  return visit('.')
}

async function searchProject(
  folders: ProjectFolder[],
  query: string,
  filePattern: string | null | undefined,
  caseSensitive: boolean,
  signal?: AbortSignal,
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  throwIfAborted(signal)
  if (!query || query.length > 500) {
    throw new Error('query must contain 1 to 500 characters')
  }
  let matcher: RegExp
  try {
    matcher = new RegExp(query, caseSensitive ? '' : 'i')
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  const fileMatcher = globExpression(filePattern)
  const matches: SearchMatch[] = []
  let truncated = false
  for (const folder of folders) {
    throwIfAborted(signal)
    if (await searchFolder(folder, matcher, fileMatcher, matches, signal)) {
      truncated = true
      break
    }
  }
  return { matches, truncated }
}

function requirePathArguments(args: ToolArguments): { folderId: string; path: string } {
  if (typeof args.folder_id !== 'string' || typeof args.path !== 'string') {
    throw new Error('folder_id and path are required')
  }
  return { folderId: args.folder_id, path: args.path }
}

export async function runAgentTool(
  project: Project,
  toolCall: ToolCall,
  writtenFiles: string[],
  runtime?: { conversationId: string; signal?: AbortSignal },
): Promise<string> {
  let args: ToolArguments
  try {
    args = JSON.parse(toolCall.function.arguments) as ToolArguments
  } catch {
    throw new Error('Tool arguments must be valid JSON')
  }
  throwIfAborted(runtime?.signal)
  if (toolCall.function.name === 'context_search') {
    if (!runtime || typeof args.query !== 'string') throw new Error('conversation context runtime and query are required')
    const matches = await searchConversationContext(project.id, runtime.conversationId, args.query, args.limit ?? 10)
    return stringifyResult({ matches: matches.map(({ id, kind, role, createdAt, preview, tokenCount, truthRefs, compressionMethod }) => ({ id, kind, role, createdAt, preview, tokenCount, truthRefs, compressionMethod })) })
  }
  if (toolCall.function.name === 'context_read') {
    if (!runtime || !Array.isArray(args.ids) || args.ids.some((id) => typeof id !== 'string')) {
      throw new Error('conversation context runtime and ids are required')
    }
    const messages = await readContextRecords(project.id, runtime.conversationId, args.ids)
    return stringifyResult({ records: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      representation: message.representation ?? 'original',
      truthRefs: message.truthRefs ?? [],
      createdAt: message.createdAt,
    })) })
  }
  if (toolCall.function.name === 'git_status') {
    if (typeof args.folder_id !== 'string') throw new Error('folder_id is required')
    return stringifyResult(await gitStatus(getFolder(project, args.folder_id).path, runtime?.signal))
  }
  if (toolCall.function.name === 'git_diff') {
    if (typeof args.folder_id !== 'string' || typeof args.staged !== 'boolean') {
      throw new Error('folder_id and staged are required')
    }
    return stringifyResult(await gitDiff(getFolder(project, args.folder_id).path, args.staged, runtime?.signal))
  }
  if (toolCall.function.name === 'git_add') {
    if (typeof args.folder_id !== 'string' || !Array.isArray(args.paths)) {
      throw new Error('folder_id and paths are required')
    }
    return stringifyResult(await gitAdd(getFolder(project, args.folder_id).path, args.paths, runtime?.signal))
  }
  if (toolCall.function.name === 'git_commit') {
    if (typeof args.folder_id !== 'string' || typeof args.message !== 'string') {
      throw new Error('folder_id and message are required')
    }
    return stringifyResult(await gitCommit(getFolder(project, args.folder_id).path, args.message, runtime?.signal))
  }
  if (toolCall.function.name === 'git_log') {
    if (typeof args.folder_id !== 'string' || typeof args.max_count !== 'number') {
      throw new Error('folder_id and max_count are required')
    }
    return stringifyResult(await gitLog(getFolder(project, args.folder_id).path, args.max_count, runtime?.signal))
  }
  if (toolCall.function.name === 'git_get_current_branch') {
    if (typeof args.folder_id !== 'string') throw new Error('folder_id is required')
    return stringifyResult(await gitGetCurrentBranch(getFolder(project, args.folder_id).path, runtime?.signal))
  }

  const environmentFolder = getEnvironmentFolder(project)
  const folderPaths = projectFolderPaths(project)

  if (toolCall.function.name === 'python_execute') {
    if (typeof args.code !== 'string' || typeof args.timeout !== 'number') {
      throw new Error('code and timeout are required')
    }
    const workingFolder = args.folder_id ? getFolder(project, args.folder_id) : environmentFolder
    return stringifyResult(
      await executePythonCode(
        environmentFolder.path,
        folderPaths,
        workingFolder.path,
        args.code,
        args.timeout,
        runtime?.signal,
      ),
    )
  }
  if (toolCall.function.name === 'python_install_package') {
    if (!Array.isArray(args.packages)) throw new Error('packages are required')
    return stringifyResult(await installPythonPackages(environmentFolder.path, args.packages, runtime?.signal))
  }
  if (toolCall.function.name === 'python_env_info') {
    return stringifyResult(await getPythonEnvironmentInfo(environmentFolder.path, runtime?.signal))
  }
  if (toolCall.function.name === 'project_search_text') {
    if (typeof args.query !== 'string' || typeof args.case_sensitive !== 'boolean') {
      throw new Error('query and case_sensitive are required')
    }
    const folders = args.folder_ids === undefined
      ? project.folders
      : args.folder_ids.map((folderId) => getFolder(project, folderId))
    return stringifyResult(
      await searchProject(folders, args.query, args.file_pattern, args.case_sensitive, runtime?.signal),
    )
  }

  const { folderId, path } = requirePathArguments(args)
  const folder = getFolder(project, folderId)

  if (toolCall.function.name === 'list_directory') {
    const target = await resolveFolderPath(folder, path, false)
    const entries = await readdir(target, { withFileTypes: true })
    return stringifyResult(
      entries
        .filter((entry) => !ignoredNames.has(entry.name.toLowerCase()) && !entry.isSymbolicLink())
        .slice(0, 200)
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
        })),
    )
  }
  if (toolCall.function.name === 'read_file') {
    const target = await resolveFolderPath(folder, path, false)
    if ((await stat(target)).size > maxFileSize) throw new Error('File is too large to read')
    return truncateOutput(await readFile(target, 'utf8'))
  }
  if (toolCall.function.name === 'write_file') {
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > maxWriteSize) {
      throw new Error('File content is missing or too large')
    }
    const target = await resolveFolderPath(folder, path, true)
    await mkdir(dirname(target), { recursive: true })
    throwIfAborted(runtime?.signal)
    await writeFile(target, args.content, 'utf8')
    markWritten(writtenFiles, target)
    return stringifyResult({ success: true, message: `Wrote ${path}` })
  }
  if (toolCall.function.name === 'file_patch') {
    if (typeof args.old_snippet !== 'string' || typeof args.new_snippet !== 'string') {
      throw new Error('old_snippet and new_snippet are required')
    }
    const result = await patchFile(folder, path, args.old_snippet, args.new_snippet, runtime?.signal)
    if (result.target) markWritten(writtenFiles, result.target)
    return stringifyResult({ success: result.success, message: result.message, diff: result.diff })
  }
  if (toolCall.function.name === 'python_run_script') {
    if (typeof args.timeout !== 'number') throw new Error('timeout is required')
    const argv = args.argv ?? []
    if (!Array.isArray(argv) || argv.some((item) => typeof item !== 'string') || argv.length > 20) {
      throw new Error('argv must contain at most 20 strings')
    }
    return stringifyResult(
      await runPythonScript(
        environmentFolder.path,
        folderPaths,
        folder.path,
        path,
        argv,
        args.timeout,
      ),
    )
  }
  if (toolCall.function.name === 'python_list_symbols') {
    return stringifyResult(
      await listPythonSymbols(environmentFolder.path, folder.path, path, runtime?.signal),
    )
  }
  if (toolCall.function.name === 'project_tree') {
    if (typeof args.max_depth !== 'number') throw new Error('max_depth is required')
    return stringifyResult(await buildTree(folder, path, args.max_depth, runtime?.signal))
  }

  throw new Error(`Unknown tool: ${toolCall.function.name}`)
}

export function createAgentTools(project: Project): object[] {
  const folderId = {
    type: 'string',
    enum: project.folders.map((folder) => folder.id),
    description: 'The stable ID of a folder attached to this project.',
  }
  const path = {
    type: 'string',
    description: 'A path relative to the selected project folder.',
  }
  const timeout = {
    type: 'number',
    minimum: 1,
    maximum: 120,
    description: 'Execution timeout in seconds.',
  }
  const pathProperties = { folder_id: folderId, path }
  const pathRequired = ['folder_id', 'path']
  const gitFolderId = {
    ...folderId,
    description: 'A project folder that is itself a Git repository root.',
  }

  return [
    { type: 'function', function: { name: 'context_search', description: 'Search indexed conversation Cold truth and summary records. Returns metadata only; use context_read for content.', parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'], additionalProperties: false } } },
    { type: 'function', function: { name: 'context_read', description: 'Read selected conversation context records. Truth records are authoritative; summaries are explicitly lossy and non-authoritative.', parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } }, required: ['ids'], additionalProperties: false } } },
    { type: 'function', function: { name: 'list_directory', description: 'List files and directories in a project folder.', parameters: { type: 'object', properties: pathProperties, required: pathRequired, additionalProperties: false } } },
    { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file from a project folder.', parameters: { type: 'object', properties: pathProperties, required: pathRequired, additionalProperties: false } } },
    { type: 'function', function: { name: 'write_file', description: 'Create or replace a UTF-8 code file in a project folder.', parameters: { type: 'object', properties: { ...pathProperties, content: { type: 'string', description: 'Complete file content.' } }, required: [...pathRequired, 'content'], additionalProperties: false } } },
    { type: 'function', function: { name: 'python_execute', description: 'Execute an in-memory Python code snippet without allowing file writes.', parameters: { type: 'object', properties: { code: { type: 'string' }, timeout, folder_id: { ...folderId, description: 'Optional project folder to use as the working directory.' } }, required: ['code', 'timeout'], additionalProperties: false } } },
    { type: 'function', function: { name: 'python_run_script', description: 'Run an existing project Python script using the project agent_venv.', parameters: { type: 'object', properties: { ...pathProperties, argv: { type: 'array', items: { type: 'string' }, maxItems: 20 }, timeout }, required: [...pathRequired, 'timeout'], additionalProperties: false } } },
    { type: 'function', function: { name: 'python_install_package', description: 'Install packages into the project agent_venv environment.', parameters: { type: 'object', properties: { packages: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } }, required: ['packages'], additionalProperties: false } } },
    { type: 'function', function: { name: 'file_patch', description: 'Replace one exact text snippet in an existing project file.', parameters: { type: 'object', properties: { ...pathProperties, old_snippet: { type: 'string' }, new_snippet: { type: 'string' } }, required: [...pathRequired, 'old_snippet', 'new_snippet'], additionalProperties: false } } },
    { type: 'function', function: { name: 'python_env_info', description: 'Get structured information about the project Python environment.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
    { type: 'function', function: { name: 'python_list_symbols', description: 'Statically list classes and functions in a project Python file.', parameters: { type: 'object', properties: pathProperties, required: pathRequired, additionalProperties: false } } },
    { type: 'function', function: { name: 'project_tree', description: 'Return a filtered directory tree from one project folder.', parameters: { type: 'object', properties: { ...pathProperties, max_depth: { type: 'integer', minimum: 0, maximum: 8 } }, required: [...pathRequired, 'max_depth'], additionalProperties: false } } },
    { type: 'function', function: { name: 'project_search_text', description: 'Search text across all or selected project folders using a JavaScript regular expression.', parameters: { type: 'object', properties: { query: { type: 'string' }, file_pattern: { type: ['string', 'null'], description: 'Optional relative glob such as **/*.py.' }, case_sensitive: { type: 'boolean' }, folder_ids: { type: 'array', items: folderId, uniqueItems: true, description: 'Optional folder IDs. Omit to search all project folders.' } }, required: ['query', 'case_sensitive'], additionalProperties: false } } },
    { type: 'function', function: { name: 'git_status', description: 'Show the concise working tree and staging status for a project Git repository.', parameters: { type: 'object', properties: { folder_id: gitFolderId }, required: ['folder_id'], additionalProperties: false } } },
    { type: 'function', function: { name: 'git_diff', description: 'Show unstaged or staged changes for a project Git repository.', parameters: { type: 'object', properties: { folder_id: gitFolderId, staged: { type: 'boolean', description: 'True to show staged changes; false to show unstaged changes.' } }, required: ['folder_id', 'staged'], additionalProperties: false } } },
    { type: 'function', function: { name: 'git_add', description: 'Stage an explicit list of project files. Repository-wide paths and directories are rejected.', parameters: { type: 'object', properties: { folder_id: gitFolderId, paths: { type: 'array', items: { type: 'string', maxLength: 500, description: 'A file path relative to the repository root.' }, minItems: 1, maxItems: 100, uniqueItems: true } }, required: ['folder_id', 'paths'], additionalProperties: false } } },
    { type: 'function', function: { name: 'git_commit', description: 'Commit currently staged changes. Fails when the staging area is empty.', parameters: { type: 'object', properties: { folder_id: gitFolderId, message: { type: 'string', minLength: 1, maxLength: 5000 } }, required: ['folder_id', 'message'], additionalProperties: false } } },
    { type: 'function', function: { name: 'git_log', description: 'Show recent commits from a project Git repository.', parameters: { type: 'object', properties: { folder_id: gitFolderId, max_count: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['folder_id', 'max_count'], additionalProperties: false } } },
    { type: 'function', function: { name: 'git_get_current_branch', description: 'Return the current branch or report a detached HEAD.', parameters: { type: 'object', properties: { folder_id: gitFolderId }, required: ['folder_id'], additionalProperties: false } } },
  ]
}
