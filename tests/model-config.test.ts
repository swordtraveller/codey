import { describe, expect, it } from 'vitest'
import {
  isValidContextManagementConfig,
  normalizeContextManagementConfig,
  resolveContextManagementConfig,
} from '../src/main/context-config'
import { createModelConfigSnapshot, resolveModelConfig } from '../src/main/model-config'
import {
  defaultAgentLimitsConfig,
  defaultContextManagementConfig,
  type AppConfig,
  type ContextManagementConfig,
  type Conversation,
  type ModelConfig,
  type Project,
} from '../src/shared/types'

function model(id: string): ModelConfig {
  return {
    id,
    name: id,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret',
    modelName: `${id}-model`,
    modelMaxContext: 128_000,
  }
}

function context(layeredEnabled: boolean): ContextManagementConfig {
  return { ...defaultContextManagementConfig, layeredEnabled }
}

const models = [model('app'), model('project'), model('conversation')]
const config: AppConfig = {
  modelConfigs: models,
  activeModelConfigId: 'app',
  contextManagement: context(false),
  language: 'en',
  developerMode: false,
  keepAwakeEnabled: false,
  keepAwakeOnlyWhileWorking: true,
  networkAccessEnabled: false,
  performanceTracingEnabled: false,
}
const project: Project = {
  id: 'project',
  name: 'Project',
  defaultModelConfigId: 'project',
  contextConfigOverride: null,
  folders: [],
  pythonEnvironmentFolderId: null,
  conversations: [],
}
const conversation: Conversation = {
  id: 'conversation',
  title: 'Conversation',
  modelConfigId: null,
  contextConfigOverride: null,
  agentLimits: defaultAgentLimitsConfig,
  messages: [],
  agentMessages: [],
}

describe('configuration resolution', () => {
  it('uses a conversation model override before the project default', () => {
    expect(resolveModelConfig(config, project, {
      ...conversation,
      modelConfigId: 'conversation',
    })?.id).toBe('conversation')
  })

  it('follows the project model default without a conversation override', () => {
    expect(resolveModelConfig(config, project, conversation)?.id).toBe('project')
  })

  it('uses the application model default when the project follows it', () => {
    expect(resolveModelConfig(config, {
      ...project,
      defaultModelConfigId: null,
    }, conversation)?.id).toBe('app')
  })

  it('does not replace an unavailable explicit model configuration', () => {
    expect(resolveModelConfig(config, project, {
      ...conversation,
      modelConfigId: 'missing',
    })).toBeUndefined()
  })

  it('normalizes legacy context values without merging overrides with parent settings', () => {
    expect(normalizeContextManagementConfig(undefined, {
      safeOutputMargin: 8_000,
      recentKeepRounds: 4,
    })).toEqual({
      ...defaultContextManagementConfig,
      safeOutputMargin: 8_000,
      recentKeepRounds: 4,
    })

    const override = context(true)
    expect(resolveContextManagementConfig(config, {
      ...project,
      contextConfigOverride: override,
    }, conversation)).toBe(override)
  })

  it('rejects invalid context budget values', () => {
    expect(isValidContextManagementConfig({
      ...defaultContextManagementConfig,
      recentKeepRounds: 0,
    })).toBe(false)
    expect(isValidContextManagementConfig({
      ...defaultContextManagementConfig,
      hotTokenBudget: 999,
    })).toBe(false)
  })
  it('resolves conversation, project, then application context configuration', () => {
    const projectOverride = context(true)
    const conversationOverride = { ...context(false), rewriteEnabled: false }
    const overriddenProject = { ...project, contextConfigOverride: projectOverride }

    expect(resolveContextManagementConfig(config, overriddenProject, {
      ...conversation,
      contextConfigOverride: conversationOverride,
    })).toBe(conversationOverride)
    expect(resolveContextManagementConfig(config, overriddenProject, conversation)).toBe(projectOverride)
    expect(resolveContextManagementConfig(config, project, conversation)).toBe(config.contextManagement)
  })

  it('creates a model snapshot without the API key', () => {
    expect(createModelConfigSnapshot(models[0])).toEqual({
      id: 'app',
      name: 'app',
      baseUrl: 'https://api.example.com/v1',
      modelName: 'app-model',
      modelMaxContext: 128_000,
    })
  })
})
