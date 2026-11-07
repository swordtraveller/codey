import { describe, expect, it } from 'vitest'
import { defaultAppConfig, defaultModelDefinition, type AppConfig } from '../../shared/types'
import { getSettingsChanges, settingsEqual } from './settings-changes'

function fixture(): AppConfig {
  return {
    ...structuredClone(defaultAppConfig),
    providers: [{ id: 'p', name: 'Provider', baseUrl: 'https://example.invalid', apiKey: 'secret' }],
    modelDefinitions: [{ ...defaultModelDefinition, id: 'd', modelName: 'Model' }],
    models: [{ id: 'm', name: 'Concrete', providerId: 'p', definitionId: 'd' }],
    modelGroups: [{ id: 'g', name: 'Group', modelIds: ['m'], retriesPerModel: 2 }],
  }
}

describe('settings change summaries', () => {
  it('compares values, not references or object key insertion order', () => {
    const saved = fixture()
    expect(getSettingsChanges(saved, structuredClone(saved))).toEqual([])
    expect(settingsEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(settingsEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(settingsEqual([], {})).toBe(false)
    expect(settingsEqual(null, {})).toBe(false)
  })
  it('lists added, renamed and removed entities without leaking credentials', () => {
    const saved = fixture()
    const draft = structuredClone(saved)
    draft.providers[0]!.apiKey = 'new-secret'
    draft.models.push({ id: 'new', name: 'New', providerId: 'p', definitionId: 'd' })
    draft.modelDefinitions = []
    draft.modelGroups[0]!.name = 'Renamed'
    const changes = getSettingsChanges(saved, draft)
    expect(changes).toEqual([
      { section: 'providersSection', kind: 'modified', name: 'Provider' },
      { section: 'definitionsSection', kind: 'removed', name: 'Model' },
      { section: 'modelsSection', kind: 'added', name: 'New' },
      { section: 'groupsSection', kind: 'modified', name: 'Renamed' },
    ])
    expect(JSON.stringify(changes)).not.toContain('secret')
    expect(JSON.stringify(changes)).not.toContain('https:')
  })
  it('detects failover order and retry changes and clears a reverted edit', () => {
    const saved = fixture()
    saved.modelGroups[0]!.modelIds = ['m', 'other']
    const draft = structuredClone(saved)
    draft.modelGroups[0]!.modelIds.reverse()
    expect(getSettingsChanges(saved, draft)).toHaveLength(1)
    draft.modelGroups[0]!.modelIds.reverse()
    expect(getSettingsChanges(saved, draft)).toEqual([])
    draft.modelGroups[0]!.retriesPerModel++
    expect(getSettingsChanges(saved, draft)).toHaveLength(1)
  })
  it('reports other settings tabs and deduplicates category summaries', () => {
    const saved = fixture()
    const draft = structuredClone(saved)
    draft.keepAwakeEnabled = !saved.keepAwakeEnabled
    draft.keepAwakeOnlyWhileWorking = !saved.keepAwakeOnlyWhileWorking
    draft.language = 'en'
    draft.commandReviewGlobal.reviewers.manualConfirmation = !draft.commandReviewGlobal.reviewers.manualConfirmation
    const sections = getSettingsChanges(saved, draft).map(change => change.section)
    expect(sections.filter(section => section === 'powerSettings')).toHaveLength(1)
    expect(sections).toContain('language')
    expect(sections).toContain('settingsChangeReview')
  })
})
