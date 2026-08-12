import type { ChatMessage, Project } from '../shared/types'
import { readConfig } from './config'
import { log } from './logger'
import { truncateOutput } from './sandbox'
import { createAgentTools, runAgentTool, type ToolCall } from './tools'

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
  log.debug('model.response', { status: response.status, body })
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
  const tools = createAgentTools(project)
  const apiMessages: ApiMessage[] = [
    {
      role: 'system',
      content: [
        'You are a coding agent working in the project folders below.',
        ...project.folders.map((folder) => `- ${folder.id}: ${folder.path}`),
        'Each folder is an independent sandbox root. Every path-based tool requires folder_id and a relative path.',
        `The project Python environment is stored under folder ID ${project.pythonEnvironmentFolderId}.`,
        'Inspect relevant files before editing. Prefer file_patch for a unique local change and write_file for complete file creation or replacement.',
        'Use file and project tools for general development work. Use Python tools only for Python-related tasks or explicit Python environment operations.',
        'Every tool is restricted to the project sandbox. Do not access .git, agent_venv, or cache directories.',
        'Tool calls and tool results are critical context and must be retained verbatim if conversation context is ever compacted.',
        'Do not run tests unless the user asks. After completing changes, give a concise summary.',
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

      apiMessages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls })
      for (const toolCall of toolCalls) {
        let content: string
        try {
          content = await runAgentTool(project, toolCall, writtenFiles)
        } catch (error) {
          content = truncateOutput(`Error: ${error instanceof Error ? error.message : 'Tool failed'}`)
        }
        apiMessages.push({ role: 'tool', tool_call_id: toolCall.id, content })
      }
    }
    throw new Error('The model exceeded the tool-call limit')
  } catch (error) {
    return { writtenFiles, error: error instanceof Error ? error.message : 'Request failed' }
  }
}
