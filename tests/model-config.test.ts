import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '.',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => value,
    decryptString: (value: string) => value,
  },
}))
import {
  isValidContextManagementConfig,
  normalizeContextManagementConfig,
  resolveContextManagementConfig,
} from '../src/main/context-config'
import { createModelConfigSnapshot, resolveConversationModel, resolveModelById } from '../src/main/model-config'
import { flattenModelLink, groupEnvelope, resolveModelTarget } from '../src/shared/model-targets'
import { migrateLegacyModel } from '../src/main/config'
import {
  defaultAgentLimitsConfig,
  defaultCommandExecutionConfig,
  defaultCommandReviewConfig,
  defaultContextManagementConfig,
  type AppConfig,
  type ContextManagementConfig,
  type Conversation,
  type ModelDefinition,
  type ModelLink,
  type Project,
  type ProviderConfig,
} from '../src/shared/types'

function context(layeredEnabled: boolean): ContextManagementConfig {
  return { ...defaultContextManagementConfig, layeredEnabled, maxInputTokens: 128_000 }
}

function layers(overrides: Partial<Pick<AppConfig, 'providers' | 'modelDefinitions' | 'models' | 'modelGroups' | 'activeModelConfigId'>> = {}): AppConfig {
  const providers = overrides.providers ?? [
    { id: 'provider-a', name: 'Provider A', baseUrl: 'https://a.example.com/v1', apiKey: 'key-a' },
    { id: 'provider-b', name: 'Provider B', baseUrl: 'https://b.example.com/v1', apiKey: 'key-b' },
  ]
  const modelDefinitions = overrides.modelDefinitions ?? ([
    { id: 'def-app', modelName: 'app-model', modelMaxContext: 128_000, supportsImageInput: true, supportsPdfInput: false, supportsVideoInput: false, supportsAudioInput: false },
    { id: 'def-project', modelName: 'project-model', modelMaxContext: 64_000, supportsImageInput: false, supportsPdfInput: false, supportsVideoInput: false, supportsAudioInput: false },
    { id: 'def-conversation', modelName: 'conversation-model', modelMaxContext: 200_000, modelMaxOutputTokens: 8_192, supportsImageInput: true, supportsPdfInput: true, supportsVideoInput: false, supportsAudioInput: false },
  ] as ModelDefinition[])
  const models = overrides.models ?? [
    { id: 'app', name: 'app', providerId: 'provider-a', definitionId: 'def-app' },
    { id: 'project', name: 'project', providerId: 'provider-a', definitionId: 'def-project' },
    { id: 'conversation', name: 'conversation', providerId: 'provider-b', definitionId: 'def-conversation' },
  ]
  const modelGroups = overrides.modelGroups ?? [
    { id: 'group-1', name: 'Fallback chain', modelIds: ['app', 'conversation'], retriesPerModel: 3 },
  ]
  return {
    modelConfigs: [],
    providers,
    modelDefinitions,
    models,
    modelGroups,
    activeModelConfigId: overrides.activeModelConfigId ?? 'app',
    contextManagement: context(false),
    language: 'en',
    developerMode: false,
    keepAwakeEnabled: false,
    keepAwakeOnlyWhileWorking: true,
    networkAccessEnabled: false,
    performanceTracingEnabled: false,
    commandReviewGlobal: { ...defaultCommandReviewConfig, contentRules: [] },
    agentLimitsGlobal: { ...defaultAgentLimitsConfig },
    commandExecutionGlobal: { ...defaultCommandExecutionConfig },
    defaultSkillIds: [],
    defaultKnowledgeBaseIds: [],
  }
}

