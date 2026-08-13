import { app, safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelConfig } from '../shared/types'

type StoredConfig = ModelConfig & {
  encrypted: boolean
}

const emptyConfig: ModelConfig = { baseUrl: '', apiKey: '', modelName: '' }

function getConfigPath(): string {
  return join(app.getPath('userData'), 'model-config.json')
}

export async function readConfig(): Promise<ModelConfig> {
  try {
    const stored = JSON.parse(await readFile(getConfigPath(), 'utf8')) as StoredConfig
    const apiKey = stored.encrypted
      ? safeStorage.decryptString(Buffer.from(stored.apiKey, 'base64'))
      : stored.apiKey

    return {
      baseUrl: stored.baseUrl ?? '',
      apiKey: apiKey ?? '',
      modelName: stored.modelName ?? '',
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyConfig
    }
    throw new Error('Unable to read model configuration')
  }
}

export async function saveConfig(config: ModelConfig): Promise<ModelConfig> {
  const normalized = {
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey.trim(),
    modelName: config.modelName.trim(),
  }
  const url = new URL(normalized.baseUrl)

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !normalized.apiKey ||
    !normalized.modelName
  ) {
    throw new Error('Enter a valid base URL, API key, and model name')
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
