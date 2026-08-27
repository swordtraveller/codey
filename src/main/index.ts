import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, type Display, type NativeImage, type WebContents } from 'electron'
import { join } from 'node:path'
import type {
  AgentLimitsConfig,
  AppConfig,
  AssistantMessageBlock,
  ContextManagementConfig,
  ConversationRuntimeState,
  ConversationStateChange,
  ConversationTurnRecord,
  DevelopmentProgress,
  DevelopmentProgressState,
  DevelopmentProgressUpdate,
  DevelopmentResult,
  ImageAttachment,
  ScreenshotSelection,
  ScreenshotSource,
  Conversation,
  Project,
} from '../shared/types'
import { validateImageAttachments } from '../shared/image-attachments'
import {
  applyDevelopmentProgressUpdate,
  compactDevelopmentProgressUpdate,
  createDevelopmentProgressState,
} from '../shared/development-progress'
import { buildAgentContext, develop } from './agent'
import { readConfig, saveConfig } from './config'
import { resolveContextManagementConfig } from './context-config'
import {
  buildContextDebugSnapshot,
  demoteContext,
  getContextDebugOverview,
  getContextDebugRevision,
  getPromotedHotMessages,
  getRememberedWarmMessages,
  hasContextDebugSnapshot,
  persistContextDebugMessages,
  promoteContext,
  readColdContextMessage,
  readContextSnapshotMessage,
  rememberInitializedSnapshot,
  rememberSnapshot,
  searchColdContext,
  setContextPin,
  simulateTokenLimit,
  unpinLowestPriorityContext,
} from './context-debug'
import {
  appendConversationMessages,
  ensureConversationMessages,
  readConversationMessages,
  readConversationWorkingSet,
} from './conversation-store'
import { log } from './logger'
import { BridgeHandoverService } from './bridge'
import { getFrontendServer, onFrontendServerEnded, stopAllFrontendServers } from './frontend-runtime'
import { captureDisplay, copyImageToClipboard, createImageAttachment, cropScreenshot } from './screenshot'
import { closeAllPreviewWindows, closePreviewWindow, openPreviewWindow } from './preview-window'
import { createModelConfigSnapshot, resolveModelConfig } from './model-config'
import {
  addMessage,
  addProjectFolder,
  createConversation,
  createProject,
  getProject,
  getProjects,
  saveConversationContext,
  setConversationAgentLimits,
  setConversationContextConfig,
  setConversationModelConfig,
  setProjectContextConfig,
  setProjectModelConfig,
  updateConversationAgentMessages,
  updateConversationTurn,
} from './workspace'

const conversationStates = new Map<string, ConversationRuntimeState>()
const conversationControllers = new Map<string, AbortController>()
const developmentProgressStates = new Map<string, DevelopmentProgressState>()
const developmentProgressSubscriptions = new Map<number, string>()
const contextDebugWindows = new Map<string, BrowserWindow>()
type PendingScreenshot = {
  window: BrowserWindow
  image: NativeImage
  display: Display
  restoreWindow: () => void
  resolve: (selection: ScreenshotSelection | null) => void
}
const pendingScreenshots = new Map<string, PendingScreenshot>()
onFrontendServerEnded(closePreviewWindow)
let mainWindow: BrowserWindow | null = null
let keepAwakeBlockerId: number | null = null
let keepAwakeEnabled = false
let keepAwakeOnlyWhileWorking = true
const bridgeHandover = new BridgeHandoverService()
let bridgePollInFlight = false

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

function publishDevelopmentProgress(
  sender: WebContents,
  projectId: string,
  conversationId: string,
  update: DevelopmentProgressUpdate,
): void {
  const key = conversationKey(projectId, conversationId)
  const current = developmentProgressStates.get(key) ?? createDevelopmentProgressState()
  const transportUpdate = compactDevelopmentProgressUpdate(current, update)
  const next = applyDevelopmentProgressUpdate(current, update)
  developmentProgressStates.set(key, next)

  if (
    transportUpdate &&
    developmentProgressSubscriptions.get(sender.id) === key &&
    !sender.isDestroyed()
  ) {
    const progress: DevelopmentProgress = { projectId, conversationId, update: transportUpdate }
    sender.send('development:progress', progress)
  }
}