const project: Project = {
  id: 'project',
  name: 'Project',
  archived: false,
  defaultModelConfigId: 'project',
  contextConfigOverride: null,
  skillSelection: { enabledIds: [], disabledIds: [] },
  knowledgeBaseSelection: { enabledIds: [], disabledIds: [] },
  commandExecutionDefault: { ...defaultCommandExecutionConfig },
  agentLimitsDefault: null,
  folders: [],
  pythonEnvironmentFolderId: null,
  conversations: [],
}
const conversation: Conversation = {
  id: 'conversation',
  title: 'Conversation',
  archived: false,
  modelConfigId: null,
  contextConfigOverride: null,
  skillSelection: { enabledIds: [], disabledIds: [] },
  knowledgeBaseSelection: { enabledIds: [], disabledIds: [] },
  agentLimits: defaultAgentLimitsConfig,
  commandExecution: { ...defaultCommandExecutionConfig },
  messages: [],
  agentMessages: [],
}

describe('configuration resolution', () => {
  it('uses a conversation target before the project default', () => {
    expect(resolveConversationModel(layers(), project, {
      ...conversation,
      modelConfigId: 'conversation',
    })?.id).toBe('conversation')
  })

  it('follows the project default without a conversation override', () => {
    expect(resolveConversationModel(layers(), project, conversation)?.id).toBe('project')
  })

  it('uses the application default when the project follows it', () => {
    expect(resolveConversationModel(layers(), {
      ...project,
      defaultModelConfigId: null,
    }, conversation)?.id).toBe('app')
  })

  it('resolves group targets through the same inheritance chain', () => {
    const resolved = resolveConversationModel(layers(), { ...project, defaultModelConfigId: null }, {
      ...conversation,
      modelConfigId: 'group-1',
    })
    expect(resolved?.id).toBe('group-1')
    expect(resolved?.chain.map((member) => member.modelId)).toEqual(['app', 'conversation'])
    expect(resolved?.retriesPerModel).toBe(3)
  })

  it('does not replace an unavailable explicit target', () => {
    expect(resolveConversationModel(layers(), project, {
      ...conversation,
      modelConfigId: 'missing',
    })).toBeUndefined()
  })

  it('resolves a single model by id for the audit path', () => {
    expect(resolveModelById(layers(), 'conversation')?.modelName).toBe('conversation-model')
    expect(resolveModelById(layers(), 'group-1')).toBeUndefined()
  })

  it('normalizes legacy context values without merging overrides with parent settings', () => {
    expect(normalizeContextManagementConfig(undefined)).toEqual(defaultContextManagementConfig)
    expect(normalizeContextManagementConfig({ maxInputTokens: 8_000, recentKeepRounds: 4 })).toEqual({
      ...defaultContextManagementConfig,
      maxInputTokens: 8_000,
      recentKeepRounds: 4,
    })
  })

  it('resolves conversation, project, then application context configuration', () => {
    const config = layers()
    const projectOverride = context(true)
    const conversationOverride = { ...context(false), rewriteEnabled: false }
    const overriddenProject = { ...project, contextConfigOverride: projectOverride }

    expect(resolveContextManagementConfig(layers(), overriddenProject, {
      ...conversation,
      contextConfigOverride: conversationOverride,
    })).toBe(conversationOverride)
    expect(resolveContextManagementConfig(layers(), overriddenProject, conversation)).toBe(projectOverride)
    expect(resolveContextManagementConfig(config, project, conversation)).toBe(config.contextManagement)
  })

  it('creates a model snapshot without the API key and chain', () => {
    const resolved = resolveModelTarget(layers(), 'app')
    expect(createModelConfigSnapshot(resolved!)).toEqual({
      id: 'app',
      name: 'app',
      baseUrl: 'https://a.example.com/v1',
      modelName: 'app-model',
      modelMaxContext: 128_000,
      modelMaxOutputTokens: undefined,
      supportsImageInput: true,
      supportsPdfInput: false,
      supportsVideoInput: false,
      supportsAudioInput: false,
    })
  })
})

