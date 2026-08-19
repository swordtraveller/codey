import { describe, expect, it } from 'vitest'
import { countContextTokens, manageContext, type ContextMessage } from '../src/main/context'
import {
  defaultContextManagementConfig,
  defaultModelConfig,
  type ContextManagementConfig,
  type ModelConfig,
} from '../src/shared/types'

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { ...defaultModelConfig, ...overrides }
}

function context(overrides: Partial<ContextManagementConfig> = {}): ContextManagementConfig {
  return { ...defaultContextManagementConfig, ...overrides }
}

function compressionThreshold(messages: ContextMessage[]): number {
  return manageContext(
    messages,
    [],
    model({ modelMaxContext: 1_000_000 }),
    context(),
  ).metrics.originalTokens
}

describe('manageContext', () => {
  it('does not change messages below the trigger threshold', () => {
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: 10_000 }),
      context({ safeOutputMargin: 1_000 }),
    )

    expect(result.messages).toBe(messages)
    expect(result.metrics).toEqual(expect.objectContaining({
      layered: false,
      filtered: false,
      rewritten: false,
      truncated: false,
      compressionRatio: 1,
    }))
  })

  it('filters duplicate natural-language paragraphs while preserving protected content', () => {
    const duplicate = 'This paragraph is intentionally repeated to consume context tokens.'
    const code = '```ts\nconst answer = 42\n```'
    const traceback = 'Traceback (most recent call last):\n  File "main.py", line 1\nValueError: boom'
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: `${duplicate}\n\n${duplicate}\n\n${code}` },
      { role: 'assistant', content: traceback },
      { role: 'user', content: 'Keep this recent request exactly as written.' },
      { role: 'assistant', content: 'Keep this recent response exactly as written.' },
    ]
    const threshold = compressionThreshold(messages)

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: threshold + 100 }),
      context({ safeOutputMargin: 100, recentKeepRounds: 1 }),
    )

    expect(result.metrics.filtered).toBe(true)
    expect(result.metrics.rewritten).toBe(false)
    expect(result.messages[1].content).toContain(code)
    expect(result.messages[1].content?.match(new RegExp(duplicate, 'g'))).toHaveLength(1)
    expect(result.messages[2].content).toBe(traceback)
    expect(result.messages.slice(-2)).toEqual(messages.slice(-2))
  })

  it('honors independently disabled compression features', () => {
    const repeated = 'please keep this repeated paragraph unchanged.'
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: `${repeated}\n\n${repeated}` },
      { role: 'assistant', content: repeated },
      { role: 'user', content: 'Latest request' },
    ]

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: 100 }),
      context({
        safeOutputMargin: 10,
        recentKeepRounds: 1,
        filterEnabled: false,
        rewriteEnabled: false,
        truncateEnabled: false,
      }),
    )

    expect(result.messages).toBe(messages)
    expect(result.metrics).toEqual(expect.objectContaining({
      filtered: false,
      rewritten: false,
      truncated: false,
    }))
  })

  it('never rewrites tool calls or tool results', () => {
    const toolCall = {
      id: 'call-1',
      type: 'function' as const,
      function: { name: 'read_file', arguments: '{"folder_id":"root","path":"src/a.ts"}' },
    }
    const repeated = 'please inspect the file with all available project context.'
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: `${repeated}\n\n${repeated}` },
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'tool', content: 'const exact = true', tool_call_id: 'call-1' },
      { role: 'user', content: 'Latest request' },
    ]
    const threshold = compressionThreshold(messages)

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: threshold + 100 }),
      context({ safeOutputMargin: 100, recentKeepRounds: 1 }),
    )

    expect(result.messages).toContainEqual(messages[2])
    expect(result.messages).toContainEqual(messages[3])
  })

  it('truncates only the oldest complete rounds as a final fallback', () => {
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction that must remain.' },
      { role: 'user', content: 'old request '.repeat(40) },
      { role: 'assistant', content: 'old response '.repeat(40) },
      { role: 'user', content: 'recent request '.repeat(40) },
      { role: 'assistant', content: 'recent response '.repeat(40) },
    ]

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: 100 }),
      context({ safeOutputMargin: 10, recentKeepRounds: 1 }),
    )

    expect(result.metrics.truncated).toBe(true)
    expect(result.messages[0]).toEqual(messages[0])
    expect(result.messages).not.toContainEqual(messages[1])
    expect(result.messages).not.toContainEqual(messages[2])
    expect(result.messages.slice(-2)).toEqual(messages.slice(-2))
  })

  it('keeps recent Hot rounds intact and recalls relevant Cold rounds into Warm', () => {
    const toolCall = {
      id: 'call-1',
      type: 'function' as const,
      function: { name: 'read_file', arguments: '{}' },
    }
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'Implement authentication token parsing.' },
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'tool', content: 'export const token = true', tool_call_id: 'call-1' },
      { role: 'assistant', content: 'Authentication token work completed.' },
      { role: 'user', content: 'Unrelated old request.' },
      { role: 'assistant', content: 'Unrelated old reply.' },
      { role: 'user', content: 'Please update authentication token handling.' },
      { role: 'assistant', content: 'Current response.' },
    ]

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: 10_000 }),
      context({
        layeredEnabled: true,
        recentKeepRounds: 1,
        safeOutputMargin: 1_000,
        hotTokenBudget: 1_000,
        warmTokenBudget: 1_000,
        coldRecallTokenBudget: 1_000,
      }),
    )

    expect(result.metrics.layered).toBe(true)
    expect(result.metrics.recalled).toBe(true)
    expect(result.messages.slice(-2).map(({ role, content }) => ({ role, content })))
      .toEqual(messages.slice(-2).map(({ role, content }) => ({ role, content })))
    expect(result.messages.some((message) => message.tool_calls === messages[2].tool_calls)).toBe(true)
    expect(result.messages.some((message) => message.tool_call_id === 'call-1')).toBe(true)
    expect(result.messages.some((message) => message.content === messages[5].content)).toBe(false)
  })

  it('keeps fully protected older messages in Hot', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'old-user', role: 'user', content: 'Old request' },
      { id: 'protected', role: 'assistant', content: 'Pinned decision', protection: 'full' },
      { id: 'recent-user', role: 'user', content: 'Recent request' },
      { id: 'recent-assistant', role: 'assistant', content: 'Recent response' },
    ]

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: 10_000 }),
      context({
        layeredEnabled: true,
        recentKeepRounds: 1,
        safeOutputMargin: 1_000,
        hotTokenBudget: 1_000,
        warmTokenBudget: 0,
        coldRecallTokenBudget: 0,
      }),
    )

    expect(result.messages.find((message) => message.id === 'protected'))
      .toEqual(expect.objectContaining({
        contextLayer: 'hot',
        contextSource: 'hot',
        content: 'Pinned decision',
      }))
  })

  it('demotes the oldest recent round to Warm when Hot exceeds the input budget', () => {
    const repeated = 'please inspect the current implementation before making a minimal change.'
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'old-user', role: 'user', content: Array(80).fill(repeated).join('\n\n') },
      { id: 'old-assistant', role: 'assistant', content: Array(80).fill(repeated).join('\n\n') },
      { id: 'latest-user', role: 'user', content: 'Latest request' },
      { id: 'latest-assistant', role: 'assistant', content: 'Latest response' },
    ]
    const latestOnlyTokens = countContextTokens({ messages: [messages[0], ...messages.slice(-2)], tools: [] })
    const triggerThreshold = latestOnlyTokens + 150

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: triggerThreshold + 10 }),
      context({
        layeredEnabled: true,
        safeOutputMargin: 10,
        recentKeepRounds: 2,
        hotTokenBudget: 10_000,
        warmTokenBudget: 10_000,
        coldRecallTokenBudget: 0,
        rewriteEnabled: false,
        truncateEnabled: false,
      }),
    )

    expect(result.metrics.filtered).toBe(true)
    expect(result.metrics.compressedTokens).toBeLessThan(triggerThreshold)
    expect(result.messages.find((message) => message.id === 'old-user')?.contextLayer).toBe('warm')
    expect(result.messages.find((message) => message.id === 'old-assistant')?.contextLayer).toBe('warm')
    expect(result.messages.find((message) => message.id === 'latest-user')?.contextLayer).toBe('hot')
  })

  it('keeps tool IO exact in Warm while treating legacy full protection as partial', () => {
    const toolCall = {
      id: 'call-1',
      type: 'function' as const,
      function: { name: 'read_file', arguments: '{"file_path":"src/a.ts"}' },
    }
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'old-user', role: 'user', content: 'Inspect the file.' },
      { id: 'tool-call', role: 'assistant', content: null, tool_calls: [toolCall], protection: 'full' },
      { id: 'tool-result', role: 'tool', content: 'const exact = true', tool_call_id: 'call-1', protection: 'full' },
      { id: 'old-assistant', role: 'assistant', content: 'Inspection complete.' },
      { id: 'latest-user', role: 'user', content: 'Latest request' },
    ]

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: 10_000 }),
      context({
        layeredEnabled: true,
        safeOutputMargin: 1_000,
        recentKeepRounds: 1,
        hotTokenBudget: 1_000,
        warmTokenBudget: 1_000,
        coldRecallTokenBudget: 0,
      }),
    )

    expect(result.messages.find((message) => message.id === 'tool-call')).toEqual(expect.objectContaining({
      contextLayer: 'warm',
      protection: 'partial',
      tool_calls: [toolCall],
    }))
    expect(result.messages.find((message) => message.id === 'tool-result')).toEqual(expect.objectContaining({
      contextLayer: 'warm',
      protection: 'partial',
      content: 'const exact = true',
    }))
  })

  it('truncates an old tool round as a complete unit after demoting it from Hot', () => {
    const toolCall = {
      id: 'call-1',
      type: 'function' as const,
      function: { name: 'read_file', arguments: '{}' },
    }
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'old-user', role: 'user', content: 'Old request '.repeat(80) },
      { id: 'tool-call', role: 'assistant', content: null, tool_calls: [toolCall], protection: 'full' },
      { id: 'tool-result', role: 'tool', content: 'Exact tool output '.repeat(80), tool_call_id: 'call-1', protection: 'full' },
      { id: 'old-assistant', role: 'assistant', content: 'Old response '.repeat(80) },
      { id: 'latest-user', role: 'user', content: 'Latest request' },
    ]
    const latestOnlyTokens = countContextTokens({ messages: [messages[0], messages.at(-1)], tools: [] })
    const triggerThreshold = latestOnlyTokens + 50

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: triggerThreshold + 10 }),
      context({
        layeredEnabled: true,
        safeOutputMargin: 10,
        recentKeepRounds: 2,
        hotTokenBudget: 10_000,
        warmTokenBudget: 10_000,
        coldRecallTokenBudget: 0,
        filterEnabled: false,
        rewriteEnabled: false,
      }),
    )

    expect(result.metrics.truncated).toBe(true)
    expect(result.metrics.compressedTokens).toBeLessThan(triggerThreshold)
    expect(result.messages.some((message) => ['old-user', 'tool-call', 'tool-result', 'old-assistant'].includes(message.id ?? ''))).toBe(false)
    expect(result.messages.find((message) => message.id === 'latest-user')?.contextLayer).toBe('hot')
  })

  it('does not automatically demote a recent round with explicit full protection', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'protected-user', role: 'user', content: 'Protected evidence '.repeat(80) },
      { id: 'protected-assistant', role: 'assistant', content: 'Pinned decision', protection: 'full' },
      { id: 'latest-user', role: 'user', content: 'Latest request' },
    ]
    const triggerThreshold = countContextTokens({ messages: [messages[0], messages.at(-1)], tools: [] }) + 10

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: triggerThreshold + 10 }),
      context({
        layeredEnabled: true,
        safeOutputMargin: 10,
        recentKeepRounds: 2,
        hotTokenBudget: 10_000,
        warmTokenBudget: 10_000,
        coldRecallTokenBudget: 0,
      }),
    )

    expect(result.metrics.compressedTokens).toBeGreaterThanOrEqual(triggerThreshold)
    expect(result.messages.find((message) => message.id === 'protected-user')?.contextLayer).toBe('hot')
    expect(result.messages.find((message) => message.id === 'protected-assistant')?.contextLayer).toBe('hot')
  })

  it('does not mutate canonical input messages', () => {
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'please repeat\n\nplease repeat' },
      { role: 'assistant', content: 'old reply' },
      { role: 'user', content: 'latest' },
    ]
    const original = structuredClone(messages)

    manageContext(
      messages,
      [],
      model({ modelMaxContext: 100 }),
      context({ safeOutputMargin: 10, recentKeepRounds: 1 }),
    )

    expect(messages).toEqual(original)
  })
})
