import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import type { DevelopmentResult, ModelConfig } from '../shared/types'
import { develop } from './agent'
import { readConfig, saveConfig } from './config'
import {
  addMessage,
  addProjectFolder,
  createConversation,
  createProject,
  getProject,
  getProjects,
} from './workspace'

async function developProject(
  projectId: string,
  conversationId: string,
  content: string,
): Promise<DevelopmentResult> {
  const normalizedContent = content.trim()
  if (!normalizedContent) {
    return { writtenFiles: [], error: 'Enter a development request' }
  }

  let project = await getProject(projectId)
  if (project.folders.length === 0) {
    return { project, writtenFiles: [], error: 'Add a project folder first' }
  }

  project = await addMessage(projectId, conversationId, 'user', normalizedContent)
  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) {
    return { project, writtenFiles: [], error: 'Conversation not found' }
  }

  const result = await develop(project, conversation.messages)
  if (result.reply) {
    project = await addMessage(projectId, conversationId, 'assistant', result.reply)
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
    'development:send',
    (_event, projectId: string, conversationId: string, content: string) =>
      developProject(projectId, conversationId, content),
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
