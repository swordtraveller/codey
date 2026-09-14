import { randomUUID } from 'node:crypto'
import { app, safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  defaultAgentLimitsConfig,
  defaultAppConfig,
  type AgentLimitsConfig,
  type AppConfig,
  type AppLanguage,
  type CommandExecutionConfig,
  type CommandReviewConfig,
  type ContextManagementConfig,
  type ModelConfig,
  type ModelDefinition,
  type ModelGroupConfig,
  type ModelLink,
  type ProviderConfig,
} from '../shared/types'
import { modelGroupDefaultRetries, modelGroupMaxRetries, modelGroupMinRetries } from '../shared/types'
import { normalizeAgentLimitsConfig, isValidAgentLimitsConfig } from './agent-limits'
import {
  isValidCommandExecutionConfig,
  isValidCommandReviewConfig,
  normalizeCommandExecutionConfig,
  normalizeCommandReviewConfig,
} from './command-execution-config'
import { isValidContextManagementConfig, normalizeContextManagementConfig } from './context-config'

type LegacyStoredModel = Partial<ModelConfig> & {
  encrypted?: boolean
  safeOutputMargin?: number
  recentKeepRounds?: number
}

type StoredProvider = Partial<ProviderConfig> & { encrypted?: boolean }

type StoredAppConfig = {
  /** Legacy flat model list; migrated into the four-layer structure on read. */
  modelConfigs?: LegacyStoredModel[]
  providers?: StoredProvider[]
  modelDefinitions?: Partial<ModelDefinition>[]
  models?: Partial<ModelLink>[]
  modelGroups?: Partial<ModelGroupConfig>[]
  activeModelConfigId?: string | null
  contextManagement?: Partial<ContextManagementConfig> & { safeOutputMargin?: number }
  language?: AppLanguage
  developerMode?: boolean
  keepAwakeEnabled?: boolean
  keepAwakeOnlyWhileWorking?: boolean
  networkAccessEnabled?: boolean
  performanceTracingEnabled?: boolean
  commandReview?: Partial<CommandReviewConfig>
  agentLimits?: Partial<AgentLimitsConfig>
  commandExecutionGlobal?: Partial<CommandExecutionConfig> | null
}

type LegacyStoredConfig = LegacyStoredModel & {
  language?: AppLanguage
}

function getConfigPath(): string {
  return join(app.getPath('userData'), 'model-config.json')
}

function isAppLanguage(value: unknown): value is AppLanguage {
  return value === 'system' || value === 'en' || value === 'zh-CN'
}

function toOptionalTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined
}

function decryptApiKey(stored: { apiKey?: string; encrypted?: boolean }): string {
  return stored.encrypted
    ? safeStorage.decryptString(Buffer.from(stored.apiKey ?? '', 'base64'))
    : (stored.apiKey ?? '')
}

function readLegacyModel(stored: LegacyStoredModel): ModelConfig {
  const apiKey = decryptApiKey(stored)
  return {
    ...defaultModelConfigShape(),
    id: stored.id?.trim() || randomUUID(),
    name: stored.name?.trim() || stored.modelName?.trim() || 'Model',
    baseUrl: stored.baseUrl ?? '',
    apiKey,
    modelName: stored.modelName ?? '',
    modelMaxContext: stored.modelMaxContext ?? 128_000,
    modelMaxOutputTokens: toOptionalTokenCount(stored.modelMaxOutputTokens),
    supportsImageInput: stored.supportsImageInput === true,
    supportsPdfInput: stored.supportsPdfInput === true,
    supportsVideoInput: stored.supportsVideoInput === true,
    supportsAudioInput: stored.supportsAudioInput === true,
  }
}

function defaultModelConfigShape(): ModelConfig {
  return {
    id: '',
    name: '',
    baseUrl: '',
    apiKey: '',
    modelName: '',
    modelMaxContext: 128_000,
    supportsImageInput: false,
    supportsPdfInput: false,
    supportsVideoInput: false,
    supportsAudioInput: false,
  }
}

