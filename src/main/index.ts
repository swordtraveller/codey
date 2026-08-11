import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import type { ChatMessage, ChatResult, ModelConfig } from '../shared/types'
import { readConfig, saveConfig } from './config'
import {
  addMessage,
  addProjectFolder,
  createConversation,
  createProject,
  getProjects,
} from './workspace'

type ChatResponse = {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string }
}

async function requestReply(messages: ChatMessage[]): Promise<string> {
  const config = await readConfig()
  if (!config.baseUrl || !config.apiKey || !config.modelName) {
    throw new Error('Configure a model before sending a message')
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.modelName,
      messages: messages.map(({ role, content }) => ({ role, content })),
    }),
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

async function chat(
  projectId: string,
  conversationId: string,
  content: string,
): Promise<ChatResult> {
  const normalizedContent = content.trim()
  if (!normalizedContent) {
    return { error: 'Enter a message' }
  }

  let project = await addMessage(projectId, conversationId, 'user', normalizedContent)
  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) {
    return { project, error: 'Conversation not found' }
  }

  try {
    const reply = await requestReply(conversation.messages)
    project = await addMessage(projectId, conversationId, 'assistant', reply)
    return { project }
  } catch (error) {
    return {
      project,
      error: error instanceof Error ? error.message : 'Request failed',
    }
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
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
  ipcMain.handle('projects:get', () => getProjects())
  ipcMain.handle('projects:create', (_event, name: string) => createProject(name))
  ipcMain.handle('projects:add-folder', async (_event, projectId: string) => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) {
      return null
    }
    return addProjectFolder(projectId, result.filePaths[0])
  })
  ipcMain.handle('conversations:create', (_event, projectId: string) =>
    createConversation(projectId),
  )
  ipcMain.handle(
    'chat:send',
    (_event, projectId: string, conversationId: string, content: string) =>
      chat(projectId, conversationId, content),
  )

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
