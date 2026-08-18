import { describe, expect, it } from 'vitest'
import { createModelConfigSnapshot, resolveModelConfig } from '../src/main/model-config'
import type { AppConfig, Conversation, ModelConfig, Project } from '../src/shared/types'

function model(id: string): ModelConfig {
  return {
    id,
    name: id,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret',
    modelName: `${id}-model`,
    modelMaxContext: 128_000,
    safeOutputMargin: 16_000,
    recentKeepRounds: 5,
  }
}

const models = [model('app'), model('project'), model('conversation')]
const config: AppConfig = {
  modelConfigs: models,
  activeModelConfigId: 'app',
  language: 'en',
}
const project: Project = {
  id: 'project',
  name: 'Project',
  defaultModelConfigId: 'project',
  folders: [],
  pythonEnvironmentFolderId: null,
  conversations: [],
}
const conversation: Conversation = {
  id: 'conversation',
  title: 'Conversation',
  modelConfigId: null,
  messages: [],
  agentMessages: [],
}

describe('model configuration resolution', () => {
  it('uses a conversation override before the project default', () => {
    expect(resolveModelConfig(config, project, {
      ...conversation,
      modelConfigId: 'conversation',
    })?.id).toBe('conversation')
  })

  it('follows the project default without a conversation override', () => {
    expect(resolveModelConfig(config, project, conversation)?.id).toBe('project')
  })

  it('uses the application default when the project follows it', () => {
    expect(resolveModelConfig(config, {
      ...project,
      defaultModelConfigId: null,
    }, conversation)?.id).toBe('app')
  })

  it('does not replace an unavailable explicit configuration', () => {
    expect(resolveModelConfig(config, project, {
      ...conversation,
      modelConfigId: 'missing',
    })).toBeUndefined()
  })

  it('creates a snapshot without the API key', () => {
    expect(createModelConfigSnapshot(models[0])).toEqual({
      id: 'app',
      name: 'app',
      baseUrl: 'https://api.example.com/v1',
      modelName: 'app-model',
      modelMaxContext: 128_000,
      safeOutputMargin: 16_000,
      recentKeepRounds: 5,
    })
  })
})