describe('group envelope', () => {
  it('takes the weakest member: min context, min defined output, modality intersection', () => {
    const envelope = groupEnvelope([
      { id: 'a', modelName: 'a', modelMaxContext: 128_000, modelMaxOutputTokens: 16_384, supportsImageInput: true, supportsPdfInput: true },
      { id: 'b', modelName: 'b', modelMaxContext: 64_000, modelMaxOutputTokens: 4_096, supportsImageInput: true },
    ])
    expect(envelope.modelMaxContext).toBe(64_000)
    expect(envelope.modelMaxOutputTokens).toBe(4_096)
    expect(envelope.supportsImageInput).toBe(true)
    expect(envelope.supportsPdfInput).toBe(false)
  })

  it('treats an undefined output limit as unconstrained', () => {
    const envelope = groupEnvelope([
      { id: 'a', modelName: 'a', modelMaxContext: 128_000, modelMaxOutputTokens: 4_096 },
      { id: 'b', modelName: 'b', modelMaxContext: 64_000 },
    ])
    expect(envelope.modelMaxOutputTokens).toBeUndefined()
    expect(envelope.modelMaxContext).toBe(64_000)
  })

  it('resolves a group into the envelope with the full failover chain', () => {
    const resolved = resolveModelTarget(layers(), 'group-1')!
    expect(resolved.modelMaxContext).toBe(128_000) // min(128k, 200k)
    expect(resolved.supportsImageInput).toBe(true)
    expect(resolved.supportsPdfInput).toBe(false)
    expect(resolved.chain.map((member) => member.modelName)).toEqual(['app-model', 'conversation-model'])
    expect(resolved.chain[1]?.baseUrl).toBe('https://b.example.com/v1')
  })
})

describe('legacy migration', () => {
  it('splits flat configs into provider + definition + link, deduping providers by baseUrl and keeping model ids', () => {
    const target: { providers: ProviderConfig[]; modelDefinitions: ModelDefinition[]; models: ModelLink[] } = { providers: [], modelDefinitions: [], models: [] }
    migrateLegacyModel({
      id: 'm1', name: 'Primary', baseUrl: 'https://a.example.com/v1/', apiKey: 'k1',
      modelName: 'glm-5', modelMaxContext: 128_000,
    }, target)
    migrateLegacyModel({
      id: 'm2', name: 'Backup', baseUrl: 'https://a.example.com/v1', apiKey: 'k1',
      modelName: 'glm-4', modelMaxContext: 64_000, supportsImageInput: true,
    }, target)
    migrateLegacyModel({
      id: 'm3', name: 'Other', baseUrl: 'https://b.example.com/v1', apiKey: 'k2',
      modelName: 'glm-5', modelMaxContext: 96_000,
    }, target)

    expect(target.providers.map((provider) => provider.id)).toHaveLength(2)
    expect(target.providers[0]?.baseUrl).toBe('https://a.example.com/v1')
    expect(target.models.map((model) => model.id)).toEqual(['m1', 'm2', 'm3'])
    expect(target.models[0]?.providerId).toBe(target.models[1]?.providerId)
    expect(target.models[0]?.providerId).not.toBe(target.models[2]?.providerId)
    expect(target.modelDefinitions.map((definition) => definition.modelName)).toEqual(['glm-5', 'glm-4', 'glm-5'])
    expect(target.models[1]?.definitionId).toBe(target.modelDefinitions[1]?.id)
  })

  it('flattens a link back into the legacy shape', () => {
    const config = layers()
    const flat = flattenModelLink(config, config.models[2]!)
    expect(flat).toEqual({
      id: 'conversation',
      name: 'conversation',
      baseUrl: 'https://b.example.com/v1',
      apiKey: 'key-b',
      modelName: 'conversation-model',
      modelMaxContext: 200_000,
      modelMaxOutputTokens: 8_192,
      supportsImageInput: true,
      supportsPdfInput: true,
      supportsVideoInput: false,
      supportsAudioInput: false,
    })
  })
})
