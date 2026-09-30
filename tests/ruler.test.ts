import { describe, expect, it, vi } from 'vitest'
import { generateRulerCases, runRulerEvaluation, scoreRulerAnswer } from '../src/main/ruler'
import {
  generateOfficialRulerCases,
  runOfficialRulerEvaluation,
  scoreOfficialRulerAnswer,
  type OfficialRulerTaskName,
} from '../src/main/ruler-official'
import { defaultModelConfig } from '../src/shared/types'

describe('RULER adapter', () => {
  it('generates the supported task subset with a latest query message', () => {
    const cases = generateRulerCases({
      tasks: ['niah_single', 'niah_multi', 'variable_tracking'],
      samplesPerTask: 1,
      fillerItems: 2,
    })

    expect(cases.map((item) => item.task)).toEqual([
      'niah_single',
      'niah_multi',
      'variable_tracking',
    ])
    for (const item of cases) {
      expect(item.messages.at(-1)?.id).toBe(item.latestUserMessageId)
      expect(item.messages.at(-1)?.role).toBe('user')
      expect(item.expectedAnswers.length).toBeGreaterThan(0)
    }
  })

  it('scores single and ordered multi-answer responses', () => {
    expect(scoreRulerAnswer('RULER-SINGLE-1', ['RULER-SINGLE-1'])).toBe(true)
    expect(
      scoreRulerAnswer('RULER-ALPHA-1, RULER-BRAVO-1, RULER-CHARLIE-1', [
        'RULER-ALPHA-1',
        'RULER-BRAVO-1',
        'RULER-CHARLIE-1',
      ]),
    ).toBe(true)
    expect(
      scoreRulerAnswer('RULER-BRAVO-1, RULER-ALPHA-1, RULER-CHARLIE-1', [
        'RULER-ALPHA-1',
        'RULER-BRAVO-1',
        'RULER-CHARLIE-1',
      ]),
    ).toBe(false)
  })

  it('evaluates a case through an OpenAI-compatible remote endpoint', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://example.test/v1/chat/completions')
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'RULER-SINGLE-1' } }] }),
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const result = await runRulerEvaluation({
        modelConfig: { ...defaultModelConfig, modelMaxContext: 10_000 },
        remote: {
          baseUrl: 'https://example.test/v1',
          apiKey: 'test-key',
          modelName: 'test-model',
        },
        tasks: ['niah_single'],
        samplesPerTask: 1,
        fillerItems: 1,
      })

      expect(fetchMock).toHaveBeenCalledOnce()
      expect(result.summary.builtin).toEqual(
        expect.objectContaining({ cases: 1, correct: 1, accuracy: 1 }),
      )
      expect(result.results[0]).toEqual(
        expect.objectContaining({ strategy: 'builtin', correct: true, strategyApplied: true }),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('Official RULER adapter', () => {
  it('generates deterministic official-style cases within the target token budget', () => {
    const options = {
      tasks: ['niah_single', 'niah_multivalue', 'variable_tracking'] as OfficialRulerTaskName[],
      samplesPerTask: 1,
      maxLen: 768,
      tokensToGenerate: 64,
      seed: 42,
      tokenizer: 'cl100k_base' as const,
    }
    const first = generateOfficialRulerCases(options)
    const second = generateOfficialRulerCases(options)

    expect(first.map((item) => item.inputText)).toEqual(second.map((item) => item.inputText))
    expect(first.map((item) => item.task)).toEqual([
      'niah_single',
      'niah_multivalue',
      'variable_tracking',
    ])
    expect(first.every((item) => (item.targetTokens ?? 0) === 768)).toBe(true)
    expect(first[1].expectedAnswers).toHaveLength(4)
  })

  it('uses official-style all-answer matching for the supported subset', () => {
    expect(scoreOfficialRulerAnswer('Answer: 123 and 456', ['123', '456'])).toBe(true)
    expect(scoreOfficialRulerAnswer('Answer: 456', ['123', '456'])).toBe(false)
  })

  it('evaluates official-style cases through the remote endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '1234567' } }] }),
    }) as Response)
    vi.stubGlobal('fetch', fetchMock)

    try {
      const result = await runOfficialRulerEvaluation({
        modelConfig: { ...defaultModelConfig, modelMaxContext: 10_000 },
        remote: {
          baseUrl: 'https://example.test/v1',
          apiKey: 'test-key',
          modelName: 'test-model',
        },
        tasks: ['niah_single'],
        samplesPerTask: 1,
        maxLen: 512,
        tokensToGenerate: 32,
        seed: 42,
        tokenizer: 'cl100k_base',
        contextConfig: { layeredEnabled: false, hotTokenBudget: 10_000 },
      })

      expect(fetchMock).toHaveBeenCalledOnce()
      expect(result.benchmark).toBe('ruler-official-subset')
      expect(result.mode).toBe('official')
      expect(result.tokenizer).toBe('cl100k_base')
      expect(result.results).toHaveLength(1)
      expect(result.results[0].correct).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