/** Splits a legacy flat model config into provider + definition + link. The
 *  link keeps the original id so every stored reference (projects,
 *  conversations, audit models, groups) stays valid. Providers dedupe on the
 *  normalized baseUrl. */
export function migrateLegacyModel(
  legacy: ModelConfig,
  layers: { providers: ProviderConfig[]; modelDefinitions: ModelDefinition[]; models: ModelLink[] },
): void {
  const baseUrl = legacy.baseUrl.trim().replace(/\/+$/, '')
  let provider = layers.providers.find((entry) => entry.baseUrl === baseUrl)
  if (!provider) {
    let host = baseUrl
    try {
      host = new URL(baseUrl).host
    } catch {
      // Keep the raw base URL as the display name when unparseable.
    }
    provider = {
      id: randomUUID(),
      name: host || 'Provider',
      baseUrl,
      apiKey: legacy.apiKey,
    }
    layers.providers.push(provider)
  }
  layers.modelDefinitions.push({
    id: randomUUID(),
    modelName: legacy.modelName,
    modelMaxContext: legacy.modelMaxContext,
    modelMaxOutputTokens: legacy.modelMaxOutputTokens,
    supportsImageInput: legacy.supportsImageInput,
    supportsPdfInput: legacy.supportsPdfInput,
    supportsVideoInput: legacy.supportsVideoInput,
    supportsAudioInput: legacy.supportsAudioInput,
  })
  layers.models.push({
    id: legacy.id,
    name: legacy.name || legacy.modelName,
    providerId: provider.id,
    definitionId: layers.modelDefinitions.at(-1)!.id,
  })
}

export function normalizeProviderConfig(value: Partial<ProviderConfig> | null | undefined): ProviderConfig {
  return {
    id: typeof value?.id === 'string' && value.id.trim() ? value.id.trim() : randomUUID(),
    name: (value?.name ?? '').trim(),
    baseUrl: (value?.baseUrl ?? '').trim().replace(/\/+$/, ''),
    apiKey: (value?.apiKey ?? '').trim(),
  }
}

export function normalizeModelDefinition(value: Partial<ModelDefinition> | null | undefined): ModelDefinition {
  const maxContext = Math.floor(Number(value?.modelMaxContext))
  return {
    id: typeof value?.id === 'string' && value.id.trim() ? value.id.trim() : randomUUID(),
    modelName: (value?.modelName ?? '').trim(),
    modelMaxContext: Number.isFinite(maxContext) && maxContext >= 1_000 ? maxContext : 128_000,
    modelMaxOutputTokens: toOptionalTokenCount(value?.modelMaxOutputTokens),
    supportsImageInput: value?.supportsImageInput === true,
    supportsPdfInput: value?.supportsPdfInput === true,
    supportsVideoInput: value?.supportsVideoInput === true,
    supportsAudioInput: value?.supportsAudioInput === true,
  }
}

export function normalizeModelLink(value: Partial<ModelLink> | null | undefined): ModelLink {
  return {
    id: typeof value?.id === 'string' && value.id.trim() ? value.id.trim() : randomUUID(),
    name: (value?.name ?? '').trim(),
    providerId: (value?.providerId ?? '').trim(),
    definitionId: (value?.definitionId ?? '').trim(),
  }
}

