import { describe, expect, it } from 'vitest'
import { countContextTokens, manageContext, normalizeToolCallSequence, SUMMARY_LABEL, type ContextMessage } from '../src/main/context'
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
  return manageContext(messages, [], model({ modelMaxContext: 1_000_000 }), context()).metrics.originalTokens
}

function hotBudget(messages: ContextMessage[]): number {
  return countContextTokens(messages) + 20
}

describe('manageContext', () => {
  it('removes incomplete tool-call blocks before provider requests', () => {
    const toolCall = { id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'user', content: 'Follow-up' },
      { role: 'tool', content: 'orphan result', tool_call_id: 'call-1' },
    ]

    expect(normalizeToolCallSequence(messages)).toEqual([
      messages[0],
      messages[2],
    ])
  })


  it('does not change messages below the trigger threshold', () => {
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]

    const result = manageContext(messages, [], model({ modelMaxContext: 10_000 }), context({ safeOutputMargin: 1_000 }))

    expect(result.messages).toBe(messages)
    expect(result.metrics).toEqual(expect.objectContaining({ layered: false, filtered: false, rewritten: false, truncated: false, compressionRatio: 1 }))
  })

  it('filters duplicate natural-language paragraphs while preserving protected content in single-layer mode', () => {
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

    const result = manageContext(messages, [], model({ modelMaxContext: threshold + 100 }), context({ safeOutputMargin: 100, recentKeepRounds: 1 }))

    expect(result.metrics.filtered).toBe(true)
    expect(result.messages[1].content).toContain(code)
    expect(result.messages[1].content?.match(new RegExp(duplicate, 'g'))).toHaveLength(1)
    expect(result.messages[2].content).toBe(traceback)
    expect(result.messages.slice(-2)).toEqual(messages.slice(-2))
  })

  it('honors independently disabled single-layer compression features', () => {
    const repeated = 'please keep this repeated paragraph unchanged.'
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: `${repeated}\n\n${repeated}` },
      { role: 'assistant', content: repeated },
      { role: 'user', content: 'Latest request' },
    ]

    const result = manageContext(messages, [], model({ modelMaxContext: 100 }), context({ safeOutputMargin: 10, recentKeepRounds: 1, filterEnabled: false, rewriteEnabled: false, truncateEnabled: false }))

    expect(result.messages).toBe(messages)
    expect(result.metrics).toEqual(expect.objectContaining({ filtered: false, rewritten: false, truncated: false }))
  })

  it('never rewrites tool calls or tool results in single-layer mode', () => {
    const toolCall = { id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"folder_id":"root","path":"src/a.ts"}' } }
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'please inspect the file\n\nplease inspect the file' },
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'tool', content: 'const exact = true', tool_call_id: 'call-1' },
      { role: 'user', content: 'Latest request' },
    ]

    const threshold = compressionThreshold(messages)
    const result = manageContext(messages, [], model({ modelMaxContext: threshold + 100 }), context({ safeOutputMargin: 100, recentKeepRounds: 1 }))

    expect(result.messages.find((message) => message.tool_calls)?.tool_calls).toEqual([toolCall])
    expect(result.messages.find((message) => message.tool_call_id === 'call-1')?.content).toBe('const exact = true')
  })

  it('truncates complete old rounds only as the single-layer fallback', () => {
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'Old request '.repeat(80) },
      { role: 'assistant', content: 'Old response '.repeat(80) },
      { role: 'user', content: 'Latest request' },
      { role: 'assistant', content: 'Latest response' },
    ]

    const result = manageContext(messages, [], model({ modelMaxContext: 100 }), context({ safeOutputMargin: 10, recentKeepRounds: 1, filterEnabled: false, rewriteEnabled: false }))

    expect(result.metrics.truncated).toBe(true)
    expect(result.messages[0]).toEqual(messages[0])
    expect(result.messages).not.toContainEqual(messages[1])
    expect(result.messages).not.toContainEqual(messages[2])
    expect(result.messages.slice(-2)).toEqual(messages.slice(-2))
  })

  it('sends only Hot messages and keeps demoted Warm messages byte-for-byte original', () => {
    const oldContent = 'please inspect this exact text\n\nplease inspect this exact text'
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'old-user', role: 'user', content: oldContent },
      { id: 'old-assistant', role: 'assistant', content: 'Old reply' },
      { id: 'latest-user', role: 'user', content: 'Latest request' },
      { id: 'latest-assistant', role: 'assistant', content: 'Latest response' },
    ]

    const result = manageContext(messages, [], model({ modelMaxContext: 10_000 }), context({ layeredEnabled: true, recentKeepRounds: 1, hotTokenBudget: hotBudget([messages[0], ...messages.slice(-2)]), warmTokenBudget: 10_000 }))

    expect(result.messages.map((message) => message.id)).toEqual(['system', 'latest-user', 'latest-assistant'])
    expect(result.warmMessages.map((message) => message.id)).toEqual(['old-user', 'old-assistant'])
    expect(result.warmMessages[0]).toEqual(expect.objectContaining({ content: oldContent, representation: 'original', contextLayer: 'warm' }))
    expect(result.metrics).toEqual(expect.objectContaining({ layered: true, filtered: false, rewritten: false, truncated: false }))
  })

  it('creates explicitly labeled non-authoritative Cold summaries only when Warm overflows', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'old-user', createdAt: '2026-01-01T00:00:00.000Z', role: 'user', content: 'please keep this paragraph\n\nplease keep this paragraph' },
      { id: 'old-assistant', createdAt: '2026-01-01T00:00:01.000Z', role: 'assistant', content: 'Old reply' },
      { id: 'latest-user', role: 'user', content: 'Latest request' },
    ]

    const result = manageContext(messages, [], model({ modelMaxContext: 10_000 }), context({ layeredEnabled: true, recentKeepRounds: 1, hotTokenBudget: hotBudget([messages[0], messages.at(-1)!]), warmTokenBudget: 0 }))

    expect(result.warmMessages).toEqual([])
    expect(result.summaryArtifacts).toHaveLength(2)
    for (const summary of result.summaryArtifacts) {
      expect(summary.content).toContain(SUMMARY_LABEL)
      expect(summary.content).toContain('not an authoritative source')
      expect(summary.sourceMessageIds).toHaveLength(1)
      expect(summary.sourcePointers[0]).toContain('messages.jsonl#id=')
    }
    expect(messages[1].content).toBe('please keep this paragraph\n\nplease keep this paragraph')
    expect(result.metrics.truncated).toBe(false)
  })

  it('admits recalled messages only while the Hot request remains within budget', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'recent-user', role: 'user', content: 'Latest request' },
      { id: 'recalled-small', role: 'assistant', content: 'Relevant prior detail', contextSource: 'cold-truth-recall' },
      { id: 'recalled-large', role: 'assistant', content: 'large '.repeat(2_000), contextSource: 'cold-truth-recall' },
    ]
    const baseTokens = countContextTokens({ messages: messages.slice(0, 2), tools: [] })

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: 100_000 }),
      context({ layeredEnabled: true, safeOutputMargin: 1_000, recentKeepRounds: 1, hotTokenBudget: 1_000 }),
    )

    expect(result.messages.some((message) => message.id === 'recalled-small')).toBe(true)
    expect(result.messages.some((message) => message.id === 'recalled-large')).toBe(false)
    expect(result.metrics.compressedTokens).toBeLessThan(result.metrics.triggerThreshold)
  })
  it('keeps the current user message in Hot even when older rounds are demoted', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'old-user', role: 'user', content: 'Old request '.repeat(400) },
      { id: 'old-assistant', role: 'assistant', content: 'Old reply '.repeat(400) },
      { id: 'current-user', role: 'user', content: 'Current request' },
    ]

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: 10_000 }),
      context({
        layeredEnabled: true,
        recentKeepRounds: 1,
        hotTokenBudget: hotBudget([messages[0], messages.at(-1)!]),
        warmTokenBudget: 10_000,
      }),
    )

    expect(result.messages.find((message) => message.id === 'current-user')).toEqual(expect.objectContaining({
      role: 'user',
      contextLayer: 'hot',
      contextRegion: 'newborn',
      contextSource: 'live',
    }))
    expect(result.warmMessages.some((message) => message.id === 'current-user')).toBe(false)
  })

  it('keeps recalled summaries in Hot while preserving their lossy label and truth references', () => {
    const summary = `${SUMMARY_LABEL}\nThis content is compressed and may omit details. It is not an authoritative source.\nTruth references: truth-1\n\nPrior decision summary.`
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'summary-1', role: 'assistant', content: summary, representation: 'summary', truthRefs: ['truth-1'], contextLayer: 'hot', contextSource: 'cold-summary-recall' },
      { id: 'latest-user', role: 'user', content: 'Use the prior decision.' },
    ]

    const result = manageContext(messages, [], model({ modelMaxContext: 100_000 }), context({ layeredEnabled: true, safeOutputMargin: 1_000, recentKeepRounds: 1, hotTokenBudget: 10_000 }))
    const recalled = result.messages.find((message) => message.id === 'summary-1')

    expect(recalled).toEqual(expect.objectContaining({ content: summary, representation: 'summary', truthRefs: ['truth-1'], contextLayer: 'hot' }))
    expect(result.metrics.recalled).toBe(true)
  })

  it('keeps pinned and clear long-term preferences in Hot during demotion', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'preference', role: 'user', content: 'I prefer pnpm for package management.' },
      { id: 'pinned', role: 'assistant', content: 'Pinned decision', pinnedToHot: true },
      { id: 'old', role: 'assistant', content: 'Ordinary old reply' },
      { id: 'latest-user', role: 'user', content: 'Latest request' },
    ]

    const result = manageContext(messages, [], model({ modelMaxContext: 10_000 }), context({ layeredEnabled: true, recentKeepRounds: 1, hotTokenBudget: hotBudget([messages[0], messages[1], messages[2], messages.at(-1)!]), warmTokenBudget: 10_000 }))

    expect(result.messages.find((message) => message.id === 'preference')).toEqual(expect.objectContaining({ contextRegion: 'long-term', contextLayer: 'hot' }))
    expect(result.messages.find((message) => message.id === 'pinned')).toEqual(expect.objectContaining({ pinnedToHot: true, contextLayer: 'hot' }))
    expect(result.warmMessages.find((message) => message.id === 'old')).toBeDefined()
  })

  it('keeps tool calls and results exact when they move to Warm', () => {
    const toolCall = { id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"file_path":"src/a.ts"}' } }
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'old-user', role: 'user', content: 'Inspect the file.' },
      { id: 'tool-call', role: 'assistant', content: null, tool_calls: [toolCall] },
      { id: 'tool-result', role: 'tool', content: 'const exact = true', tool_call_id: 'call-1' },
      { id: 'latest-user', role: 'user', content: 'Latest request' },
    ]

    const result = manageContext(messages, [], model({ modelMaxContext: 10_000 }), context({ layeredEnabled: true, recentKeepRounds: 1, hotTokenBudget: hotBudget([messages[0], messages.at(-1)!]), warmTokenBudget: 10_000 }))

    expect(result.warmMessages.find((message) => message.id === 'tool-call')?.tool_calls).toEqual([toolCall])
    expect(result.warmMessages.find((message) => message.id === 'tool-result')?.content).toBe('const exact = true')
  })

  it('does not mutate canonical input messages', () => {
    const messages: ContextMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'please repeat\n\nplease repeat' },
      { role: 'assistant', content: 'old reply' },
      { role: 'user', content: 'latest' },
    ]
    const original = structuredClone(messages)

    manageContext(messages, [], model({ modelMaxContext: 100 }), context({ safeOutputMargin: 10, recentKeepRounds: 1 }))

    expect(messages).toEqual(original)
  })
})
