import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker } from 'electron'
import { join } from 'node:path'
import type {
  AppConfig,
  AssistantMessageBlock,
  ContextManagementConfig,
  ConversationRuntimeState,
  ConversationStateChange,
  ConversationTurnRecord,
  DevelopmentProgress,
  DevelopmentResult,
  DevelopmentTimelineItem,
} from '../shared/types'
import { develop } from './agent'
import { readConfig, saveConfig } from './config'
import { resolveContextManagementConfig } from './context-config'
import {
  buildContextDebugSnapshot,
  demoteContext,
  getContextDebugOverview,
  getContextDebugRevision,
  getRememberedWarmMessages,
  persistContextDebugMessages,
  readColdContextMessage,
  readContextSnapshotMessage,
  rememberSnapshot,
  searchColdContext,
  setContextPin,
  simulateTokenLimit,
} from './context-debug'
import {
  ensureConversationMessages,
  readConversationMessages,
  readConversationWorkingSet,
} from './conversation-store'
import { log } from './logger'
import { createModelConfigSnapshot, resolveModelConfig } from './model-config'
import {
  addMessage,
  addProjectFolder,
  createConversation,
  createProject,
  getProject,
  getProjects,
  saveConversationContext,
  setConversationContextConfig,
  setConversationModelConfig,
  setProjectContextConfig,
  setProjectModelConfig,
  updateConversationAgentMessages,
  updateConversationTurn,
} from './workspace'

const conversationStates = new Map<string, ConversationRuntimeState>()
const conversationControllers = new Map<string, AbortController>()
const contextDebugWindows = new Map<string, BrowserWindow>()
let mainWindow: BrowserWindow | null = null
let keepAwakeBlockerId: number | null = null
let keepAwakeEnabled = false
let keepAwakeOnlyWhileWorking = true

function updateKeepAwake(config?: AppConfig): void {
  if (config) {
    keepAwakeEnabled = config.keepAwakeEnabled
    keepAwakeOnlyWhileWorking = config.keepAwakeOnlyWhileWorking
  }

  const conversationActive = [...conversationStates.values()].some((state) => state !== 'idle')
  const shouldKeepAwake = keepAwakeEnabled && (!keepAwakeOnlyWhileWorking || conversationActive)
  if (shouldKeepAwake && keepAwakeBlockerId === null) {
    keepAwakeBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    log.debug('power.keep-awake.started', { mode: 'prevent-app-suspension' })
  } else if (!shouldKeepAwake && keepAwakeBlockerId !== null) {
    powerSaveBlocker.stop(keepAwakeBlockerId)
    keepAwakeBlockerId = null
    log.debug('power.keep-awake.stopped', {})
  }
}

