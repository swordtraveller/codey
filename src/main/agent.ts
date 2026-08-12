import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChatMessage, Project } from '../shared/types'
import { readConfig } from './config'
import { log } from './logger'
import {
  installPythonPackages,
  runPython,
  safeResolveExistingPath,
  safeResolveWritablePath,
  truncateOutput,
} from './sandbox'

type ToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

type ApiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

type ChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: ToolCall[]
    }
  }>
  error?: { message?: string }
}

type AgentResult = {
  reply?: string
  writtenFiles: string[]
  error?: string
}

type ToolArguments = {
  folderPath?: string
  relativePath?: string
  content?: string
  args?: string[]
  packages?: string[]
  timeoutMs?: number
}

const maxFileSize = 200_000
const maxWriteSize = 1_000_000

async function resolveProjectPath(
  project: Project,
  folderPath: string,
  relativePath: string,
  allowMissing: boolean,
): Promise<string> {
  const root = project.folders.find(
    (folder) => folder.toLowerCase() === folderPath.toLowerCase(),
  )
  if (!root) {
    throw new Error('Path is outside the project folders')
  }

  const rootPath = await realpath(root)
  const segments = relativePath.split(/[\\/]+/)
  if (
    segments.some((segment) =>
      ['.git', 'agent_venv', '.agent_tmp'].includes(segment.toLowerCase()),
    )
  ) {
    throw new Error('Path is not available to the coding agent')
  }

  if (!allowMissing) {
    return safeResolveExistingPath(rootPath, relativePath || '.')
  }

  return safeResolveWritablePath(rootPath, relativePath || '.')
}

function getProjectRoot(project: Project): string {
  const root = project.folders[0]
  if (!root) {
    throw new Error('Add a project folder first')
  }
  return root
}

async function runTool(
  project: Project,
  toolCall: ToolCall,
  writtenFiles: string[],
): Promise<string> {
  const args = JSON.parse(toolCall.function.arguments) as ToolArguments

  if (toolCall.function.name === 'pip_install') {
    if (!Array.isArray(args.packages)) {
      throw new Error('packages are required')
    }
    return installPythonPackages(getProjectRoot(project), args.packages)
  }

  if (!args.folderPath || !args.relativePath) {
    throw new Error('folderPath and relativePath are required')
  }

  if (toolCall.function.name === 'list_directory') {
    const target = await resolveProjectPath(project, args.folderPath, args.relativePath, false)
    const entries = await readdir(target, { withFileTypes: true })
    return JSON.stringify(
      entries
        .filter((entry) =>
          !['.git', 'agent_venv', '.agent_tmp'].includes(entry.name.toLowerCase()),
        )
        .slice(0, 200)
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
        })),
    )
  }

  if (toolCall.function.name === 'read_file') {
    const target = await resolveProjectPath(project, args.folderPath, args.relativePath, false)
    if ((await stat(target)).size > maxFileSize) {
      throw new Error('File is too large to read')
    }
    return readFile(target, 'utf8')
  }

  if (toolCall.function.name === 'write_file') {
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > maxWriteSize) {
      throw new Error('File content is missing or too large')
    }
    const target = await resolveProjectPath(project, args.folderPath, args.relativePath, true)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, args.content, 'utf8')
    if (!writtenFiles.includes(target)) {
      writtenFiles.push(target)
    }
    return `Wrote ${args.relativePath}`
  }

  if (toolCall.function.name === 'run_python') {
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
    const scriptArgs = args.args ?? []
    if (!Array.isArray(scriptArgs) || scriptArgs.some((item) => typeof item !== 'string')) {
      throw new Error('args must be an array of strings')
    }
    await resolveProjectPath(project, args.folderPath, args.relativePath, false)
    return runPython(
      getProjectRoot(project),
      project.folders,
      args.folderPath,
      args.relativePath,
      scriptArgs,
      timeoutMs,
    )
  }

  throw new Error(`Unknown tool: ${toolCall.function.name}`)
}

