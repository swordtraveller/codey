import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContextManagementConfig, ModelConfig } from '../shared/types'
import { createContextTokenCounter, normalizeToolCallSequence } from './context-utils'
import type { ContextMessage } from './context'

export type RhaiStrategyRuntime = {
  allowCustomStrategy?: boolean
  latestUserMessageId?: string
}

type RhaiRequest = {
  script: string
  context: {
    messages: Array<ContextMessage & { id: string }>
    tools: object[]
    config: {
      recentKeepRounds: number
    }
    runtime: {
      latestUserMessageId: string
    }
  }
}

type RhaiResponse = { ok: true; result: unknown } | { ok: false; error: string }

function runnerCandidates(): string[] {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const appPath = process.cwd()
  const runnerName = process.platform === 'win32' ? 'rhai-runner.exe' : 'rhai-runner'
  const resourcePath = typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined
  return [
    join(appPath, 'native', runnerName),
    join(currentDir, '..', '..', 'native', runnerName),
    ...(resourcePath ? [
      join(resourcePath, 'native', runnerName),
      join(resourcePath, 'app.asar.unpacked', 'native', runnerName),
    ] : []),
  ]
}

function findRunner(): string | undefined {
  return runnerCandidates().find((candidate) => existsSync(candidate))
}

function runRhai(request: RhaiRequest): RhaiResponse {
  const runner = findRunner()
  if (!runner) {
    return { ok: false, error: 'rhai-runner is not available' }
  }
  const result = spawnSync(runner, {
    input: JSON.stringify(request),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
  })
  if (result.error || result.status !== 0 || !result.stdout) {
    return { ok: false, error: 'rhai-runner failed' }
  }
  try {
    const parsed = JSON.parse(result.stdout) as RhaiResponse
    if (parsed.ok === true || parsed.ok === false) return parsed
    return { ok: false, error: 'rhai-runner returned an invalid response' }
  } catch {
    return { ok: false, error: 'rhai-runner returned invalid JSON' }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function selectedMessages(result: unknown): unknown[] | undefined {
  if (Array.isArray(result)) return result
  if (isRecord(result) && Array.isArray(result.messages)) return result.messages
  return undefined
}

export function applyCustomRhaiStrategy(
  messages: ContextMessage[],
  tools: object[],
  modelConfig: ModelConfig,
  contextConfig: ContextManagementConfig,
  runtime: RhaiStrategyRuntime,
): ContextMessage[] | undefined {
  if (!runtime.allowCustomStrategy || !contextConfig.customStrategyEnabled || !contextConfig.customStrategyScript?.trim()) {
    return undefined
  }

  const idByDslId = new Map<string, ContextMessage>()
  const dslMessages = messages.map((message, index) => {
    const id = message.id ?? `__rhai_message_${index}`
    idByDslId.set(id, message)
    return { ...message, id }
  })
  const totalTokens = Math.max(1, Math.floor(modelConfig.modelMaxContext))
  const inferredLatestUserMessageId = [...dslMessages].reverse().find((message) => message.role === 'user')?.id
  const latestUserMessageId = runtime.latestUserMessageId ?? inferredLatestUserMessageId
  const request: RhaiRequest = {
    script: contextConfig.customStrategyScript,
    context: {
      messages: dslMessages,
      tools,
      config: {
        recentKeepRounds: contextConfig.recentKeepRounds,
      },
      runtime: {
        latestUserMessageId: latestUserMessageId ?? '',
      },
    },
  }

  const contextModule = {
    model_max_context: totalTokens,
    model_max_output: modelConfig.modelMaxOutputTokens === undefined ? null : modelConfig.modelMaxOutputTokens,
  }

  const response = runRhaiWithModule(request, contextModule)
  if (!response.ok) return undefined
  const selected = selectedMessages(response.result)
  if (!selected) return undefined

  const selectedIds = new Set<string>()
  for (const candidate of selected) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || selectedIds.has(candidate.id)) return undefined
    if (!idByDslId.has(candidate.id)) return undefined
    selectedIds.add(candidate.id)
  }
  const selectedContextMessages = dslMessages
    .filter((message) => selectedIds.has(message.id))
    .map((message) => idByDslId.get(message.id)!)
  const normalized = normalizeToolCallSequence(selectedContextMessages)
  // The only physical guard: a request larger than the model context window
  // cannot be sent. The strategy author owns every other trade-off.
  if (createContextTokenCounter(tools).request(normalized) > totalTokens) return undefined
  return normalized
}

function runRhaiWithModule(request: RhaiRequest, contextModule: { model_max_context: number; model_max_output: number | null }): RhaiResponse {
  const runner = findRunner()
  if (!runner) {
    return { ok: false, error: 'rhai-runner is not available' }
  }
  const payload = JSON.stringify({ ...request, contextModule })
  const result = spawnSync(runner, {
    input: payload,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
  })
  if (result.error || result.status !== 0 || !result.stdout) {
    return { ok: false, error: 'rhai-runner failed' }
  }
  try {
    const parsed = JSON.parse(result.stdout) as RhaiResponse
    if (parsed.ok === true || parsed.ok === false) return parsed
    return { ok: false, error: 'rhai-runner returned an invalid response' }
  } catch {
    return { ok: false, error: 'rhai-runner returned invalid JSON' }
  }
}
