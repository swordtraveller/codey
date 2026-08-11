import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type ModelConfig = {
  baseUrl: string
  apiKey: string
  modelName: string
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

type StoredConfig = ModelConfig & {
  encrypted: boolean
}

type ChatResponse = {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string }
}

const emptyConfig: ModelConfig = { baseUrl: '', apiKey: '', modelName: '' }

function getConfigPath(): string {
  return join(app.getPath('userData'), 'model-config.json')
}

async function readConfig(): Promise<ModelConfig> {
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

async function saveConfig(config: ModelConfig): Promise<ModelConfig> {
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

  const encrypted = Boolean(normalized.apiKey) && safeStorage.isEncryptionAvailable()
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

async function requestReply(messages: ChatMessage[]): Promise<string> {
  const config = await readConfig()
  if (!config.baseUrl || !config.apiKey || !config.modelName) {
    throw new Error('Configure a model before sending a message')
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.modelName, messages }),
  })
  const data = (await response.json()) as ChatResponse

  if (!response.ok) {
    throw new Error(data.error?.message || `Request failed with status ${response.status}`)
  }

  const reply = data.choices?.[0]?.message?.content?.trim()
  if (!reply) {
    throw new Error('The model returned an empty response')
  }

  return reply
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 840,
    minHeight: 560,
    title: 'Codey',
    autoHideMenuBar: true,
    backgroundColor: '#f7f7f5',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/index.js'),
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('config:get', () => readConfig())
  ipcMain.handle('config:save', (_event, config: ModelConfig) => saveConfig(config))
  ipcMain.handle('chat:send', async (_event, messages: ChatMessage[]) => {
    try {
      return { reply: await requestReply(messages) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Request failed' }
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