export function normalizeModelGroup(value: Partial<ModelGroupConfig> | null | undefined): ModelGroupConfig {
  const retries = Math.floor(Number(value?.retriesPerModel))
  return {
    id: typeof value?.id === 'string' && value.id.trim() ? value.id.trim() : randomUUID(),
    name: (value?.name ?? '').trim(),
    modelIds: Array.isArray(value?.modelIds)
      ? [...new Set(value.modelIds.filter((id): id is string => typeof id === 'string' && id.trim() !== ''))]
      : [],
    retriesPerModel: Number.isFinite(retries)
      ? Math.min(modelGroupMaxRetries, Math.max(modelGroupMinRetries, retries))
      : modelGroupDefaultRetries,
  }
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function isValidProviderConfig(provider: ProviderConfig): boolean {
  return Boolean(provider.id && provider.name && isValidHttpUrl(provider.baseUrl) && provider.apiKey)
}

export function isValidModelDefinition(definition: ModelDefinition): boolean {
  return Boolean(
    definition.id &&
    definition.modelName &&
    Number.isInteger(definition.modelMaxContext) &&
    definition.modelMaxContext >= 1_000 &&
    (definition.modelMaxOutputTokens === undefined ||
      (Number.isInteger(definition.modelMaxOutputTokens) && definition.modelMaxOutputTokens >= 1)),
  )
}

export function isValidAppConfigLayers(config: Pick<AppConfig, 'providers' | 'modelDefinitions' | 'models' | 'modelGroups' | 'activeModelConfigId'>): boolean {
  const providerIds = new Set(config.providers.map((provider) => provider.id))
  const definitionIds = new Set(config.modelDefinitions.map((definition) => definition.id))
  const modelIds = new Set(config.models.map((model) => model.id))
  if (config.providers.some((provider) => !isValidProviderConfig(provider))) return false
  if (config.modelDefinitions.some((definition) => !isValidModelDefinition(definition))) return false
  if (new Set(config.providers.map((provider) => provider.name.trim().toLowerCase())).size !== config.providers.length) return false
  if (new Set(config.modelDefinitions.map((definition) => definition.modelName.trim().toLowerCase())).size !== config.modelDefinitions.length) return false
  if (providerIds.size !== config.providers.length) return false
  if (definitionIds.size !== config.modelDefinitions.length) return false
  if (modelIds.size !== config.models.length) return false
  if (config.models.some((model) =>
    !model.id || !model.name || !providerIds.has(model.providerId) || !definitionIds.has(model.definitionId))) return false
  if (config.modelGroups.some((group) =>
    !group.id || !group.name ||
    group.modelIds.length === 0 ||
    group.modelIds.some((id) => !modelIds.has(id)) ||
    group.retriesPerModel < modelGroupMinRetries || group.retriesPerModel > modelGroupMaxRetries)) return false
  if (config.modelGroups.length !== new Set(config.modelGroups.map((group) => group.id)).size) return false
  const active = config.activeModelConfigId
  if (active && !modelIds.has(active) && !config.modelGroups.some((group) => group.id === active)) return false
  return true
}

async function writeConfig(config: AppConfig): Promise<void> {
  const encrypted = safeStorage.isEncryptionAvailable()
  const stored: StoredAppConfig = {
    ...config,
    modelConfigs: undefined,
    commandReview: config.commandReviewGlobal,
    agentLimits: config.agentLimitsGlobal,
    providers: config.providers.map((provider) => ({
      ...provider,
      apiKey: encrypted
        ? safeStorage.encryptString(provider.apiKey).toString('base64')
        : provider.apiKey,
      encrypted,
    })),
  }
  delete (stored as Record<string, unknown>).modelConfigs
  delete (stored as Record<string, unknown>).commandReviewGlobal
  delete (stored as Record<string, unknown>).agentLimitsGlobal

  await writeFile(getConfigPath(), JSON.stringify(stored), 'utf8')
}

function readLayers(stored: StoredAppConfig): {
  providers: ProviderConfig[]
  modelDefinitions: ModelDefinition[]
  models: ModelLink[]
  modelGroups: ModelGroupConfig[]
  migrated: boolean
} {
  const providers = (stored.providers ?? []).map((entry) => normalizeProviderConfig({
    ...entry,
    apiKey: decryptApiKey(entry),
  }))
  const modelDefinitions = (stored.modelDefinitions ?? []).map(normalizeModelDefinition)
  const models = (stored.models ?? []).map(normalizeModelLink)
  const modelGroups = (stored.modelGroups ?? []).map(normalizeModelGroup)
  let migrated = false
  // Legacy flat list: split into the four layers, preserving model ids.
  if (Array.isArray(stored.modelConfigs) && stored.modelConfigs.length > 0) {
    for (const legacyStored of stored.modelConfigs) {
      migrateLegacyModel(readLegacyModel(legacyStored), { providers, modelDefinitions, models })
    }
    migrated = true
  }
  return { providers, modelDefinitions, models, modelGroups, migrated }
}

function repairActiveTarget(layers: { models: ModelLink[]; modelGroups: ModelGroupConfig[] }, active: string | null): string | null {
  if (active && (layers.models.some((model) => model.id === active) || layers.modelGroups.some((group) => group.id === active))) {
    return active
  }
  return layers.models[0]?.id ?? layers.modelGroups[0]?.id ?? null
}

function readAgentLimitsGlobal(stored: StoredAppConfig): AgentLimitsConfig {
  const normalized = normalizeAgentLimitsConfig(stored.agentLimits)
  return isValidAgentLimitsConfig(normalized)
    ? normalized
    : { ...defaultAgentLimitsConfig }
}

function readCommandExecutionGlobal(stored: StoredAppConfig): CommandExecutionConfig {
  const normalized = { ...normalizeCommandExecutionConfig(stored.commandExecutionGlobal ?? undefined), review: null }
  return isValidCommandExecutionConfig(normalized)
    ? normalized
    : { ...defaultAppConfig.commandExecutionGlobal }
}

export async function readConfig(): Promise<AppConfig> {
  try {
    const stored = JSON.parse(await readFile(getConfigPath(), 'utf8')) as StoredAppConfig & LegacyStoredConfig
    const language = isAppLanguage(stored.language) ? stored.language : defaultAppConfig.language
    const keepAwakeEnabled = stored.keepAwakeEnabled === true
    const keepAwakeOnlyWhileWorking = stored.keepAwakeOnlyWhileWorking !== false
    const networkAccessEnabled = stored.networkAccessEnabled === true

    const hasLegacySingleModel = Boolean(stored.baseUrl || stored.apiKey || stored.modelName)
    if (!Array.isArray(stored.modelConfigs) && hasLegacySingleModel) {
      // Pre-list single-model format: migrate it through the legacy path.
      stored.modelConfigs = [stored as LegacyStoredModel]
    }

    if (Array.isArray(stored.modelConfigs) || stored.providers !== undefined || stored.models !== undefined) {
      const layers = readLayers(stored)
      const contextManagement = normalizeContextManagementConfig(stored.contextManagement)
      const developerMode = stored.developerMode === true
      const commandReviewGlobal = stored.commandReview === undefined
        ? { ...defaultAppConfig.commandReviewGlobal }
        : normalizeCommandReviewConfig(stored.commandReview)
      const agentLimitsGlobal = readAgentLimitsGlobal(stored)
      const commandExecutionGlobal = readCommandExecutionGlobal(stored)
      const activeModelConfigId = repairActiveTarget(layers, stored.activeModelConfigId ?? null)
      const config: AppConfig = {
        modelConfigs: [],
        providers: layers.providers,
        modelDefinitions: layers.modelDefinitions,
        models: layers.models,
        modelGroups: layers.modelGroups,
        activeModelConfigId,
        contextManagement,
        language,
        developerMode,
        performanceTracingEnabled: developerMode && stored.performanceTracingEnabled === true,
        keepAwakeEnabled,
        keepAwakeOnlyWhileWorking,
        networkAccessEnabled,
        commandReviewGlobal,
        agentLimitsGlobal,
        commandExecutionGlobal,
      }
      const legacyMargin = stored.contextManagement?.safeOutputMargin
      const needsMigration = layers.migrated ||
        stored.activeModelConfigId !== activeModelConfigId ||
        stored.developerMode === undefined ||
        stored.keepAwakeEnabled === undefined ||
        stored.keepAwakeOnlyWhileWorking === undefined ||
        stored.networkAccessEnabled === undefined ||
        stored.performanceTracingEnabled === undefined ||
        stored.commandReview === undefined ||
        stored.agentLimits === undefined ||
        stored.commandExecutionGlobal === undefined ||
        legacyMargin !== undefined ||
        !stored.contextManagement || (stored.modelConfigs ?? []).some((model) =>
          !model.id || !model.name || model.safeOutputMargin !== undefined || model.recentKeepRounds !== undefined
        )
      if (needsMigration) {
        await writeConfig(config)
      }
      return config
    }

    if (!hasLegacySingleModel) {
      return {
        ...defaultAppConfig,
        contextManagement: normalizeContextManagementConfig(stored.contextManagement),
        language,
        developerMode: stored.developerMode === true,
        performanceTracingEnabled: stored.developerMode === true && stored.performanceTracingEnabled === true,
        keepAwakeEnabled,
        keepAwakeOnlyWhileWorking,
        networkAccessEnabled,
        commandReviewGlobal: stored.commandReview === undefined
          ? { ...defaultAppConfig.commandReviewGlobal }
          : normalizeCommandReviewConfig(stored.commandReview),
        agentLimitsGlobal: readAgentLimitsGlobal(stored),
        commandExecutionGlobal: readCommandExecutionGlobal(stored),
      }
    }

    const layers = readLayers({ modelConfigs: [stored as LegacyStoredModel] })
    const migrated = {
      modelConfigs: [],
      providers: layers.providers,
      modelDefinitions: layers.modelDefinitions,
      models: layers.models,
      modelGroups: layers.modelGroups,
      activeModelConfigId: repairActiveTarget(layers, stored.activeModelConfigId ?? layers.models[0]?.id ?? null),
      contextManagement: normalizeContextManagementConfig(stored.contextManagement),
      language,
      developerMode: stored.developerMode === true,
      performanceTracingEnabled: stored.developerMode === true && stored.performanceTracingEnabled === true,
      keepAwakeEnabled,
      keepAwakeOnlyWhileWorking,
      networkAccessEnabled,
      commandReviewGlobal: stored.commandReview === undefined
        ? { ...defaultAppConfig.commandReviewGlobal }
        : normalizeCommandReviewConfig(stored.commandReview),
      agentLimitsGlobal: readAgentLimitsGlobal(stored),
      commandExecutionGlobal: readCommandExecutionGlobal(stored),
    }
    await writeConfig(migrated)
    return migrated
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...defaultAppConfig }
    }
    throw new Error('Unable to read model configuration')
  }
}

