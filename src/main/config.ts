import { randomUUID } from 'node:crypto'
import { app, safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  defaultAppConfig,
  defaultModelConfig,
  type AppConfig,
  type AppLanguage,
  type ContextManagementConfig,
  type ModelConfig,
} from '../shared/types'
import { isValidContextManagementConfig, normalizeContextManagementConfig } from './context-config'

type StoredModelConfig = Partial<ModelConfig> & {
  encrypted?: boolean
  safeOutputMargin?: number
  recentKeepRounds?: number
}

type StoredAppConfig = {
  modelConfigs?: StoredModelConfig[]
  activeModelConfigId?: string | null
  contextManagement?: Partial<ContextManagementConfig>
  language?: AppLanguage
  developerMode?: boolean
  keepAwakeEnabled?: boolean
  keepAwakeOnlyWhileWorking?: boolean
  networkAccessEnabled?: boolean
}

type LegacyStoredConfig = StoredModelConfig & {
  language?: AppLanguage
}

function getConfigPath(): string {
  return join(app.getPath('userData'), 'model-config.json')
}

function isAppLanguage(value: unknown): value is AppLanguage {
  return value === 'system' || value === 'en' || value === 'zh-CN'
}

function readModelConfig(stored: StoredModelConfig): ModelConfig {
  const apiKey = stored.encrypted
    ? safeStorage.decryptString(Buffer.from(stored.apiKey ?? '', 'base64'))
    : stored.apiKey

  return {
    ...defaultModelConfig,
    id: stored.id?.trim() || randomUUID(),
    name: stored.name?.trim() || stored.modelName?.trim() || 'Model',
    baseUrl: stored.baseUrl ?? '',
    apiKey: apiKey ?? '',
    modelName: stored.modelName ?? '',
    modelMaxContext: stored.modelMaxContext ?? defaultModelConfig.modelMaxContext,
  }
}

function normalizeModelConfig(config: ModelConfig): ModelConfig {
  return {
    id: config.id.trim(),
    name: config.name.trim(),
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey.trim(),
    modelName: config.modelName.trim(),
    modelMaxContext: Math.floor(config.modelMaxContext),
  }
}

function isValidModelConfig(config: ModelConfig): boolean {
  try {
    const url = new URL(config.baseUrl)
    return Boolean(
      config.id &&
      config.name &&
      ['http:', 'https:'].includes(url.protocol) &&
      config.apiKey &&
      config.modelName &&
      Number.isInteger(config.modelMaxContext) &&
      config.modelMaxContext >= 1_000
    )
  } catch {
    return false
  }
}

async function writeConfig(config: AppConfig): Promise<void> {
  const encrypted = safeStorage.isEncryptionAvailable()
  const stored: StoredAppConfig = {
    ...config,
    modelConfigs: config.modelConfigs.map((model) => ({
      ...model,
      apiKey: encrypted
        ? safeStorage.encryptString(model.apiKey).toString('base64')
        : model.apiKey,
      encrypted,
    })),
  }

  await writeFile(getConfigPath(), JSON.stringify(stored), 'utf8')
}

export async function readConfig(): Promise<AppConfig> {
  try {
    const stored = JSON.parse(await readFile(getConfigPath(), 'utf8')) as StoredAppConfig & LegacyStoredConfig
    const language = isAppLanguage(stored.language) ? stored.language : defaultAppConfig.language
    const keepAwakeEnabled = stored.keepAwakeEnabled === true
    const keepAwakeOnlyWhileWorking = stored.keepAwakeOnlyWhileWorking !== false
    const networkAccessEnabled = stored.networkAccessEnabled === true

    if (Array.isArray(stored.modelConfigs)) {
      const modelConfigs = stored.modelConfigs.map(readModelConfig)
      const activeModelConfigId = modelConfigs.some((model) => model.id === stored.activeModelConfigId)
        ? (stored.activeModelConfigId ?? null)
        : (modelConfigs[0]?.id ?? null)
      const legacyModel = stored.modelConfigs.find((model) => model.id === activeModelConfigId) ?? stored.modelConfigs[0]
      const contextManagement = normalizeContextManagementConfig(stored.contextManagement, legacyModel)
      const developerMode = stored.developerMode === true
      const config: AppConfig = {
        modelConfigs,
        activeModelConfigId,
        contextManagement,
        language,
        developerMode,
        keepAwakeEnabled,
        keepAwakeOnlyWhileWorking,
        networkAccessEnabled,
      }
      const needsMigration = stored.developerMode === undefined ||
        stored.keepAwakeEnabled === undefined ||
        stored.keepAwakeOnlyWhileWorking === undefined ||
        stored.networkAccessEnabled === undefined ||
        !stored.contextManagement || stored.modelConfigs.some((model) =>
        !model.id || !model.name || model.safeOutputMargin !== undefined || model.recentKeepRounds !== undefined
      ) || stored.activeModelConfigId !== activeModelConfigId
      if (needsMigration) {
        await writeConfig(config)
      }
      return config
    }

    const hasLegacyModel = Boolean(stored.baseUrl || stored.apiKey || stored.modelName)
    if (!hasLegacyModel) {
      return {
        ...defaultAppConfig,
        contextManagement: normalizeContextManagementConfig(stored.contextManagement),
        language,
        developerMode: stored.developerMode === true,
        keepAwakeEnabled,
        keepAwakeOnlyWhileWorking,
        networkAccessEnabled,
      }
    }

    const model = readModelConfig(stored)
    const migrated = {
      modelConfigs: [model],
      activeModelConfigId: model.id,
      contextManagement: normalizeContextManagementConfig(stored.contextManagement, stored),
      language,
      developerMode: stored.developerMode === true,
      keepAwakeEnabled,
      keepAwakeOnlyWhileWorking,
      networkAccessEnabled,
    }
    await writeConfig(migrated)
    return migrated
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...defaultAppConfig, modelConfigs: [] }
    }
    throw new Error('Unable to read model configuration')
  }
}

export async function saveConfig(config: AppConfig): Promise<AppConfig> {
  const modelConfigs = config.modelConfigs.map(normalizeModelConfig)
  const contextManagement = normalizeContextManagementConfig(config.contextManagement)
  const ids = new Set(modelConfigs.map((model) => model.id))
  const activeModelConfigId = config.activeModelConfigId ?? modelConfigs[0]?.id ?? null

  if (
    modelConfigs.length === 0 ||
    ids.size !== modelConfigs.length ||
    modelConfigs.some((model) => !isValidModelConfig(model)) ||
    !activeModelConfigId ||
    !ids.has(activeModelConfigId) ||
    !isValidContextManagementConfig(contextManagement) ||
    contextManagement.safeOutputMargin >= Math.min(...modelConfigs.map((model) => model.modelMaxContext))
  ) {
    throw new Error('Enter valid model and context settings')
  }

  const normalized: AppConfig = {
    modelConfigs,
    activeModelConfigId,
    contextManagement,
    language: isAppLanguage(config.language) ? config.language : defaultAppConfig.language,
    developerMode: config.developerMode === true,
    keepAwakeEnabled: config.keepAwakeEnabled === true,
    keepAwakeOnlyWhileWorking: config.keepAwakeOnlyWhileWorking !== false,
    networkAccessEnabled: config.networkAccessEnabled === true,
  }
  await writeConfig(normalized)
  return normalized
}
