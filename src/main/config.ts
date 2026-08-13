import { app, safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultModelConfig, type ModelConfig } from '../shared/types'

type StoredConfig = Partial<ModelConfig> & {
  encrypted?: boolean
}


function getConfigPath(): string {
  return join(app.getPath('userData'), 'model-config.json')
}

export async function readConfig(): Promise<ModelConfig> {
  try {
    const stored = JSON.parse(await readFile(getConfigPath(), 'utf8')) as StoredConfig
    const apiKey = stored.encrypted
      ? safeStorage.decryptString(Buffer.from(stored.apiKey ?? '', 'base64'))
      : stored.apiKey

    return {
      ...defaultModelConfig,
      baseUrl: stored.baseUrl ?? '',
      apiKey: apiKey ?? '',
      modelName: stored.modelName ?? '',
      modelMaxContext: stored.modelMaxContext ?? defaultModelConfig.modelMaxContext,
      safeOutputMargin: stored.safeOutputMargin ?? defaultModelConfig.safeOutputMargin,
      recentKeepRounds: stored.recentKeepRounds ?? defaultModelConfig.recentKeepRounds,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultModelConfig
    }
    throw new Error('Unable to read model configuration')
  }
}

export async function saveConfig(config: ModelConfig): Promise<ModelConfig> {
  const normalized: ModelConfig = {
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey.trim(),
    modelName: config.modelName.trim(),
    modelMaxContext: Math.floor(config.modelMaxContext),
    safeOutputMargin: Math.floor(config.safeOutputMargin),
    recentKeepRounds: Math.floor(config.recentKeepRounds),
  }
  const url = new URL(normalized.baseUrl)

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !normalized.apiKey ||
    !normalized.modelName ||
    !Number.isInteger(normalized.modelMaxContext) ||
    !Number.isInteger(normalized.safeOutputMargin) ||
    !Number.isInteger(normalized.recentKeepRounds) ||
    normalized.modelMaxContext < 1_000 ||
    normalized.safeOutputMargin < 1 ||
    normalized.safeOutputMargin >= normalized.modelMaxContext ||
    normalized.recentKeepRounds < 1 ||
    normalized.recentKeepRounds > 20
  ) {
    throw new Error('Enter valid model and context settings')
  }

  const encrypted = safeStorage.isEncryptionAvailable()
  const stored: StoredConfig = {
    ...normalized,
    apiKey: encrypted
      ? safeStorage.encryptString(normalized.apiKey).toString('base64')
      : normalized.apiKey,
    encrypted,
  }

  await writeFile(getConfigPath(), JSON.stringify(stored), 'utf8')
  return normalized
}
