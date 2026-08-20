import { describe, expect, it } from 'vitest'
import {
  isValidAgentLimitsConfig,
  normalizeAgentLimitsConfig,
} from '../src/main/agent-limits'
import { defaultAgentLimitsConfig } from '../src/shared/types'

describe('Agent limits', () => {
  it('uses the existing hard-coded limits as migration defaults', () => {
    expect(normalizeAgentLimitsConfig()).toEqual(defaultAgentLimitsConfig)
  })

  it('normalizes integer values and rejects unsafe limits', () => {
    expect(normalizeAgentLimitsConfig({
      modelRequestsPerRound: 6.8,
      toolCallsPerRequest: 10.9,
    })).toEqual({
      modelRequestsPerRound: 6,
      toolCallsPerRequest: 10,
    })
    expect(isValidAgentLimitsConfig({
      modelRequestsPerRound: 1,
      toolCallsPerRequest: 100,
    })).toBe(true)
    expect(isValidAgentLimitsConfig({
      modelRequestsPerRound: 0,
      toolCallsPerRequest: 20,
    })).toBe(false)
    expect(isValidAgentLimitsConfig({
      modelRequestsPerRound: 12,
      toolCallsPerRequest: 101,
    })).toBe(false)
  })
})