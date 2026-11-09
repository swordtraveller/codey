import { describe, expect, it } from 'vitest'
import { deleteModelEntities, extendModelReplacements, invalidModelReferences, modelReferenceKey, modelDeletionImpact, reconcileModelReferences } from '../src/shared/model-deletion'
import { auditReview, modelDeletionConfig, modelDeletionProject } from './model-deletion-fixtures'

const context = (maxInputTokens: number) => ({ ...modelDeletionConfig().contextManagement, maxInputTokens })

describe('model deletion dependencies', () => {
  it('cascades providers without deleting shared definitions and keeps remaining failover order', () => {
    const before = modelDeletionConfig()
    const after = deleteModelEntities(before, { kind: 'provider', id: 'a' })
    expect(after.providers.map(item => item.id)).toEqual(['b'])
    expect(after.modelDefinitions).toEqual(before.modelDefinitions)
    expect(after.models.map(item => item.id)).toEqual(['b-large', 'b-small'])
    expect(after.modelGroups.map(item => [item.id, item.modelIds])).toEqual([['mixed', ['b-large', 'b-small']]])
    expect(before.modelGroups[0].modelIds).toEqual(['b-large', 'a-large', 'b-small'])
  })

  it('cascades shared definitions across providers without deleting providers', () => {
    const before = modelDeletionConfig()
    const after = deleteModelEntities(before, { kind: 'definition', id: 'large' })
    expect(after.models.map(item => item.id)).toEqual(['b-small'])
    expect(after.providers).toEqual(before.providers)
    expect(after.modelDefinitions.map(item => item.id)).toEqual(['small'])
  })

  it('deletes a group without deleting its members', () => {
    const before = modelDeletionConfig()
    const after = deleteModelEntities(before, { kind: 'group', id: 'single' })
    expect(after.models).toEqual(before.models)
    expect(after.modelGroups.map(item => item.id)).toEqual(['mixed'])
  })

  it('includes archived selections, empty groups and all audit levels in the confirmation impact', () => {
    const before = modelDeletionConfig()
    before.commandReviewGlobal = auditReview('a-large')
    const project = modelDeletionProject()
    const impact = modelDeletionImpact(before, deleteModelEntities(before, { kind: 'provider', id: 'a' }), [project])
    expect(impact.removedIds).toEqual(['a-large', 'single'])
    expect(impact.changedGroups.map(item => item.id)).toEqual(['mixed'])
    expect(impact.globalDefault && impact.globalAudit).toBe(true)
    expect(impact.projects).toEqual([project])
    expect(impact.projectAudits).toEqual([project])
    expect(impact.conversations.map(item => item.conversation.id)).toEqual(['conversation'])
    expect(impact.conversationAudits).toHaveLength(1)
  })

  it('requires explicit valid replacements for defaults and each enabled audit; never silently disables review', () => {
    const before = modelDeletionConfig()
    const project = modelDeletionProject()
    const after = deleteModelEntities(before, { kind: 'provider', id: 'a' })
    expect(() => reconcileModelReferences(after, [project])).toThrow('MODEL_REPLACEMENT_REQUIRED')
    after.activeModelConfigId = 'b-small'
    expect(() => reconcileModelReferences(after, [project], { single: 'b-small' })).toThrow('MODEL_REPLACEMENT_REQUIRED')
    after.commandReviewGlobal = auditReview('a-large')
    expect(() => reconcileModelReferences(after, [], { 'a-large': 'missing' })).toThrow('MODEL_REPLACEMENT_REQUIRED')
    after.commandReviewGlobal = auditReview('', true)
    expect(reconcileModelReferences(after, []).config.commandReviewGlobal.reviewers).toMatchObject({ auditModel: true, auditModelConfigId: null })
  })

  it('restores inheritance, repairs audits and runtime metadata while retaining historical messages', () => {
    const before = modelDeletionConfig()
    before.commandReviewGlobal = auditReview('a-large')
    const project = modelDeletionProject()
    const original = structuredClone(project)
    const after = deleteModelEntities(before, { kind: 'provider', id: 'a' })
    const result = reconcileModelReferences(after, [project], { 'a-large': 'b-small', single: 'mixed' }, true, before)
    expect(result.config.activeModelConfigId).toBe('b-small')
    expect(result.config.commandReviewGlobal.reviewers).toMatchObject({ auditModel: true, auditModelConfigId: 'b-small' })
    const next = result.projects[0]
    expect(next.defaultModelConfigId).toBeNull()
    expect(next.commandExecutionDefault?.review?.reviewers.auditModelConfigId).toBe('mixed')
    const conversation = next.conversations[0]
    expect(conversation.modelConfigId).toBeNull()
    expect(conversation.commandExecution?.review?.reviewers.auditModelConfigId).toBe('b-small')
    expect(conversation.lastUsedModelId).toBeUndefined()
    expect(Object.keys(conversation.perModelContextConfigs!)).toEqual(['b-small'])
    expect(conversation.messages).toBe(project.conversations[0].messages)
    expect(conversation.agentMessages).toBe(project.conversations[0].agentMessages)
    expect(project).toEqual(original)
  })

  it('clears disabled dangling audit selections and leaves valid selections untouched', () => {
    const before = modelDeletionConfig()
    const after = deleteModelEntities(before, { kind: 'provider', id: 'a' })
    after.activeModelConfigId = 'b-small'
    after.commandReviewGlobal = auditReview('a-large', false)
    const project = modelDeletionProject()
    project.defaultModelConfigId = 'b-small'
    project.commandExecutionDefault = null
    project.conversations = []
    const result = reconcileModelReferences(after, [project])
    expect(result.config.commandReviewGlobal.reviewers).toMatchObject({ auditModel: false, auditModelConfigId: null })
    expect(result.projects[0].defaultModelConfigId).toBe('b-small')
  })

  it('composes repeated deletions so audits still resolve after deleting an earlier replacement', () => {
    const first = extendModelReplacements({}, ['a-large', 'single'], 'b-large')
    const final = extendModelReplacements(first, ['b-large'], 'b-small')
    expect(final).toEqual({ 'a-large': 'b-small', single: 'b-small', 'b-large': 'b-small' })
    const before = modelDeletionConfig()
    before.commandReviewGlobal = auditReview('single')
    const after = deleteModelEntities(deleteModelEntities(before, { kind: 'provider', id: 'a' }), { kind: 'model', id: 'b-large' })
    expect(reconcileModelReferences(after, [modelDeletionProject()], final).config.commandReviewGlobal.reviewers.auditModelConfigId).toBe('b-small')
  })

  it('repairs only incompatible explicit context windows after inheritance changes', () => {
    const before = modelDeletionConfig()
    before.contextManagement = context(100000)
    const project = modelDeletionProject()
    project.contextConfigOverride = context(80000)
    project.conversations[0].contextConfigOverride = context(16000)
    const after = deleteModelEntities(before, { kind: 'provider', id: 'a' })
    const result = reconcileModelReferences(after, [project], { 'a-large': 'b-small', single: 'b-small' }, true, before)
    expect(result.config.contextManagement.maxInputTokens).toBe(0)
    expect(result.projects[0].contextConfigOverride?.maxInputTokens).toBe(0)
    expect(result.projects[0].conversations[0].contextConfigOverride?.maxInputTokens).toBe(16000)
  })
  it('lists archived references individually and supports scoped choices overriding bulk replacements', () => {
    const before = modelDeletionConfig()
    before.commandReviewGlobal = auditReview('a-large')
    const project = modelDeletionProject()
    const after = deleteModelEntities(before, { kind: 'provider', id: 'a' })
    const refs = invalidModelReferences(after, [project])
    expect(refs).toHaveLength(6)
    expect(refs.filter(ref => ref.projectName === project.name)).toHaveLength(4)
    const choices: Record<string, string | null> = Object.fromEntries(refs.map(ref => [ref.key, null]))
    choices[modelReferenceKey('model', project.id)] = 'b-small'
    choices[modelReferenceKey('audit', project.id, 'conversation')] = 'mixed'
    const result = reconcileModelReferences(after, [project], { 'a-large': 'b-large', single: 'b-large', ...choices }, true, before)
    expect(result.config.activeModelConfigId).toBeNull()
    expect(result.config.commandReviewGlobal.reviewers).toMatchObject({ auditModel: true, auditModelConfigId: null })
    expect(result.projects[0].defaultModelConfigId).toBe('b-small')
    expect(result.projects[0].conversations[0].modelConfigId).toBeNull()
    expect(result.projects[0].commandExecutionDefault?.review?.reviewers).toMatchObject({ auditModel: true, auditModelConfigId: null })
    expect(result.projects[0].conversations[0].commandExecution?.review?.reviewers.auditModelConfigId).toBe('mixed')
    expect(invalidModelReferences(result.config, result.projects)).toEqual([])
  })

  it('composes cleared references across subsequent deletions', () => {
    expect(extendModelReplacements({ a: null, b: 'c' }, ['c'], null)).toEqual({ a: null, b: null, c: null })
  })

})
