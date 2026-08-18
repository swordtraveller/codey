import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import type { AppConfig, AssistantMessageBlock, DevelopmentProgress, DevelopmentResult } from '../shared/types'
import { develop } from './agent'
import { readConfig, saveConfig } from './config'
import { createModelConfigSnapshot, resolveModelConfig } from './model-config'
import {
  addMessage,
  addProjectFolder,
  createConversation,
  createProject,
  getProject,
  getProjects,
  saveConversationContext,
  setConversationModelConfig,
  setProjectModelConfig,
} from './workspace'

async function validateModelConfigId(modelConfigId: string | null): Promise<void> {
  if (!modelConfigId) {
    return
  }
  const config = await readConfig()
  if (!config.modelConfigs.some((model) => model.id === modelConfigId)) {
    throw new Error('Model configuration not found')
  }
}

async function developProject(
  projectId: string,
  conversationId: string,
  content: string,
  onBlocks?: (blocks: AssistantMessageBlock[]) => void,
): Promise<DevelopmentResult> {
  const normalizedContent = content.trim()
  if (!normalizedContent) {
    return { writtenFiles: [], error: 'Enter a development request' }
  }

  let project = await getProject(projectId)
  if (project.folders.length === 0) {
    return { project, writtenFiles: [], error: 'Add a project folder first' }
  }

  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) {
    return { project, writtenFiles: [], error: 'Conversation not found' }
  }

  const appConfig = await readConfig()
  const modelConfig = resolveModelConfig(appConfig, project, conversation)
  if (!modelConfig) {
    return { project, writtenFiles: [], error: 'Configure a model before sending a message' }
  }

  project = await addMessage(
    projectId,
    conversationId,
    'user',
    normalizedContent,
    undefined,
    undefined,
    createModelConfigSnapshot(modelConfig),
  )
  const updatedConversation = project.conversations.find((item) => item.id === conversationId)
  if (!updatedConversation) {
    return { project, writtenFiles: [], error: 'Conversation not found' }
  }

  const result = await develop(
    project,
    modelConfig,
    [
      ...updatedConversation.agentMessages,
      { role: 'user', content: normalizedContent },
    ],
    onBlocks,
  )
  project = await saveConversationContext(
    projectId,
    conversationId,
    result.agentMessages,
    result.context,
  )
  for (const compression of result.compressionNotices) {
    project = await addMessage(
      projectId,
      conversationId,
      'assistant',
      '',
      undefined,
      compression,
    )
  }
  if (result.reply || result.blocks?.length) {
    project = await addMessage(
      projectId,
      conversationId,
      'assistant',
      result.reply ?? '',
      result.blocks,
    )
  }

  return { project, writtenFiles: result.writtenFiles, error: result.error }
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
  ipcMain.handle('config:save', (_event, config: AppConfig) => saveConfig(config))
  ipcMain.handle('projects:get', () => getProjects())
  ipcMain.handle('projects:create', async (_event, name: string) => {
    const config = await readConfig()
    return createProject(name, config.activeModelConfigId)
  })
  ipcMain.handle('projects:add-folder', async (_event, projectId: string) => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) {
      return null
    }
    return addProjectFolder(projectId, result.filePaths[0])
  })
  ipcMain.handle(
    'projects:set-model-config',
    async (_event, projectId: string, modelConfigId: string | null) => {
      await validateModelConfigId(modelConfigId)
      return setProjectModelConfig(projectId, modelConfigId)
    },
  )
  ipcMain.handle('conversations:create', (_event, projectId: string) =>
    createConversation(projectId),
  )
  ipcMain.handle(
    'conversations:set-model-config',
    async (
      _event,
      projectId: string,
      conversationId: string,
      modelConfigId: string | null,
    ) => {
      await validateModelConfigId(modelConfigId)
      return setConversationModelConfig(projectId, conversationId, modelConfigId)
    },
  )
  ipcMain.handle(
    'development:send',
    (event, projectId: string, conversationId: string, content: string) =>
      developProject(projectId, conversationId, content, (blocks) => {
        if (!event.sender.isDestroyed()) {
          const progress: DevelopmentProgress = { projectId, conversationId, blocks }
          event.sender.send('development:progress', progress)
        }
      }),
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