function subscribeDevelopmentProgress(
  sender: WebContents,
  projectId: string | null,
  conversationId: string | null,
): DevelopmentProgressState {
  if (!projectId || !conversationId) {
    developmentProgressSubscriptions.delete(sender.id)
    return createDevelopmentProgressState()
  }
  const key = conversationKey(projectId, conversationId)
  developmentProgressSubscriptions.set(sender.id, key)
  return developmentProgressStates.get(key) ?? createDevelopmentProgressState()
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
  images: ImageAttachment[] = [],
  onProgress?: (update: DevelopmentProgressUpdate) => void,
  signal?: AbortSignal,
  startedAt = Date.now(),
  onProjectUpdated?: (project: Project) => Promise<void> | void,
): Promise<DevelopmentResult> {
  const normalizedContent = content.trim()
  const imageError = validateImageAttachments(images)
  if (imageError) return { writtenFiles: [], error: 'Invalid image attachment' }
  if (!normalizedContent && images.length === 0) return { writtenFiles: [], error: 'Enter a development request' }

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
  const allowCustomStrategy = appConfig.developerMode && conversation.contextConfigOverride !== null
  const agentLimits = structuredClone(conversation.agentLimits)
  if (contextConfig.safeOutputMargin >= modelConfig.modelMaxContext) {
    return { project, writtenFiles: [], error: 'Output token margin must be smaller than the model context window' }
  }

  await prepareContextDebugStorage(projectId, conversationId)
  const userMessageId = randomUUID()
  const currentUserMessage = {
    id: userMessageId,
    createdAt: new Date().toISOString(),
    role: 'user' as const,
    content: normalizedContent,
    images,
  }
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
    images,
    userMessageId,
  )
  await appendConversationMessages(projectId, conversationId, [currentUserMessage])
  // 先发布已持久化的用户消息，再开始远端模型请求，避免远端发送端长期只看到“处理中”。
  await onProjectUpdated?.(project)

  const roundId = randomUUID()
  const requestHistory = contextConfig.layeredEnabled
    ? await readConversationWorkingSet(
        projectId,
        conversationId,
        contextConfig,
        normalizedContent,
        [...conversation.agentMessages.filter((message) => message.contextLayer === 'warm'), ...getRememberedWarmMessages(projectId, conversationId)],
        getPromotedHotMessages(projectId, conversationId),
        conversation.agentMessages.filter((message) => message.contextLayer !== 'warm'),
        userMessageId,
      )
    : await readConversationMessages(projectId, conversationId)
  if (!requestHistory.some((message) => message.id === userMessageId && message.role === 'user')) {
    return { project, writtenFiles: [], error: 'Latest user message is missing from the conversation working set' }
  }
  const result = await develop(
    project,
    modelConfig,
    contextConfig,
    agentLimits,
    requestHistory,
    onProgress,
    (managed) => {
      const snapshot = buildContextDebugSnapshot(managed, contextConfig, randomUUID(), roundId)
      rememberSnapshot(projectId, conversationId, snapshot, [...managed.messages, ...managed.warmMessages], managed.summaryArtifacts)
    },
    {
      conversationId,
      signal,
      latestUserMessageId: userMessageId,
      allowCustomStrategy,
    },
    appConfig.networkAccessEnabled,
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

async function processBridgeMessage(message: import('../shared/bridge').HandoverUserMessage): Promise<boolean> {
  if (getConversationState(message.projectId, message.conversationId) !== 'idle') return false
  const key = conversationKey(message.projectId, message.conversationId)
  const controller = new AbortController()
  const publishProject = async (project: Project): Promise<void> => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('project:updated', project)
    try {
      await bridgeHandover.sync(await getProjects())
    } catch (error) {
      // 同步失败不能导致消息事件重复消费，否则会重复写入用户消息。
      log.warn('bridge.sync.failed', error)
    }
  }
  conversationControllers.set(key, controller)
  setConversationState(message.projectId, message.conversationId, 'running')
  try {
    // developProject 在写入用户消息后立即调用 publishProject；模型完成后再发布含回复的完整快照。
    const result = await developProject(
      message.projectId,
      message.conversationId,
      message.content,
      [],
      undefined,
      controller.signal,
      Date.now(),
      publishProject,
    )
    if (result.project) await publishProject(result.project)
    if (result.error || result.stopped) {
      log.warn('bridge.event.development.incomplete', { projectId: message.projectId, conversationId: message.conversationId, error: result.error, stopped: result.stopped })
    }
    // 事件只应被处理一次；否则同步失败或模型报错会导致重复消费并重复写入用户消息。
    return true
  } finally {
    if (conversationControllers.get(key) === controller) conversationControllers.delete(key)
    setConversationState(message.projectId, message.conversationId, 'idle')
  }
}

