import { describe, expect, it } from 'vitest'
import { applyDevelopmentProgressUpdate, createDevelopmentProgressState } from '../src/shared/development-progress'

describe('development progress updates', () => {
  it('keeps committed items stable while replacing streamed blocks', () => {
    const compression = {
      type: 'compression' as const,
      compression: { originalTokens: 100, compressedTokens: 80, compressionRatio: 1.25, method: 'filter' },
    }
    const withCompression = applyDevelopmentProgressUpdate(createDevelopmentProgressState(), {
      type: 'append',
      items: [compression],
    })
    const streaming = applyDevelopmentProgressUpdate(withCompression, {
      type: 'replace-stream',
      blocks: [{ type: 'content', content: 'partial' }],
    })
    const replaced = applyDevelopmentProgressUpdate(streaming, {
      type: 'replace-stream',
      blocks: [{ type: 'content', content: 'partial response' }],
    })

    expect(replaced.timeline).toBe(withCompression.timeline)
    expect(replaced.streamingBlocks).toEqual([{ type: 'content', content: 'partial response' }])
  })

  it('commits a streamed response and clears the transient blocks', () => {
    const streaming = applyDevelopmentProgressUpdate(createDevelopmentProgressState(), {
      type: 'replace-stream',
      blocks: [{ type: 'content', content: 'draft' }],
    })
    const committed = applyDevelopmentProgressUpdate(streaming, {
      type: 'commit-stream',
      items: [{ type: 'block', block: { type: 'content', content: 'final' } }],
    })

    expect(committed.timeline).toEqual([
      { type: 'block', block: { type: 'content', content: 'final' } },
    ])
    expect(committed.streamingBlocks).toEqual([])
  })

  it('updates only the matching committed tool call', () => {
    const first = { type: 'block' as const, block: { type: 'function_call' as const, id: 'one', name: 'read', parameters: '{}' } }
    const second = { type: 'block' as const, block: { type: 'function_call' as const, id: 'two', name: 'write', parameters: '{}' } }
    const initial = { timeline: [first, second], streamingBlocks: [] }
    const updated = applyDevelopmentProgressUpdate(initial, {
      type: 'update-tool-result',
      toolCallId: 'two',
      result: 'done',
      resultError: false,
    })

    expect(updated.timeline[0]).toBe(first)
    expect(updated.timeline[1]).toEqual({
      type: 'block',
      block: { ...second.block, result: 'done', resultError: false },
    })
  })
})
