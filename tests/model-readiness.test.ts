import { describe, expect, it } from 'vitest'
import { modelReadinessIssue, modelReadinessMessage } from '../src/shared/model-readiness'
import { auditReview, modelDeletionConfig, modelDeletionProject } from './model-deletion-fixtures'

function fixture() {
  const config = { ...modelDeletionConfig(), developerMode: true }
  const project = modelDeletionProject()
  project.defaultModelConfigId = null
  project.commandExecutionDefault = null
  const conversation = project.conversations[0]!
  conversation.modelConfigId = null
  conversation.commandExecution = null
  return { config, project, conversation }
}

describe('pre-send model readiness', () => {
  it('accepts null conversation/project selections when a valid model is inherited', () => {
    const { config, project, conversation } = fixture()
    expect(modelReadinessIssue(config, project, conversation)).toBeNull()
    config.activeModelConfigId = null
    expect(modelReadinessIssue(config, project, conversation)).toBe('sendModelRequired')
    project.defaultModelConfigId = 'mixed'
    expect(modelReadinessIssue(config, project, conversation)).toBeNull()
    project.defaultModelConfigId = null
    conversation.modelConfigId = 'b-small'
    expect(modelReadinessIssue(config, project, conversation)).toBeNull()
  })

  it('blocks missing and stale explicit models instead of silently inheriting', () => {
    const { config, project, conversation } = fixture()
    conversation.modelConfigId = 'deleted'
    expect(modelReadinessIssue(config, project, conversation)).toBe('sendModelRequired')
    conversation.modelConfigId = 'mixed'
    config.providers[0]!.apiKey = ''
    expect(modelReadinessIssue(config, project, conversation)).toBe('sendModelRequired')
  })

  it('requires the effective enabled audit at global, project and conversation levels', () => {
    const { config, project, conversation } = fixture()
    config.commandExecutionGlobal.enabled = true
    config.commandReviewGlobal = auditReview('')
    expect(modelReadinessIssue(config, project, conversation)).toBe('sendAuditModelRequired')
    project.commandExecutionDefault = { ...config.commandExecutionGlobal, review: auditReview('mixed') }
    expect(modelReadinessIssue(config, project, conversation)).toBeNull()
    conversation.commandExecution = { ...config.commandExecutionGlobal, review: auditReview('removed') }
    expect(modelReadinessIssue(config, project, conversation)).toBe('sendAuditModelRequired')
    conversation.commandExecution.review = auditReview('b-small')
    expect(modelReadinessIssue(config, project, conversation)).toBeNull()
    conversation.commandExecution.review = null
    expect(modelReadinessIssue(config, project, conversation)).toBe('sendAuditModelRequired')
  })

  it('does not block for unused audit configurations', () => {
    const { config, project, conversation } = fixture()
    config.commandReviewGlobal = auditReview('')
    config.commandExecutionGlobal.enabled = false
    expect(modelReadinessIssue(config, project, conversation)).toBeNull()
    config.commandExecutionGlobal.enabled = true
    config.developerMode = false
    expect(modelReadinessIssue(config, project, conversation)).toBeNull()
    config.developerMode = true
    config.commandReviewGlobal.reviewers.auditModel = false
    expect(modelReadinessIssue(config, project, conversation)).toBeNull()
  })

  it('provides actionable English and Chinese failures', () => {
    expect(modelReadinessMessage('sendModelRequired', 'en')).toContain('before sending')
    expect(modelReadinessMessage('sendAuditModelRequired', 'zh-CN')).toContain('审计模型')
  })
})