function conversationKey(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`
}

function getConversationState(projectId: string, conversationId: string): ConversationRuntimeState {
  return conversationStates.get(conversationKey(projectId, conversationId)) ?? 'idle'
}

function setConversationState(
  projectId: string,
  conversationId: string,
  state: ConversationRuntimeState,
): void {
  const key = conversationKey(projectId, conversationId)
  if (state === 'idle') {
    conversationStates.delete(key)
  } else {
    conversationStates.set(key, state)
  }
  updateKeepAwake()
  const change: ConversationStateChange = { projectId, conversationId, state }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send('conversation:state-change', change)
    }
  }
}

function ensureIdle(projectId: string, conversationId: string): void {
  if (getConversationState(projectId, conversationId) !== 'idle') {
    throw new Error('The conversation must be idle')
  }
}

function ensureAllIdle(): void {
  if ([...conversationStates.values()].some((state) => state !== 'idle')) {
    throw new Error('Context settings cannot be changed during a conversation round or debug operation')
  }
}

async function runDebugOperation<T>(
  projectId: string,
  conversationId: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const config = await readConfig()
  if (!config.developerMode) {
    throw new Error('Developer mode is disabled')
  }
  ensureIdle(projectId, conversationId)
  setConversationState(projectId, conversationId, 'debugging')
  try {
    return await operation()
  } finally {
    setConversationState(projectId, conversationId, 'idle')
  }
}

async function validateModelConfigId(modelConfigId: string | null): Promise<void> {
  if (!modelConfigId) return
  const config = await readConfig()
  if (!config.modelConfigs.some((model) => model.id === modelConfigId)) {
    throw new Error('Model configuration not found')
  }
}

function normalizeContextMessage(
  message: Awaited<ReturnType<typeof getProject>>['conversations'][number]['agentMessages'][number],
  now: string,
) {
  const id = message.id ?? randomUUID()
  const { protection, manualProtected, ...current } = message
  return {
    ...current,
    id,
    createdAt: message.createdAt ?? now,
    pinnedToHot: message.pinnedToHot === true,
    representation: message.representation ?? 'original',
    truthRefs: message.truthRefs?.length ? message.truthRefs : [id],
  }
}

async function prepareContextDebugStorage(projectId: string, conversationId: string): Promise<void> {
  const project = await getProject(projectId)
  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) throw new Error('Conversation not found')
  const now = new Date().toISOString()
  const normalized = conversation.agentMessages.map((message) => normalizeContextMessage(message, now))
  await updateConversationAgentMessages(projectId, conversationId, () => normalized)
  await ensureConversationMessages(projectId, conversationId, normalized)
}
async function developProject(
  projectId: string,
  conversationId: string,
  content: string,
  onProgress?: (timeline: DevelopmentTimelineItem[]) => void,
  signal?: AbortSignal,
  startedAt = Date.now(),
): Promise<DevelopmentResult> {
  const normalizedContent = content.trim()
  if (!normalizedContent) return { writtenFiles: [], error: 'Enter a development request' }

  let project = await getProject(projectId)
  if (project.folders.length === 0) {
    return { project, writtenFiles: [], error: 'Add a project folder first' }
  }
  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) return { project, writtenFiles: [], error: 'Conversation not found' }

  const appConfig = await readConfig()
  const modelConfig = resolveModelConfig(appConfig, project, conversation)
  if (!modelConfig) {
    return { project, writtenFiles: [], error: 'Configure a model before sending a message' }
  }
  const contextConfig = structuredClone(
    resolveContextManagementConfig(appConfig, project, conversation),
  )
  if (contextConfig.safeOutputMargin >= modelConfig.modelMaxContext) {
    return { project, writtenFiles: [], error: 'Output token margin must be smaller than the model context window' }
  }

  await prepareContextDebugStorage(projectId, conversationId)
  project = await addMessage(
    projectId,
    conversationId,
    'user',
    normalizedContent,
    undefined,
    undefined,
    createModelConfigSnapshot(modelConfig),
    contextConfig,
    { startedAt, result: 'processing' },
  )
  const updatedConversation = project.conversations.find((item) => item.id === conversationId)
  if (!updatedConversation) return { project, writtenFiles: [], error: 'Conversation not found' }

  const userMessageId = updatedConversation.messages.at(-1)?.id
  if (!userMessageId) return { project, writtenFiles: [], error: 'Conversation message not found' }

  const roundId = randomUUID()
  const persistedHistory = contextConfig.layeredEnabled
    ? await readConversationWorkingSet(
        projectId,
        conversationId,
        contextConfig,
        normalizedContent,
        getRememberedWarmMessages(projectId, conversationId),
      )
    : await readConversationMessages(projectId, conversationId)
  const storedHistory = persistedHistory.length > 0
    ? persistedHistory
    : updatedConversation.agentMessages
  const result = await develop(
    project,
    modelConfig,
    contextConfig,
    [
      ...storedHistory,
      { id: randomUUID(), createdAt: new Date().toISOString(), role: 'user', content: normalizedContent },
    ],
    onProgress,
    (managed) => {
      const snapshot = buildContextDebugSnapshot(managed, contextConfig, randomUUID(), roundId)
      rememberSnapshot(projectId, conversationId, snapshot, [...managed.messages, ...managed.warmMessages], managed.summaryArtifacts)
    },
    { conversationId, signal },
  )
  project = await saveConversationContext(
    projectId,
    conversationId,
    result.agentMessages,
    result.context,
  )
  try {
    await persistContextDebugMessages(projectId, conversationId, result.agentMessages, result.summaryArtifacts)
  } catch (error) {
    log.warn('context.debug.persist.failed', error)
  }
  let pendingBlocks: AssistantMessageBlock[] = []
  const savePendingBlocks = async (): Promise<void> => {
    if (pendingBlocks.length === 0) return
    const messageBlocks = pendingBlocks
    const content = messageBlocks
      .filter((block) => block.type === 'content')
      .map((block) => block.content)
      .join('\n\n')
    pendingBlocks = []
    project = await addMessage(projectId, conversationId, 'assistant', content, messageBlocks)
  }
  for (const item of result.timeline) {
    if (item.type === 'block') {
      pendingBlocks.push(item.block)
      continue
    }
    await savePendingBlocks()
    project = await addMessage(projectId, conversationId, 'assistant', '', undefined, item.compression)
  }
  await savePendingBlocks()
  const turn: ConversationTurnRecord = {
    startedAt,
    endedAt: Date.now(),
    result: result.stopped ? 'stopped' : result.error ? (/timed out|timeout/i.test(result.error) ? 'timeout' : 'other') : 'normal',
    error: result.stopped ? undefined : result.error,
  }
  project = await updateConversationTurn(projectId, conversationId, userMessageId, turn)
  return { project, writtenFiles: result.writtenFiles, stopped: result.stopped, error: result.error }
}

function loadRenderer(window: BrowserWindow, query?: Record<string, string>): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value)
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), query ? { query } : undefined)
  }
}

function createMainWindow(): void {
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
  mainWindow = window
  window.on('closed', () => {
    mainWindow = null
    for (const debugWindow of contextDebugWindows.values()) debugWindow.close()
    contextDebugWindows.clear()
  })
  loadRenderer(window)
}

async function openContextDebugWindow(projectId: string, conversationId: string): Promise<void> {
  const config = await readConfig()
  if (!config.developerMode) throw new Error('Developer mode is disabled')
  const project = await getProject(projectId)
  if (!project.conversations.some((item) => item.id === conversationId)) {
    throw new Error('Conversation not found')
  }
  await prepareContextDebugStorage(projectId, conversationId)
  const key = conversationKey(projectId, conversationId)
  const existing = contextDebugWindows.get(key)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }
  const window = new BrowserWindow({
    width: 1320,
    height: 850,
    minWidth: 960,
    minHeight: 600,
    title: 'Codey Context Debugger',
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f5',
    parent: undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/index.js'),
    },
  })
  contextDebugWindows.set(key, window)
  window.on('closed', () => contextDebugWindows.delete(key))
  loadRenderer(window, { view: 'context-debug', projectId, conversationId })
}

app.whenReady().then(() => {
  ipcMain.handle('config:get', () => readConfig())
  ipcMain.handle('config:save', async (_event, config: AppConfig) => {
    ensureAllIdle()
    const saved = await saveConfig(config)
    updateKeepAwake(saved)
    return saved
  })
  ipcMain.handle('projects:get', () => getProjects())
  ipcMain.handle('projects:create', async (_event, name: string) => {
    const config = await readConfig()
    return createProject(name, config.activeModelConfigId)
  })
  ipcMain.handle('projects:add-folder', async (_event, projectId: string) => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    return addProjectFolder(projectId, result.filePaths[0])
  })
  ipcMain.handle('projects:set-model-config', async (_event, projectId: string, modelConfigId: string | null) => {
    ensureAllIdle()
    await validateModelConfigId(modelConfigId)
    return setProjectModelConfig(projectId, modelConfigId)
  })
  ipcMain.handle('projects:set-context-config', (_event, projectId: string, contextConfig: ContextManagementConfig | null) => {
    ensureAllIdle()
    return setProjectContextConfig(projectId, contextConfig)
  })
  ipcMain.handle('conversations:create', (_event, projectId: string) => createConversation(projectId))
  ipcMain.handle('conversations:set-model-config', async (_event, projectId: string, conversationId: string, modelConfigId: string | null) => {
    ensureIdle(projectId, conversationId)
    await validateModelConfigId(modelConfigId)
    return setConversationModelConfig(projectId, conversationId, modelConfigId)
  })
  ipcMain.handle('conversations:set-context-config', (_event, projectId: string, conversationId: string, contextConfig: ContextManagementConfig | null) => {
    ensureIdle(projectId, conversationId)
    return setConversationContextConfig(projectId, conversationId, contextConfig)
  })
  ipcMain.handle('development:send', async (event, projectId: string, conversationId: string, content: string) => {
    if (getConversationState(projectId, conversationId) !== 'idle') {
      return { writtenFiles: [], error: 'A conversation round or debug operation is already running' }
    }
    const key = conversationKey(projectId, conversationId)
    const controller = new AbortController()
    const startedAt = Date.now()
    conversationControllers.set(key, controller)
    setConversationState(projectId, conversationId, 'running')
    try {
      return await developProject(projectId, conversationId, content, (timeline) => {
        if (!event.sender.isDestroyed()) {
          const progress: DevelopmentProgress = { projectId, conversationId, timeline }
          event.sender.send('development:progress', progress)
        }
      }, controller.signal, startedAt)
    } finally {
      if (conversationControllers.get(key) === controller) {
        conversationControllers.delete(key)
      }
      setConversationState(projectId, conversationId, 'idle')
    }
  })
  ipcMain.handle('development:stop', (_event, projectId: string, conversationId: string) => {
    const controller = conversationControllers.get(conversationKey(projectId, conversationId))
    if (!controller) return false
    controller.abort()
    return true
  })

  ipcMain.handle('context-debug:open', (_event, projectId: string, conversationId: string) =>
    openContextDebugWindow(projectId, conversationId))
  ipcMain.handle('context-debug:overview', (_event, projectId: string, conversationId: string) =>
    getContextDebugOverview(projectId, conversationId, getConversationState(projectId, conversationId)))
  ipcMain.handle('context-debug:revision', (_event, projectId: string, conversationId: string) =>
    getContextDebugRevision(projectId, conversationId, getConversationState(projectId, conversationId)))
  ipcMain.handle('context-debug:read-cold', (_event, projectId: string, conversationId: string, messageId: string) =>
    readColdContextMessage(projectId, conversationId, messageId))
  ipcMain.handle('context-debug:read-layer', (_event, projectId: string, conversationId: string, messageId: string) =>
    readContextSnapshotMessage(projectId, conversationId, messageId))
  ipcMain.handle('context-debug:search', (_event, projectId: string, conversationId: string, query: string) =>
    runDebugOperation(projectId, conversationId, () => searchColdContext(projectId, conversationId, query)))
  ipcMain.handle('context-debug:set-pin', (_event, projectId: string, conversationId: string, messageId: string, pinnedToHot: boolean) =>
    runDebugOperation(projectId, conversationId, () => setContextPin(projectId, conversationId, messageId, pinnedToHot)))
  ipcMain.handle('context-debug:demote', (_event, projectId: string, conversationId: string, messageId?: string) =>
    runDebugOperation(projectId, conversationId, () => demoteContext(projectId, conversationId, messageId)))
  ipcMain.handle('context-debug:simulate', (_event, projectId: string, conversationId: string, requestTokens: number) =>
    runDebugOperation(projectId, conversationId, () => simulateTokenLimit(projectId, conversationId, requestTokens)))

  void readConfig()
    .then(updateKeepAwake)
    .catch((error) => log.warn('power.keep-awake.config.failed', error))

  createMainWindow()
  app.on('activate', () => {
    if (!mainWindow) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
