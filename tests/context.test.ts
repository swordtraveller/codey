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

  it('derives the usable Hot budget and watermarks after reserving tool definitions', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'latest-user', role: 'user', content: 'Latest request' },
    ]
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a project file '.repeat(50) } }]
    const triggerThreshold = 10_000 - 1_000
    const expectedBudget = triggerThreshold - countContextTokens(tools)

    const result = manageContext(messages, tools, model({ modelMaxContext: 10_000 }), context({ layeredEnabled: true, safeOutputMargin: 1_000, hotTokenBudget: 10_000 }), { latestUserMessageId: 'latest-user' })

    expect(result.hotTokenBudget).toBe(expectedBudget)
    expect(result.hotHighWatermark).toBe(Math.floor(expectedBudget * 0.9))
    expect(result.hotLowWatermark).toBe(Math.floor(expectedBudget * 0.8))
  })

  it('demotes historical rounds from the high watermark down to the low watermark', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'old-user-1', role: 'user', content: 'Old request '.repeat(180) },
      { id: 'old-assistant-1', role: 'assistant', content: 'Old response '.repeat(180) },
      { id: 'old-user-2', role: 'user', content: 'Another request '.repeat(180) },
      { id: 'old-assistant-2', role: 'assistant', content: 'Another response '.repeat(180) },
      { id: 'latest-user', role: 'user', content: 'Latest request' },
    ]

    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: 100_000 }),
      context({ layeredEnabled: true, hotTokenBudget: 1_000, warmTokenBudget: 10_000, recentKeepRounds: 20 }),
      { latestUserMessageId: 'latest-user' },
    )

    expect(result.hotHighWatermark).toBe(900)
    expect(result.hotLowWatermark).toBe(800)
    expect(countContextTokens(result.messages)).toBeLessThanOrEqual(800)
    expect(result.warmMessages.length).toBeGreaterThan(0)
    expect(result.messages.some((message) => message.id === 'latest-user')).toBe(true)
  })

  it('uses enteredHotAt when ordering otherwise equivalent historical rounds', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'entered-later', createdAt: '2025-01-01T00:00:00.000Z', enteredHotAt: '2026-08-25T00:00:00.000Z', role: 'user', content: 'First '.repeat(220) },
      { id: 'entered-later-reply', enteredHotAt: '2026-08-25T00:00:00.000Z', role: 'assistant', content: 'Reply '.repeat(220) },
      { id: 'entered-earlier', createdAt: '2026-01-01T00:00:00.000Z', enteredHotAt: '2026-08-20T00:00:00.000Z', role: 'user', content: 'Second '.repeat(220) },
      { id: 'entered-earlier-reply', enteredHotAt: '2026-08-20T00:00:00.000Z', role: 'assistant', content: 'Reply '.repeat(220) },
      { id: 'latest-user', role: 'user', content: 'Latest request' },
    ]

    const result = manageContext(messages, [], model({ modelMaxContext: 100_000 }), context({ layeredEnabled: true, hotTokenBudget: 1_000, warmTokenBudget: 10_000 }), { latestUserMessageId: 'latest-user' })

    expect(result.warmMessages.some((message) => message.id === 'entered-earlier')).toBe(true)
    expect(result.messages.some((message) => message.id === 'entered-later')).toBe(true)
  })

  it('keeps a historical tool-call unit together when one item is pinned', () => {
    const toolCall = { id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'old-user', role: 'user', content: 'Old request '.repeat(400) },
      { id: 'tool-call', role: 'assistant', content: null, tool_calls: [toolCall], pinnedToHot: true },
      { id: 'tool-result', role: 'tool', tool_call_id: 'call-1', content: 'Exact result '.repeat(120) },
      { id: 'latest-user', role: 'user', content: 'Latest request' },
    ]
    const retained = [messages[0], messages[2], messages[3], messages[4]]

    const result = manageContext(messages, [], model({ modelMaxContext: 100_000 }), context({ layeredEnabled: true, hotTokenBudget: hotBudget(retained), warmTokenBudget: 20_000 }), { latestUserMessageId: 'latest-user' })

    expect(result.warmMessages.some((message) => message.id === 'old-user')).toBe(true)
    expect(result.warmMessages.some((message) => message.id === 'tool-call' || message.id === 'tool-result')).toBe(false)
    expect(result.messages.map((message) => message.id)).toEqual(expect.arrayContaining(['tool-call', 'tool-result']))
    expect(normalizeToolCallSequence(result.messages)).toEqual(result.messages)
  })

  it('only demotes complete closed tool-call units from the current round at the hard limit', () => {
    const firstCall = { id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }
    const secondCall = { id: 'call-2', type: 'function' as const, function: { name: 'write_file', arguments: '{}' } }
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'latest-user', role: 'user', content: 'Current request' },
      { id: 'call-1-message', role: 'assistant', content: null, tool_calls: [firstCall] },
      { id: 'call-1-result', role: 'tool', tool_call_id: 'call-1', content: 'First result '.repeat(400) },
      { id: 'call-2-message', role: 'assistant', content: null, tool_calls: [secondCall] },
      { id: 'call-2-result', role: 'tool', tool_call_id: 'call-2', content: 'Second result '.repeat(120) },
    ]
    const retained = [messages[0], messages[1], messages[4], messages[5]]
    const budget = countContextTokens(retained) + 300

    const result = manageContext(messages, [], model({ modelMaxContext: 100_000 }), context({ layeredEnabled: true, hotTokenBudget: budget, warmTokenBudget: 20_000 }), { latestUserMessageId: 'latest-user' })

    expect(result.overflow).toBeUndefined()
    expect(result.warmMessages.map((message) => message.id)).toEqual(expect.arrayContaining(['call-1-message', 'call-1-result']))
    expect(result.messages.map((message) => message.id)).toEqual(expect.arrayContaining(['call-2-message', 'call-2-result', 'latest-user']))
    expect(normalizeToolCallSequence(result.messages)).toEqual(result.messages)
  })

  it('demotes closed current-round units before an incomplete tool-call tail at the hard limit', () => {
    const firstCall = { id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }
    const openCall = { id: 'call-2', type: 'function' as const, function: { name: 'write_file', arguments: '{}' } }
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'latest-user', role: 'user', content: 'Current request' },
      { id: 'call-1-message', role: 'assistant', content: null, tool_calls: [firstCall] },
      { id: 'call-1-result', role: 'tool', tool_call_id: 'call-1', content: 'First result '.repeat(400) },
      { id: 'open-call', role: 'assistant', content: null, tool_calls: [openCall] },
    ]
    const retained = [messages[0], messages[1], messages[4]]

    const result = manageContext(messages, [], model({ modelMaxContext: 100_000 }), context({ layeredEnabled: true, hotTokenBudget: countContextTokens(retained) + 200, warmTokenBudget: 20_000 }), { latestUserMessageId: 'latest-user' })

    expect(result.overflow).toBeUndefined()
    expect(result.warmMessages.map((message) => message.id)).toEqual(expect.arrayContaining(['call-1-message', 'call-1-result']))
    expect(result.warmMessages.some((message) => message.id === 'open-call')).toBe(false)
  })

  it('does not demote the current round merely for crossing the high watermark', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'latest-user', role: 'user', content: 'Current request' },
      { id: 'current-assistant', role: 'assistant', content: 'In-progress response '.repeat(250) },
    ]
    const baseline = manageContext(messages, [], model({ modelMaxContext: 100_000 }), context({ layeredEnabled: true, hotTokenBudget: 100_000, warmTokenBudget: 10_000 }), { latestUserMessageId: 'latest-user' })
    const budget = Math.ceil(countContextTokens(baseline.messages) / 0.95)

    const result = manageContext(messages, [], model({ modelMaxContext: 100_000 }), context({ layeredEnabled: true, hotTokenBudget: budget, warmTokenBudget: 10_000 }), { latestUserMessageId: 'latest-user' })

    expect(countContextTokens(result.messages)).toBeGreaterThan(result.hotHighWatermark ?? 0)
    expect(result.warmMessages).toEqual([])
    expect(result.overflow).toBeUndefined()
  })
  it('reports a dedicated overflow when the latest user message cannot fit', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'latest-user', role: 'user', content: 'Oversized '.repeat(2_000) },
    ]

    const result = manageContext(messages, [], model({ modelMaxContext: 100_000 }), context({ layeredEnabled: true, hotTokenBudget: 1_000 }), { latestUserMessageId: 'latest-user' })

    expect(result.overflow?.reason).toBe('latest_user_too_large')
    expect(result.messages.some((message) => message.id === 'latest-user')).toBe(true)
  })
  it('applies a custom Rhai strategy to select existing messages', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'old', role: 'assistant', content: 'Old reply' },
      { id: 'latest', role: 'user', content: 'Latest request' },
    ]
    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: 10_000 }),
      context({ safeOutputMargin: 100, customStrategyEnabled: true,
        customStrategyScript: 'fn manage(content) { #{ messages: [content.messages[0], content.messages[2]] } }',
      }),
      { allowCustomStrategy: true, latestUserMessageId: 'latest' },
    )

    expect(result.messages.map((message) => message.id)).toEqual(['system', 'latest'])
    expect(result.warmMessages).toEqual([])
  })

  it('allows a custom Rhai strategy to remove system and latest user messages', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'middle', role: 'assistant', content: 'Selected message' },
      { id: 'latest', role: 'user', content: 'Latest request' },
    ]
    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: 10_000 }),
      context({ safeOutputMargin: 100, customStrategyEnabled: true,
        customStrategyScript: 'fn manage(content) { #{ messages: [content.messages[1]] } }',
      }),
      { allowCustomStrategy: true, latestUserMessageId: 'latest' },
    )

    expect(result.messages.map((message) => message.id)).toEqual(['middle'])
  })
  it('allows a custom Rhai strategy to remove a pinned message', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'pinned', role: 'assistant', content: 'Pinned', pinnedToHot: true },
      { id: 'latest', role: 'user', content: 'Latest request' },
    ]
    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: 10_000 }),
      context({ safeOutputMargin: 100, customStrategyEnabled: true,
        customStrategyScript: 'fn manage(content) { [content.messages[0], content.messages[2]] }',
      }),
      { allowCustomStrategy: true, latestUserMessageId: 'latest' },
    )

    expect(result.messages.map((message) => message.id)).toEqual(['system', 'latest'])
  })

  it('ignores a custom Rhai strategy unless the host explicitly allows it', () => {
    const messages: ContextMessage[] = [
      { id: 'system', role: 'system', content: 'System instruction' },
      { id: 'latest', role: 'user', content: 'Latest request' },
    ]
    const result = manageContext(
      messages,
      [],
      model({ modelMaxContext: 10_000 }),
      context({ safeOutputMargin: 100, customStrategyEnabled: true,
        customStrategyScript: 'fn manage(content) { [] }',
      }),
      { allowCustomStrategy: false, latestUserMessageId: 'latest' },
    )

    expect(result.messages).toBe(messages)
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