function createTools(project: Project): object[] {
  const folderPath = {
    type: 'string',
    enum: project.folders,
    description: 'An exact project folder path.',
  }
  const relativePath = {
    type: 'string',
    description: 'A path relative to the selected project folder.',
  }

  return [
    {
      type: 'function',
      function: {
        name: 'list_directory',
        description: 'List files and directories in a project folder.',
        parameters: {
          type: 'object',
          properties: { folderPath, relativePath },
          required: ['folderPath', 'relativePath'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a UTF-8 text file from a project folder.',
        parameters: {
          type: 'object',
          properties: { folderPath, relativePath },
          required: ['folderPath', 'relativePath'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or replace a UTF-8 code file in a project folder.',
        parameters: {
          type: 'object',
          properties: {
            folderPath,
            relativePath,
            content: { type: 'string', description: 'Complete file content.' },
          },
          required: ['folderPath', 'relativePath', 'content'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_python',
        description: 'Run a Python script with the project agent_venv interpreter.',
        parameters: {
          type: 'object',
          properties: {
            folderPath,
            relativePath,
            args: { type: 'array', items: { type: 'string' }, maxItems: 20 },
            timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
          },
          required: ['folderPath', 'relativePath'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pip_install',
        description: 'Install Python packages into the project agent_venv environment.',
        parameters: {
          type: 'object',
          properties: {
            packages: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
          },
          required: ['packages'],
          additionalProperties: false,
        },
      },
    },
  ]
}

async function requestCompletion(messages: ApiMessage[], tools: object[]): Promise<ChatResponse> {
  const config = await readConfig()
  if (!config.baseUrl || !config.apiKey || !config.modelName) {
    throw new Error('Configure a model before sending a message')
  }

  const requestBody = {
    model: config.modelName,
    messages,
    tools,
    tool_choice: 'auto',
  }
  log.debug('model.request', {
    url: `${config.baseUrl}/chat/completions`,
    body: requestBody,
  })

  let response: Response
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })
  } catch (error) {
    log.error('model.request.failed', error instanceof Error ? error.message : 'Request failed')
    throw error
  }

  const body = await response.text()
  log.debug('model.response', {
    status: response.status,
    body,
  })
  let data: ChatResponse = {}
  try {
    data = JSON.parse(body) as ChatResponse
  } catch {
    // The status error below is more useful than a JSON parsing error.
  }
  if (!response.ok) {
    const message =
      data.error?.message || body.slice(0, 200) || `Request failed with status ${response.status}`
    log.error('model.response.failed', message)
    throw new Error(message)
  }
  return data
}

export async function develop(project: Project, messages: ChatMessage[]): Promise<AgentResult> {
  if (project.folders.length === 0) {
    return { writtenFiles: [], error: 'Add a project folder before sending a request' }
  }

  const writtenFiles: string[] = []
  const tools = createTools(project)
  const apiMessages: ApiMessage[] = [
    {
      role: 'system',
      content: [
        'You are a coding agent working in the project folders below.',
        ...project.folders.map((folder) => `- ${folder}`),
        'Inspect relevant files and use write_file to implement requested changes.',
        'Only access paths inside these folders. Use run_python for Python scripts and pip_install for packages. Do not run tests.',
        'After completing the changes, give a concise summary.',
      ].join('\n'),
    },
    ...messages.map((message) => ({ role: message.role, content: message.content })),
  ]

  try {
    for (let turn = 0; turn < 12; turn += 1) {
      const response = await requestCompletion(apiMessages, tools)
      const message = response.choices?.[0]?.message
      if (!message) {
        throw new Error('The model returned an empty response')
      }

      const toolCalls = message.tool_calls ?? []
      if (toolCalls.length > 20) {
        throw new Error('The model returned too many tool calls')
      }
      if (toolCalls.length === 0) {
        const reply = message.content?.trim()
        if (!reply) {
          throw new Error('The model returned an empty response')
        }
        return { reply, writtenFiles }
      }

      apiMessages.push({
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: toolCalls,
      })

      for (const toolCall of toolCalls) {
        let content: string
        try {
          content = truncateOutput(await runTool(project, toolCall, writtenFiles))
        } catch (error) {
          content = truncateOutput(
            `Error: ${error instanceof Error ? error.message : 'Tool failed'}`,
          )
        }
        apiMessages.push({ role: 'tool', tool_call_id: toolCall.id, content })
      }
    }

    throw new Error('The model exceeded the tool-call limit')
  } catch (error) {
    return {
      writtenFiles,
      error: error instanceof Error ? error.message : 'Request failed',
    }
  }
}
