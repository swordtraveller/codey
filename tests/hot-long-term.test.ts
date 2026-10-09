import { describe, expect, it, vi } from 'vitest'
import { defaultContextManagementConfig } from '../src/shared/types'
import { countContextMessageTokens } from '../src/main/context-utils'
import {
  HOT_LONG_TERM_TOOL,
  createHotLongTermMessage,
  createHotLongTermProvider,
  createHotLongTermTools,
  hotLongTermTokens,
  withHotLongTerm,
} from '../src/main/hot-long-term'
import type { ToolCall } from '../src/main/tools'

const config = { ...defaultContextManagementConfig, layeredEnabled: true }
const call = (args: unknown, name = HOT_LONG_TERM_TOOL): ToolCall => ({
  id: 'update-1', type: 'function', function: { name, arguments: JSON.stringify(args) },
})

describe('Long-term prompt tool', () => {
  it('advertises a single replacement string only under layered management', () => {
    expect(createHotLongTermTools(defaultContextManagementConfig)).toEqual([])
    expect(createHotLongTermTools({ ...config, customStrategyEnabled: true, customStrategyScript: 'custom' })).toEqual([])
    expect(createHotLongTermTools({ ...config, customStrategyEnabled: true, customStrategyScript: '  ' })).toHaveLength(1)
    expect(createHotLongTermTools(config)).toEqual([expect.objectContaining({ function: expect.objectContaining({
      name: HOT_LONG_TERM_TOOL,
      description: expect.stringContaining('Submit only its replacement body, without the application-added label.'),
      parameters: {
        type: 'object', properties: { content: expect.objectContaining({
          type: 'string', description: expect.stringContaining('without the [Long-term context] label'),
        }) },
        required: ['content'], additionalProperties: false,
      },
    }) })])
  })

  it('rejects forged calls when disabled and ignores unrelated tools', async () => {
    const persist = vi.fn()
    const provider = createHotLongTermProvider(defaultContextManagementConfig, 'original', persist)
    expect(JSON.parse((await provider.execute(call({ content: 'new' })))!)).toMatchObject({ ok: false })
    expect(await provider.execute(call({}, 'another_tool'))).toBeUndefined()
    expect(provider.getContent()).toBe('original')
    expect(persist).not.toHaveBeenCalled()
  })

  it.each([null, [], {}, { content: 3 }, { content: 'new', append: true }])('rejects invalid arguments %j', async (args) => {
    const persist = vi.fn()
    const provider = createHotLongTermProvider(config, 'original', persist)
    expect(JSON.parse((await provider.execute(call(args)))!)).toMatchObject({ ok: false })
    expect(provider.getContent()).toBe('original')
    expect(persist).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON without mutation', async () => {
    const provider = createHotLongTermProvider(config, 'original', vi.fn())
    const malformed = call({})
    malformed.function.arguments = '{'
    expect(JSON.parse((await provider.execute(malformed))!)).toMatchObject({ ok: false })
    expect(provider.getContent()).toBe('original')
  })

  it('counts the entire derived message and accepts an exact token boundary', async () => {
    const content = 'Use pnpm for this project.'
    const tokens = countContextMessageTokens(createHotLongTermMessage(content)!)
    expect(hotLongTermTokens(content)).toBe(tokens)
    expect(tokens).toBeGreaterThan(1)
    const persist = vi.fn(async () => {})
    const provider = createHotLongTermProvider({ ...config, hotLongTermTokenBudget: tokens }, '', persist)
    expect(JSON.parse((await provider.execute(call({ content })))!)).toEqual({ ok: true, changed: true, tokens, tokenBudget: tokens })
    expect(persist).toHaveBeenCalledWith(content)
    expect(provider.getContent()).toBe(content)
  })

  it('rejects overflow without changing or persisting content', async () => {
    const persist = vi.fn()
    const provider = createHotLongTermProvider(config, 'original', persist)
    const content = 'apple '.repeat(2_000)
    expect(JSON.parse((await provider.execute(call({ content })))!)).toMatchObject({
      ok: false, tokens: hotLongTermTokens('original'), tokenBudget: 1_000, attemptedTokens: hotLongTermTokens(content),
    })
    expect(persist).not.toHaveBeenCalled()
    expect(provider.getContent()).toBe('original')
  })

  it('waits for successful persistence before replacing the visible prompt', async () => {
    let complete!: () => void
    const persistence = new Promise<void>((resolve) => { complete = resolve })
    const persist = vi.fn(() => persistence)
    const provider = createHotLongTermProvider(config, 'original', persist)
    const updating = provider.execute(call({ content: 'new' }))
    expect(persist).toHaveBeenCalledWith('new')
    expect(provider.getContent()).toBe('original')
    complete()
    expect(JSON.parse((await updating)!)).toMatchObject({ ok: true, changed: true })
    expect(provider.getContent()).toBe('new')
  })

  it('preserves the old prompt if persistence fails or is unavailable', async () => {
    for (const persist of [undefined, vi.fn(async () => { throw new Error('disk full') })]) {
      const provider = createHotLongTermProvider(config, 'original', persist)
      expect(JSON.parse((await provider.execute(call({ content: 'new' })))!)).toMatchObject({ ok: false })
      expect(provider.getContent()).toBe('original')
    }
  })

  it('treats identical content as a no-op and an empty string as a persisted clear', async () => {
    const persist = vi.fn(async () => {})
    const provider = createHotLongTermProvider(config, 'original', persist)
    expect(JSON.parse((await provider.execute(call({ content: 'original' })))!)).toMatchObject({ ok: true, changed: false })
    expect(persist).not.toHaveBeenCalled()
    expect(JSON.parse((await provider.execute(call({ content: '' })))!)).toEqual({ ok: true, changed: true, tokens: 0, tokenBudget: 1_000 })
    expect(persist).toHaveBeenCalledExactlyOnceWith('')
    expect(provider.getContent()).toBe('')
    expect(JSON.parse((await provider.execute(call({ content: '' })))!)).toMatchObject({ ok: true, changed: false, tokens: 0 })
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('does not erase over-budget existing content when the configured limit shrinks', async () => {
    const provider = createHotLongTermProvider({ ...config, hotLongTermTokenBudget: hotLongTermTokens('short') }, 'old '.repeat(200), vi.fn(async () => {}))
    expect(provider.getContent()).toBe('old '.repeat(200))
    expect(JSON.parse((await provider.execute(call({ content: 'short' })))!)).toMatchObject({ ok: true, changed: true })
  })

  it('does not persist a cancelled update', async () => {
    const persist = vi.fn()
    const provider = createHotLongTermProvider(config, 'original', persist)
    expect(JSON.parse((await provider.execute(call({ content: 'new' }), AbortSignal.abort()))!)).toMatchObject({ ok: false })
    expect(persist).not.toHaveBeenCalled()
    expect(provider.getContent()).toBe('original')
  })

  it('injects usage and a single protected prompt only when layered management is active', () => {
    const system = { role: 'system' as const, content: 'System rules' }
    const content = 'Use pnpm.'
    const messages = withHotLongTerm(system, content, config)
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toContain(`${hotLongTermTokens(content)}/1000 tokens`)
    expect(messages[1]).toMatchObject({ role: 'system', contextLayer: 'hot', contextRegion: 'long-term', pinnedToHot: true, content: `[Long-term context]\n${content}` })
    expect(withHotLongTerm(system, '', config)).toHaveLength(1)
    expect(withHotLongTerm(system, content, defaultContextManagementConfig)).toEqual([system])
    expect(system.content).toBe('System rules')
  })
})
