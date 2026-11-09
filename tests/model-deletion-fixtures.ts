import {
  defaultAppConfig, defaultCommandExecutionConfig, defaultCommandReviewConfig,
  defaultModelConfig, defaultModelDefinition, type AppConfig, type CommandReviewConfig, type Project,
} from '../src/shared/types'

export function modelDeletionConfig(): AppConfig {
  return {
    ...structuredClone(defaultAppConfig),
    providers: ['a', 'b'].map(id => ({ id, name: `Provider ${id}`, baseUrl: `https://${id}.invalid/v1`, apiKey: 'test-only' })),
    modelDefinitions: [
      { ...defaultModelDefinition, id: 'large', modelName: 'large', modelMaxContext: 128000 },
      { ...defaultModelDefinition, id: 'small', modelName: 'small', modelMaxContext: 32000 },
    ],
    models: [
      { id: 'a-large', name: 'A large', providerId: 'a', definitionId: 'large' },
      { id: 'b-large', name: 'B large', providerId: 'b', definitionId: 'large' },
      { id: 'b-small', name: 'B small', providerId: 'b', definitionId: 'small' },
    ],
    modelGroups: [
      { id: 'mixed', name: 'Mixed', modelIds: ['b-large', 'a-large', 'b-small'], retriesPerModel: 2 },
      { id: 'single', name: 'Single', modelIds: ['a-large'], retriesPerModel: 2 },
    ],
    activeModelConfigId: 'a-large',
  }
}

export function auditReview(id: string, enabled = true): CommandReviewConfig {
  return { ...structuredClone(defaultCommandReviewConfig), reviewers: { auditModel: enabled, auditModelConfigId: id, manualConfirmation: true } }
}

export function modelDeletionProject(): Project {
  return {
    id: 'project', name: 'Archived project', archived: true, defaultModelConfigId: 'single',
    contextConfigOverride: null, agentLimitsDefault: null,
    commandExecutionDefault: { ...defaultCommandExecutionConfig, review: auditReview('single') },
    skillSelection: { enabledIds: [], disabledIds: [] }, knowledgeBaseSelection: { enabledIds: [], disabledIds: [] },
    folders: [], pythonEnvironmentFolderId: null,
    conversations: [{
      id: 'conversation', title: 'Archived conversation', archived: true, modelConfigId: 'a-large',
      contextConfigOverride: null, agentLimits: null,
      commandExecution: { ...defaultCommandExecutionConfig, review: auditReview('a-large') },
      skillSelection: { enabledIds: [], disabledIds: [] }, knowledgeBaseSelection: { enabledIds: [], disabledIds: [] },
      lastUsedModelId: 'a-large',
      perModelContextConfigs: { 'a-large': { ...defaultAppConfig.contextManagement }, 'b-small': { ...defaultAppConfig.contextManagement } },
      messages: [{ id: 'message', role: 'user', content: 'Retain historical model ids', modelConfig: historicalModel() }],
      agentMessages: [{ role: 'user', content: 'Retain agent history' }],
    }],
  }
}

function historicalModel() {
  const { apiKey: _key, ...snapshot } = defaultModelConfig
  return { ...snapshot, id: 'a-large', name: 'Historical large model' }
}
