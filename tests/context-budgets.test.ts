import { describe, expect, it } from 'vitest'
import { deriveContextBudgets } from '../src/shared/types'

describe('deriveContextBudgets', () => {
  it('matches the glm-5.2 example from the spec', () => {
    expect(deriveContextBudgets(1_000_000, 128_000)).toEqual({
      safeOutputMargin: 128_000,
      hotTokenBudget: 828_400,
      warmTokenBudget: 8_284_000,
      coldRecallTokenBudget: 82_840,
    })
  })

  it('uses the max-output branch when the input budget dominates', () => {
    const result = deriveContextBudgets(128_000, 16_384)
    expect(result.safeOutputMargin).toBe(16_384)
    expect(result.hotTokenBudget).toBe(Math.floor((128_000 - 16_384) * 0.95))
    expect(result.warmTokenBudget).toBe(Math.floor(result.hotTokenBudget * 10))
    expect(result.coldRecallTokenBudget).toBe(Math.floor(result.hotTokenBudget * 0.1))
  })

  it('falls back to half the context window when max output is unknown', () => {
    const result = deriveContextBudgets(1_000_000)
    expect(result.safeOutputMargin).toBe(500_000)
    expect(result.hotTokenBudget).toBe(618_000)
    expect(result.warmTokenBudget).toBe(6_180_000)
    expect(result.coldRecallTokenBudget).toBe(61_800)
  })

  it('uses the 0.618 floor when the output budget leaves little input room', () => {
    const result = deriveContextBudgets(1_000_000, 900_000)
    expect(result.safeOutputMargin).toBe(900_000)
    expect(result.hotTokenBudget).toBe(618_000)
    expect(result.warmTokenBudget).toBe(6_180_000)
    expect(result.coldRecallTokenBudget).toBe(61_800)
  })

  it('floors fractional results and keeps budgets positive for tiny windows', () => {
    const result = deriveContextBudgets(1_001, 500)
    expect(result.hotTokenBudget).toBe(618)
    expect(result.warmTokenBudget).toBe(6_180)
    expect(result.coldRecallTokenBudget).toBe(61)
    const tiny = deriveContextBudgets(1, 1)
    expect(tiny.safeOutputMargin).toBe(1)
    expect(tiny.hotTokenBudget).toBeGreaterThanOrEqual(1)
    expect(tiny.warmTokenBudget).toBeGreaterThanOrEqual(1)
  })

  it('ignores invalid max output values', () => {
    expect(deriveContextBudgets(1_000_000, 0)).toEqual(deriveContextBudgets(1_000_000))
    expect(deriveContextBudgets(1_000_000, -5)).toEqual(deriveContextBudgets(1_000_000))
  })
})