async function pollBridge(): Promise<void> {
  if (bridgePollInFlight) return
  bridgePollInFlight = true
  try { await bridgeHandover.processEvents(processBridgeMessage) }
  catch (error) { log.warn('bridge.poll.failed', error) }
  finally { bridgePollInFlight = false }
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
    developmentProgressSubscriptions.delete(window.webContents.id)
    mainWindow = null
    for (const debugWindow of contextDebugWindows.values()) debugWindow.close()
    contextDebugWindows.clear()
    closeAllPendingScreenshots()
    closeAllPreviewWindows()
  })
  loadRenderer(window)
}

function sendScreenshotSource(pending: PendingScreenshot, captureId: string): void {
  if (pending.window.isDestroyed()) return
  const size = pending.image.getSize()
  const source: ScreenshotSource = {
    captureId,
    dataUrl: `data:image/jpeg;base64,${pending.image.toJPEG(85).toString('base64')}`,
    width: size.width,
    height: size.height,
    scaleX: size.width / pending.display.bounds.width,
    scaleY: size.height / pending.display.bounds.height,
  }
  pending.window.webContents.send('screenshot:source', source)
}

function closePendingScreenshot(captureId: string, selection: ScreenshotSelection | null): void {
  const pending = pendingScreenshots.get(captureId)
  if (!pending) return
  pendingScreenshots.delete(captureId)
  pending.restoreWindow()
  pending.resolve(selection)
  if (!pending.window.isDestroyed()) pending.window.close()
}

function closeAllPendingScreenshots(): void {
  for (const captureId of [...pendingScreenshots.keys()]) closePendingScreenshot(captureId, null)
}

async function selectScreenshotArea(
  image: NativeImage,
  display: Display,
  restoreWindow: () => void,
): Promise<ScreenshotSelection | null> {
  const captureId = randomUUID()
  const window = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    backgroundColor: '#111111',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/index.js'),
    },
  })
  window.setAlwaysOnTop(true, 'screen-saver')

  return new Promise((resolve) => {
    pendingScreenshots.set(captureId, { window, image, display, restoreWindow, resolve })
    window.once('closed', () => closePendingScreenshot(captureId, null))
    loadRenderer(window, { view: 'screenshot-overlay' })
  })
}

