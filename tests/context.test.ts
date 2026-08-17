import { describe, expect, it } from 'vitest'
import { manageContext, type ContextMessage } from '../src/main/context'
import { defaultModelConfig, type ModelConfig } from '../src/shared/types'

function config(overrides: Partial<ModelConfig>): ModelConfig {
  return { ...defaultModelConfig, ...overrides }
}

function compressionThreshold(messages: ContextMessage[]): number {
  return manageContext(messages, [], config({ modelMaxContext: 1_000_000 })).metrics.originalTokens
}

describe('manageContext', () => {
  it('does not change messages below the trigger threshold', () => {
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]

    const result = manageContext(messages, [], config({ modelMaxContext: 10_000, safeOutputMargin: 1_000 }))

    expect(result.messages).toBe(messages)
    expect(result.metrics).toEqual(expect.objectContaining({
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
      config({ modelMaxContext: threshold + 100, safeOutputMargin: 100, recentKeepRounds: 1 }),
    )

    expect(result.metrics.filtered).toBe(true)
    expect(result.metrics.rewritten).toBe(false)
    expect(result.metrics.truncated).toBe(false)
    expect(result.messages[1].content).toContain(code)
    expect(result.messages[1].content?.match(new RegExp(duplicate, 'g'))).toHaveLength(1)
    expect(result.messages[2].content).toBe(traceback)
    expect(result.messages.slice(-2)).toEqual(messages.slice(-2))
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
      config({ modelMaxContext: threshold + 100, safeOutputMargin: 100, recentKeepRounds: 1 }),
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
      config({ modelMaxContext: 100, safeOutputMargin: 10, recentKeepRounds: 1 }),
    )

    expect(result.metrics.truncated).toBe(true)
    expect(result.messages[0]).toEqual(messages[0])
    expect(result.messages).not.toContainEqual(messages[1])
    expect(result.messages).not.toContainEqual(messages[2])
    expect(result.messages.slice(-2)).toEqual(messages.slice(-2))
  })
})


