/** Provider-reported cumulative counters. Detail counters are subsets, never added to totals. */
export type ModelUsage = {
  source: 'provider'
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  reasoningOutputTokens?: number
}
const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens'] as const
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function isModelUsage(value: unknown): value is ModelUsage {
  const data = object(value)
  return data.source === 'provider' && fields.some((field) => counter(data[field]))
    && fields.every((field) => data[field] === undefined || counter(data[field]))
}

/** Only the Chat Completions contract used by Codey's request transport is normalized here. */
export function parseModelUsage(value: unknown): ModelUsage | undefined {
  const data = object(value)
  const values = {
    inputTokens: data.prompt_tokens,
    outputTokens: data.completion_tokens,
    totalTokens: data.total_tokens,
    cachedInputTokens: object(data.prompt_tokens_details).cached_tokens,
    reasoningOutputTokens: object(data.completion_tokens_details).reasoning_tokens,
  }
  const usage: ModelUsage = { source: 'provider' }
  for (const field of fields) if (counter(values[field])) usage[field] = values[field]
  return isModelUsage(usage) ? usage : undefined
}