async function initializeContextDebugContext(
  projectId: string,
  conversationId: string,
  project: Project,
  conversation: Conversation,
  appConfig: AppConfig,
): Promise<void> {
  if (getConversationState(projectId, conversationId) !== 'idle') return
  if (hasContextDebugSnapshot(projectId, conversationId)) return

  const modelConfig = resolveModelConfig(appConfig, project, conversation)
  if (!modelConfig) return
  const contextConfig = structuredClone(
    resolveContextManagementConfig(appConfig, project, conversation),
  )
  const history = contextConfig.layeredEnabled
    ? await readConversationWorkingSet(
        projectId,
        conversationId,
        contextConfig,
        '',
        [...conversation.agentMessages.filter((message) => message.contextLayer === 'warm'), ...getRememberedWarmMessages(projectId, conversationId)],
        getPromotedHotMessages(projectId, conversationId),
        conversation.agentMessages.filter((message) => message.contextLayer !== 'warm'),
      )
    : await readConversationMessages(projectId, conversationId)
  const managed = buildAgentContext(project, modelConfig, contextConfig, history, appConfig.networkAccessEnabled, { allow: appConfig.developerMode && conversation.contextConfigOverride !== null })
  const snapshot = buildContextDebugSnapshot(managed, contextConfig, randomUUID(), randomUUID())
  rememberInitializedSnapshot(
    projectId,
    conversationId,
    snapshot,
    [...managed.messages, ...managed.warmMessages],
  )
}
async function openContextDebugWindow(projectId: string, conversationId: string): Promise<void> {
  const config = await readConfig()
  if (!config.developerMode) throw new Error('Developer mode is disabled')
  const project = await getProject(projectId)
  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) {
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
  await initializeContextDebugContext(projectId, conversationId, project, conversation, config)
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
  ipcMain.handle(
    'development:subscribe',
    (event, projectId: string | null, conversationId: string | null) =>
      subscribeDevelopmentProgress(event.sender, projectId, conversationId),
  )
  ipcMain.handle('config:save', async (_event, config: AppConfig) => {
    ensureAllIdle()
    const saved = await saveConfig(config)
    updateKeepAwake(saved)
    return saved
  })
  ipcMain.handle('projects:get', () => getProjects())
  ipcMain.handle('bridge:status', () => bridgeHandover.status())
  ipcMain.handle('bridge:create', async (_event, bridgeUrl: string) => bridgeHandover.createChannel(bridgeUrl))
  ipcMain.handle('bridge:approve', async (_event, channelId: string, requestId: string, devicePublicKey: JsonWebKey) => {
    await bridgeHandover.approve(channelId, requestId, devicePublicKey, await getProjects())
    return bridgeHandover.status()
  })
  ipcMain.handle('bridge:reject', async (_event, channelId: string, requestId: string) => {
    await bridgeHandover.reject(channelId, requestId)
    return bridgeHandover.status()
  })
  ipcMain.handle('bridge:sync', async (_event, channelId?: string) => {
    await bridgeHandover.sync(await getProjects(), channelId)
    return bridgeHandover.status()
  })
  ipcMain.handle('bridge:refresh', async (_event, channelId: string) => bridgeHandover.refreshEnrollment(channelId))
  ipcMain.handle('bridge:remove', async (_event, channelId: string) => {
    await bridgeHandover.removeChannel(channelId)
    return bridgeHandover.status()
  })
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
  ipcMain.handle('conversations:set-agent-limits', (_event, projectId: string, conversationId: string, agentLimits: AgentLimitsConfig) => {
    ensureIdle(projectId, conversationId)
    return setConversationAgentLimits(projectId, conversationId, agentLimits)
  })
  ipcMain.handle('clipboard:screenshot', async (_event, hideWindow: boolean) => {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is unavailable')
    const captured = await captureDisplay(mainWindow, hideWindow)
    try {
      const selection = await selectScreenshotArea(
        captured.image,
        captured.display,
        captured.restoreWindow,
      )
      if (!selection) return null
      const image = cropScreenshot(captured.image, selection, captured.display)
      copyImageToClipboard(image)
      return createImageAttachment(image)
    } finally {
      captured.restoreWindow()
    }
  })
  ipcMain.on('clipboard:screenshot-ready', (event) => {
    const entry = [...pendingScreenshots.entries()]
      .find(([, pending]) => event.sender === pending.window.webContents)
    if (entry) sendScreenshotSource(entry[1], entry[0])
  })
  ipcMain.on('clipboard:screenshot-complete', (event, captureId: string, selection: ScreenshotSelection) => {
    const pending = pendingScreenshots.get(captureId)
    if (!pending || event.sender !== pending.window.webContents) return
    closePendingScreenshot(captureId, selection)
  })
  ipcMain.on('clipboard:screenshot-cancel', (event, captureId: string) => {
    const pending = pendingScreenshots.get(captureId)
    if (!pending || event.sender !== pending.window.webContents) return
    closePendingScreenshot(captureId, null)
  })

  ipcMain.handle('development:send', async (event, projectId: string, conversationId: string, content: string, images: ImageAttachment[] = []) => {
    if (getConversationState(projectId, conversationId) !== 'idle') {
      return { writtenFiles: [], error: 'A conversation round or debug operation is already running' }
    }
    const key = conversationKey(projectId, conversationId)
    const controller = new AbortController()
    const startedAt = Date.now()
    conversationControllers.set(key, controller)
    publishDevelopmentProgress(event.sender, projectId, conversationId, { type: 'reset' })
    setConversationState(projectId, conversationId, 'running')
    try {
      const result = await developProject(projectId, conversationId, content, images, (update) => {
        publishDevelopmentProgress(event.sender, projectId, conversationId, update)
      }, controller.signal, startedAt)
      if (!result.error && !result.stopped) {
        void bridgeHandover.sync(await getProjects()).catch((error) => log.warn('bridge.sync.failed', error))
      }
      return result
    } finally {
      developmentProgressStates.delete(key)
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
  ipcMain.handle('frontend:open-preview', (_event, projectId: string, conversationId: string, serverId: string) => {
    const server = getFrontendServer(projectId, conversationId, serverId)
    if (server.status === 'starting') return { status: 'starting' as const }
    if (server.status === 'failed') return { status: 'failed' as const }
    if (server.status === 'stopped') return { status: 'stopped' as const }
    if (!server.previewUrl) return { status: 'starting' as const }
    openPreviewWindow(server.serverId, server.previewUrl)
    return { status: 'opened' as const }
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
  ipcMain.handle('context-debug:promote', (_event, projectId: string, conversationId: string, messageId: string) =>
    runDebugOperation(projectId, conversationId, () => promoteContext(projectId, conversationId, messageId)))
  ipcMain.handle('context-debug:set-pin', (_event, projectId: string, conversationId: string, messageId: string, pinnedToHot: boolean) =>
    runDebugOperation(projectId, conversationId, () => setContextPin(projectId, conversationId, messageId, pinnedToHot)))
  ipcMain.handle('context-debug:demote', (_event, projectId: string, conversationId: string, messageId?: string) =>
    runDebugOperation(projectId, conversationId, () => demoteContext(projectId, conversationId, messageId)))
  ipcMain.handle('context-debug:unpin-lowest', (_event, projectId: string, conversationId: string) =>
    runDebugOperation(projectId, conversationId, () => unpinLowestPriorityContext(projectId, conversationId)))
  ipcMain.handle('context-debug:simulate', (_event, projectId: string, conversationId: string, requestTokens: number) =>
    runDebugOperation(projectId, conversationId, () => simulateTokenLimit(projectId, conversationId, requestTokens)))

  void readConfig()
    .then(updateKeepAwake)
    .catch((error) => log.warn('power.keep-awake.config.failed', error))

  void pollBridge()
  setInterval(() => void pollBridge(), 4_000)
  createMainWindow()
  app.on('activate', () => {
    if (!mainWindow) createMainWindow()
  })
})

let frontendShutdownStarted = false
app.on('will-quit', (event) => {
  if (frontendShutdownStarted) return
  frontendShutdownStarted = true
  event.preventDefault()
  closeAllPendingScreenshots()
  closeAllPreviewWindows()
  void stopAllFrontendServers().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