export async function saveConfig(config: AppConfig): Promise<AppConfig> {
  const providers = config.providers.map(normalizeProviderConfig)
  const modelDefinitions = config.modelDefinitions.map(normalizeModelDefinition)
  const models = config.models.map(normalizeModelLink)
  const modelGroups = config.modelGroups.map(normalizeModelGroup)
  const contextManagement = normalizeContextManagementConfig(config.contextManagement)
  const commandReviewGlobal = normalizeCommandReviewConfig(config.commandReviewGlobal)
  const agentLimitsGlobal = normalizeAgentLimitsConfig(config.agentLimitsGlobal)
  const commandExecutionGlobal = { ...normalizeCommandExecutionConfig(config.commandExecutionGlobal), review: null }
  const activeModelConfigId = repairActiveTarget(
    { models, modelGroups },
    config.activeModelConfigId ?? models[0]?.id ?? null,
  )

  const layersValid = isValidAppConfigLayers({
    providers,
    modelDefinitions,
    models,
    modelGroups,
    activeModelConfigId,
  })
  if (
    !layersValid ||
    providers.length === 0 ||
    !isValidContextManagementConfig(contextManagement) ||
    !isValidCommandReviewConfig(commandReviewGlobal) ||
    !isValidAgentLimitsConfig(agentLimitsGlobal) ||
    !isValidCommandExecutionConfig(commandExecutionGlobal)
  ) {
    throw new Error('Enter valid model and context settings')
  }

  const normalized: AppConfig = {
    modelConfigs: [],
    providers,
    modelDefinitions,
    models,
    modelGroups,
    activeModelConfigId,
    contextManagement,
    language: isAppLanguage(config.language) ? config.language : defaultAppConfig.language,
    developerMode: config.developerMode === true,
    keepAwakeEnabled: config.keepAwakeEnabled === true,
    keepAwakeOnlyWhileWorking: config.keepAwakeOnlyWhileWorking !== false,
    networkAccessEnabled: config.networkAccessEnabled === true,
    performanceTracingEnabled: config.developerMode === true && config.performanceTracingEnabled === true,
    commandReviewGlobal,
    agentLimitsGlobal,
    commandExecutionGlobal,
  }
  await writeConfig(normalized)
  return normalized
}
