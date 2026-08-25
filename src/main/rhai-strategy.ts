import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContextManagementConfig, ModelConfig } from '../shared/types'
import { countContextTokens, normalizeToolCallSequence } from './context-utils'
import type { ContextMessage } from './context'

export type RhaiStrategyRuntime = {
  allowCustomStrategy?: boolean
  latestUserMessageId?: string
}

type RhaiRequest = {
  script: string
  content: {
    messages: Array<ContextMessage & { id: string }>
    tools: object[]
    budget: number
    config: {
      modelMaxContext: number
      triggerThreshold: number
      hotTokenBudget: number
      warmTokenBudget: number
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
  if (!runner) return { ok: false, error: 'Rhai runner is unavailable' }
  const child = spawnSync(runner, [], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 1_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (child.error) return { ok: false, error: child.error.message }
  if (child.status !== 0) return { ok: false, error: child.stderr.trim() || `Rhai runner exited with code ${child.status}` }
  try {
    return JSON.parse(child.stdout) as RhaiResponse
  } catch {
    return { ok: false, error: 'Rhai runner returned invalid JSON' }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function selectedMessages(result: unknown): unknown[] | undefined {
  if (Array.isArray(result)) return result
  if (isRecord(result) && Array.isArray(result.messages)) return result.messages
  return undefined
}

/**
 * Executes the intentionally small, host-controlled Rhai contract.
 * Scripts may select existing messages, but cannot create or rewrite them.
 * Invalid scripts/results simply fall back to built-in policy.
 */
export function applyCustomRhaiStrategy(
  messages: ContextMessage[],
  tools: object[],
  modelConfig: ModelConfig,
  contextConfig: ContextManagementConfig,
  runtime: RhaiStrategyRuntime = {},
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
  const triggerThreshold = Math.max(1, modelConfig.modelMaxContext - contextConfig.safeOutputMargin)
  const inferredLatestUserMessageId = [...dslMessages].reverse().find((message) => message.role === 'user')?.id
  const latestUserMessageId = runtime.latestUserMessageId ?? inferredLatestUserMessageId
  const request: RhaiRequest = {
    script: contextConfig.customStrategyScript,
    content: {
      messages: dslMessages,
      tools,
      budget: contextConfig.layeredEnabled
        ? Math.min(contextConfig.hotTokenBudget, triggerThreshold)
        : triggerThreshold,
      config: {
        modelMaxContext: modelConfig.modelMaxContext,
        triggerThreshold,
        hotTokenBudget: contextConfig.hotTokenBudget,
        warmTokenBudget: contextConfig.warmTokenBudget,
        recentKeepRounds: contextConfig.recentKeepRounds,
      },
      runtime: {
        latestUserMessageId: latestUserMessageId ?? '',
      },
    },
  }
  const response = runRhai(request)
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
  if (countContextTokens({ messages: normalized, tools }) > triggerThreshold) return undefined
  return normalized
}
