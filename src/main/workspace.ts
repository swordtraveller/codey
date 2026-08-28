import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  defaultAgentLimitsConfig,
  type AgentContextMessage,
  type AgentLimitsConfig,
  type AssistantMessageBlock,
  type ChatMessage,
  type ContextCompressionNotice,
  type ContextManagementConfig,
  type ConversationTurnRecord,
  type Conversation,
  type ImageAttachment,
  type ModelConfigSnapshot,
  type Project,
  type ProjectFolder,
} from '../shared/types'
import { isValidAgentLimitsConfig, normalizeAgentLimitsConfig } from './agent-limits'
import { log } from './logger'
import { isValidContextManagementConfig, normalizeContextManagementConfig } from './context-config'
import {
  hydrateImageAttachments,
  imageReferences,
  persistImageAttachments,
  type StoredImageReference,
} from './image-store'

type PersistedChatMessage = Omit<ChatMessage, 'images'> & {
  images?: ImageAttachment[] | StoredImageReference[]
}
type PersistedAgentMessage = Omit<AgentContextMessage, 'images'> & {
  images?: ImageAttachment[] | StoredImageReference[]
}
type StoredConversation = Omit<Conversation, 'messages' | 'agentMessages' | 'modelConfigId' | 'contextConfigOverride' | 'agentLimits'> & {
  messages: PersistedChatMessage[]
  agentMessages?: PersistedAgentMessage[]
  modelConfigId?: string | null
  contextConfigOverride?: Partial<ContextManagementConfig> | null
  agentLimits?: Partial<AgentLimitsConfig>
}
type LegacyStoredProject = Omit<
  Project,
  'defaultModelConfigId' | 'contextConfigOverride' | 'folders' | 'pythonEnvironmentFolderId' | 'conversations'
> & {
  defaultModelConfigId?: string | null
  contextConfigOverride?: Partial<ContextManagementConfig> | null
  folders: Array<ProjectFolder | string>
  pythonEnvironmentFolderId?: string | null
  conversations: StoredConversation[]
}
type StoredProjectMetadata = Omit<Project, 'conversations' | 'defaultModelConfigId' | 'contextConfigOverride' | 'folders' | 'pythonEnvironmentFolderId'> & {
  defaultModelConfigId?: string | null
  contextConfigOverride?: Partial<ContextManagementConfig> | null
  folders: Array<ProjectFolder | string>
  pythonEnvironmentFolderId?: string | null
  conversationIds: string[]
}
type WorkspaceManifest = { version: 2; projectIds: string[] }

let projects: Project[] | undefined
let projectsLoad: Promise<Project[]> | undefined
let loadedUserDataPath: string | undefined
let writeQueues = new Map<string, Promise<void>>()

function userDataPath(): string {
  const current = app.getPath('userData')
  if (loadedUserDataPath !== current) {
    loadedUserDataPath = current
    projects = undefined
    projectsLoad = undefined
    writeQueues = new Map<string, Promise<void>>()
  }
  return current
}

function getWorkspacePath(): string {
  return join(userDataPath(), 'workspace.json')
}

function storageRoot(): string {
  return join(userDataPath(), 'workspace-data')
}

function key(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url') || 'empty'
}

function projectPath(projectId: string): string {
  return join(storageRoot(), 'projects', key(projectId), 'project.json')
}

function conversationPath(projectId: string, conversationId: string): string {
  return join(storageRoot(), 'projects', key(projectId), 'conversations', `${key(conversationId)}.json`)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify(value), 'utf8')
    // A forced exit can leave the temporary file behind, but never a truncated live shard.
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWorkspaceManifest(value: unknown): value is WorkspaceManifest {
  return isRecord(value)
    && value.version === 2
    && Array.isArray(value.projectIds)
    && value.projectIds.every((projectId) => typeof projectId === 'string')
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function quarantineBrokenFile(path: string, error: unknown): Promise<void> {
  const quarantinedPath = `${path}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`
  await rename(path, quarantinedPath).catch((renameError: NodeJS.ErrnoException) => {
    if (!isMissingFile(renameError)) throw renameError
  })
  log.warn('workspace.storage.quarantined', {
    path,
    quarantinedPath,
    error: error instanceof Error ? error.message : String(error),
  })
}

async function discoverProjectIds(): Promise<string[]> {
  const projectsDirectory = join(storageRoot(), 'projects')
  try {
    const entries = await readdir(projectsDirectory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        directoryName: entry.name,
        projectId: Buffer.from(entry.name, 'base64url').toString('utf8'),
      }))
      .filter(({ directoryName, projectId }) => projectId.length > 0 && key(projectId) === directoryName)
      .map(({ projectId }) => projectId)
      .sort()
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }
}

function serializeWrite<T>(scope: string, operation: () => Promise<T>): Promise<T> {
  userDataPath()
  const previous = writeQueues.get(scope) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const settled = result.then(() => undefined, () => undefined)
  writeQueues.set(scope, settled)
  void settled.then(() => {
    if (writeQueues.get(scope) === settled) writeQueues.delete(scope)
  })
  return result
}

async function awaitPendingWrites(): Promise<void> {
  while (writeQueues.size > 0) await Promise.all([...writeQueues.values()])
}

function projectWriteScope(projectId: string): string {
  return `project:${projectId}`
}

function conversationWriteScope(projectId: string, conversationId: string): string {
  return `conversation:${projectId}:${conversationId}`
}

function normalizeOverride(
  value: Partial<ContextManagementConfig> | null | undefined,
): ContextManagementConfig | null {
  return value ? normalizeContextManagementConfig(value) : null
}

function normalizeStoredAgentLimits(
  value: Partial<AgentLimitsConfig> | undefined,
): AgentLimitsConfig {
  const normalized = normalizeAgentLimitsConfig(value)
  return isValidAgentLimitsConfig(normalized)
    ? normalized
    : { ...defaultAgentLimitsConfig }
}

function validateOverride(contextConfig: ContextManagementConfig | null): ContextManagementConfig | null {
  if (!contextConfig) return null
  const normalized = normalizeContextManagementConfig(contextConfig)
  if (!isValidContextManagementConfig(normalized)) throw new Error('Enter valid context settings')
  return normalized
}

async function normalizeConversation(value: StoredConversation): Promise<Conversation> {
  const messages = await Promise.all(value.messages.map(async (message) => ({
    ...message,
    images: await hydrateImageAttachments(message.images),
  })))
  const storedAgentMessages = value.agentMessages ?? value.messages.map(({ role, content, images }) => ({ role, content, images }))
  const agentMessages = await Promise.all(storedAgentMessages.map(async (message) => ({
    ...message,
    images: await hydrateImageAttachments(message.images),
  })))
  return {
    ...value,
    modelConfigId: value.modelConfigId ?? null,
    contextConfigOverride: normalizeOverride(value.contextConfigOverride),
    agentLimits: normalizeStoredAgentLimits(value.agentLimits),
    messages,
    agentMessages,
  }
}

async function normalizeProjectMetadata(
  value: StoredProjectMetadata,
  conversations: Conversation[],
): Promise<Project> {
  const folders = value.folders.map((folder) =>
    typeof folder === 'string' ? { id: randomUUID(), path: folder } : folder,
  )
  const configuredFolder = folders.some((folder) => folder.id === value.pythonEnvironmentFolderId)
  return {
    id: value.id,
    name: value.name,
    defaultModelConfigId: value.defaultModelConfigId ?? null,
    contextConfigOverride: normalizeOverride(value.contextConfigOverride),
    folders,
    conversations,
    pythonEnvironmentFolderId: configuredFolder
      ? (value.pythonEnvironmentFolderId ?? null)
      : (folders[0]?.id ?? null),
  }
}

async function persistImagesForConversation(projectId: string, conversation: Conversation): Promise<void> {
  for (const message of [...conversation.messages, ...conversation.agentMessages]) {
    await persistImageAttachments(projectId, conversation.id, message.images)
  }
}

function storedConversation(projectId: string, conversation: Conversation): StoredConversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      images: imageReferences(projectId, conversation.id, message.images),
    })),
    agentMessages: conversation.agentMessages.map((message) => ({
      ...message,
      images: imageReferences(projectId, conversation.id, message.images),
    })),
  }
}

function storedProjectMetadata(project: Project): StoredProjectMetadata {
  const { conversations, ...metadata } = project
  return { ...metadata, conversationIds: conversations.map((conversation) => conversation.id) }
}

async function persistConversation(projectId: string, conversation: Conversation): Promise<void> {
  await writeJson(conversationPath(projectId, conversation.id), storedConversation(projectId, conversation))
}

async function persistProjectMetadata(project: Project): Promise<void> {
  await writeJson(projectPath(project.id), storedProjectMetadata(project))
}

async function persistManifest(currentProjects: Project[]): Promise<void> {
  const manifest: WorkspaceManifest = { version: 2, projectIds: currentProjects.map((project) => project.id) }
  await writeJson(getWorkspacePath(), manifest)
}

async function migrateLegacyProjects(stored: LegacyStoredProject[]): Promise<Project[]> {
  const migrated: Project[] = []
  for (const value of stored) {
    const conversations = await Promise.all(value.conversations.map(normalizeConversation))
    const project = await normalizeProjectMetadata({
      ...value,
      conversationIds: conversations.map((conversation) => conversation.id),
    }, conversations)
    for (const conversation of project.conversations) {
      await persistImagesForConversation(project.id, conversation)
      await persistConversation(project.id, conversation)
    }
    await persistProjectMetadata(project)
    migrated.push(project)
  }
  await persistManifest(migrated)
  return migrated
}

type ShardedLoadResult = {
  projects: Project[]
  repaired: boolean
}

async function loadShardedProjects(manifest: WorkspaceManifest): Promise<ShardedLoadResult> {
  const loaded: Project[] = []
  let repaired = false
  for (const projectId of manifest.projectIds) {
    let projectRepaired = false
    const metadataPath = projectPath(projectId)
    let metadata: StoredProjectMetadata
    try {
      const parsed = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown
      if (
        !isRecord(parsed)
        || parsed.id !== projectId
        || typeof parsed.name !== 'string'
        || !Array.isArray(parsed.folders)
        || !Array.isArray(parsed.conversationIds)
      ) throw new Error('Invalid project metadata')
      metadata = parsed as StoredProjectMetadata
    } catch (error) {
      if (!isMissingFile(error)) await quarantineBrokenFile(metadataPath, error)
      log.warn('workspace.project.skipped', { projectId, error: error instanceof Error ? error.message : String(error) })
      projectRepaired = true
      repaired = true
      continue
    }

    const conversations: Conversation[] = []
    for (const conversationId of metadata.conversationIds) {
      if (typeof conversationId !== 'string') {
        projectRepaired = true
        repaired = true
        continue
      }
      const storedPath = conversationPath(projectId, conversationId)
      try {
        const parsed = JSON.parse(await readFile(storedPath, 'utf8')) as unknown
        if (!isRecord(parsed) || !Array.isArray(parsed.messages)) throw new Error('Invalid conversation data')
        conversations.push(await normalizeConversation(parsed as StoredConversation))
      } catch (error) {
        if (!isMissingFile(error)) await quarantineBrokenFile(storedPath, error)
        log.warn('workspace.conversation.skipped', {
          projectId,
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        })
        projectRepaired = true
        repaired = true
      }
    }

    try {
      const project = await normalizeProjectMetadata(metadata, conversations)
      if (project.conversations.length === 0) {
        const replacement = createConversationRecord(1)
        project.conversations.push(replacement)
        await persistConversation(project.id, replacement)
        projectRepaired = true
        repaired = true
      }
      if (project.conversations.length !== metadata.conversationIds.length) {
        projectRepaired = true
        repaired = true
      }
      if (projectRepaired) await persistProjectMetadata(project)
      loaded.push(project)
    } catch (error) {
      await quarantineBrokenFile(metadataPath, error)
      log.warn('workspace.project.skipped', { projectId, error: error instanceof Error ? error.message : String(error) })
      projectRepaired = true
      repaired = true
    }
  }
  return { projects: loaded, repaired }
}

async function recoverShardedProjects(reason: unknown): Promise<Project[]> {
  const projectIds = await discoverProjectIds()
  const recovered = await loadShardedProjects({ version: 2, projectIds })
  await persistManifest(recovered.projects)
  log.warn('workspace.storage.recovered', {
    projectCount: recovered.projects.length,
    reason: reason instanceof Error ? reason.message : String(reason),
  })
  return recovered.projects
}

async function loadProjects(): Promise<Project[]> {
  userDataPath()
  if (projects) return projects
  if (projectsLoad) return projectsLoad
  projectsLoad = (async () => {
    const workspacePath = getWorkspacePath()
    try {
      const stored = JSON.parse(await readFile(workspacePath, 'utf8')) as unknown
      if (Array.isArray(stored)) {
        projects = await migrateLegacyProjects(stored as LegacyStoredProject[])
      } else if (isWorkspaceManifest(stored)) {
        const loaded = await loadShardedProjects(stored)
        projects = loaded.projects
        if (loaded.repaired) await persistManifest(projects)
      } else {
        throw new Error('Invalid workspace manifest')
      }
    } catch (error) {
      if (isMissingFile(error)) {
        const projectIds = await discoverProjectIds()
        projects = projectIds.length === 0 ? [] : await recoverShardedProjects(new Error('Workspace manifest was missing'))
      } else {
        await quarantineBrokenFile(workspacePath, error)
        projects = await recoverShardedProjects(error)
      }
    }
    return projects
  })()
  try {
    return await projectsLoad
  } finally {
    projectsLoad = undefined
  }
}

function createConversationRecord(index: number): Conversation {
  return {
    id: randomUUID(),
    title: `Conversation ${index}`,
    modelConfigId: null,
    contextConfigOverride: null,
    agentLimits: { ...defaultAgentLimitsConfig },
    messages: [],
    agentMessages: [],
  }
}

async function findProject(projectId: string): Promise<Project> {
  const project = (await loadProjects()).find((item) => item.id === projectId)
  if (!project) throw new Error('Project not found')
  return project
}

function findConversation(project: Project, conversationId: string): Conversation {
  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) throw new Error('Conversation not found')
  return conversation
}

export async function getProjects(): Promise<Project[]> {
  await awaitPendingWrites()
  return loadProjects()
}

/**
 * Returns the in-memory workspace without waiting for queued disk writes.
 * Callers must use this only when they explicitly accept a live snapshot.
 */
export async function getProjectsLive(): Promise<Project[]> {
  return loadProjects()
}

export async function getProject(projectId: string): Promise<Project> {
  await awaitPendingWrites()
  return findProject(projectId)
}

/**
 * Returns a project from the live in-memory workspace.
 * This is intentionally separate from getProject(), whose contract includes
 * waiting for durable writes to settle.
 */
export async function getProjectLive(projectId: string): Promise<Project> {
  return findProject(projectId)
}

export function createProject(name: string, defaultModelConfigId: string | null = null): Promise<Project> {
  return serializeWrite('manifest', async () => {
    const normalizedName = name.trim()
    if (!normalizedName) throw new Error('Enter a project name')
    const project: Project = {
      id: randomUUID(),
      name: normalizedName,
      defaultModelConfigId,
      contextConfigOverride: null,
      folders: [],
      pythonEnvironmentFolderId: null,
      conversations: [createConversationRecord(1)],
    }
    const currentProjects = await loadProjects()
    currentProjects.push(project)
    await persistConversation(project.id, project.conversations[0])
    await persistProjectMetadata(project)
    await persistManifest(currentProjects)
    return project
  })
}

export function addProjectFolder(projectId: string, folderPath: string): Promise<Project> {
  return serializeWrite(projectWriteScope(projectId), async () => {
    const project = await findProject(projectId)
    const exists = project.folders.some((current) => current.path.toLowerCase() === folderPath.toLowerCase())
    if (!exists) {
      const folder = { id: randomUUID(), path: folderPath }
      project.folders.push(folder)
      project.pythonEnvironmentFolderId ??= folder.id
      await persistProjectMetadata(project)
    }
    return project
  })
}

export function setProjectModelConfig(projectId: string, modelConfigId: string | null): Promise<Project> {
  return serializeWrite(projectWriteScope(projectId), async () => {
    const project = await findProject(projectId)
    project.defaultModelConfigId = modelConfigId
    await persistProjectMetadata(project)
    return project
  })
}

export function setProjectContextConfig(projectId: string, contextConfig: ContextManagementConfig | null): Promise<Project> {
  return serializeWrite(projectWriteScope(projectId), async () => {
    const project = await findProject(projectId)
    project.contextConfigOverride = validateOverride(contextConfig)
    await persistProjectMetadata(project)
    return project
  })
}

export function createConversation(projectId: string): Promise<Project> {
  return serializeWrite(projectWriteScope(projectId), async () => {
    const project = await findProject(projectId)
    const conversation = createConversationRecord(project.conversations.length + 1)
    project.conversations.push(conversation)
    await persistConversation(project.id, conversation)
    await persistProjectMetadata(project)
    return project
  })
}

export function setConversationModelConfig(projectId: string, conversationId: string, modelConfigId: string | null): Promise<Project> {
  return serializeWrite(conversationWriteScope(projectId, conversationId), async () => {
    const project = await findProject(projectId)
    const conversation = findConversation(project, conversationId)
    conversation.modelConfigId = modelConfigId
    await persistConversation(projectId, conversation)
    return project
  })
}

export function setConversationContextConfig(projectId: string, conversationId: string, contextConfig: ContextManagementConfig | null): Promise<Project> {
  return serializeWrite(conversationWriteScope(projectId, conversationId), async () => {
    const project = await findProject(projectId)
    const conversation = findConversation(project, conversationId)
    conversation.contextConfigOverride = validateOverride(contextConfig)
    await persistConversation(projectId, conversation)
    return project
  })
}

export function setConversationAgentLimits(projectId: string, conversationId: string, agentLimits: AgentLimitsConfig): Promise<Project> {
  return serializeWrite(conversationWriteScope(projectId, conversationId), async () => {
    const normalized = normalizeAgentLimitsConfig(agentLimits)
    if (!isValidAgentLimitsConfig(normalized)) throw new Error('Enter valid Agent limits')
    const project = await findProject(projectId)
    const conversation = findConversation(project, conversationId)
    conversation.agentLimits = normalized
    await persistConversation(projectId, conversation)
    return project
  })
}

/**
 * Appends a message to the live workspace immediately and schedules its durable
 * write on the same conversation queue. The returned project is safe to publish
 * before image/file persistence completes.
 */
export async function addMessageImmediately(
  projectId: string,
  conversationId: string,
  role: ChatMessage['role'],
  content: string,
  blocks?: AssistantMessageBlock[],
  compression?: ContextCompressionNotice,
  modelConfig?: ModelConfigSnapshot,
  contextConfig?: ContextManagementConfig,
  turn?: ConversationTurnRecord,
  images?: ImageAttachment[],
  messageId?: string,
  createdAt?: string,
): Promise<Project> {
  const project = await findProject(projectId)
  const conversation = findConversation(project, conversationId)
  const message = {
    id: messageId ?? randomUUID(),
    createdAt: createdAt ?? new Date().toISOString(),
    role,
    content,
    images,
    blocks,
    compression,
    modelConfig,
    contextConfig,
    turn,
  }
  conversation.messages.push(message)
  if (role === 'user' && conversation.messages.length === 1) {
    const title = content || images?.[0]?.name || 'Image request'
    conversation.title = title.length > 36 ? `${title.slice(0, 36)}…` : title
  }

  void serializeWrite(conversationWriteScope(projectId, conversationId), async () => {
    // Yield once so the caller can publish the in-memory snapshot first.
    await new Promise<void>((resolve) => setImmediate(resolve))
    await persistImageAttachments(projectId, conversationId, message.images)
    await persistConversation(projectId, conversation)
  }).catch((error) => {
    log.error('workspace.message.persist.failed', {
      projectId,
      conversationId,
      messageId: message.id,
      error,
    })
  })

  return project
}

export function addMessage(
  projectId: string,
  conversationId: string,
  role: ChatMessage['role'],
  content: string,
  blocks?: AssistantMessageBlock[],
  compression?: ContextCompressionNotice,
  modelConfig?: ModelConfigSnapshot,
  contextConfig?: ContextManagementConfig,
  turn?: ConversationTurnRecord,
  images?: ImageAttachment[],
  messageId?: string,
  createdAt?: string,
): Promise<Project> {
  return serializeWrite(conversationWriteScope(projectId, conversationId), async () => {
    const project = await findProject(projectId)
    const conversation = findConversation(project, conversationId)
    await persistImageAttachments(projectId, conversationId, images)
    conversation.messages.push({
      id: messageId ?? randomUUID(),
      createdAt: createdAt ?? new Date().toISOString(),
      role,
      content,
      images,
      blocks,
      compression,
      modelConfig,
      contextConfig,
      turn,
    })
    if (role === 'user' && conversation.messages.length === 1) {
      const title = content || images?.[0]?.name || 'Image request'
      conversation.title = title.length > 36 ? `${title.slice(0, 36)}…` : title
    }
    await persistConversation(projectId, conversation)
    return project
  })
}

export function updateConversationTurn(projectId: string, conversationId: string, messageId: string, turn: ConversationTurnRecord): Promise<Project> {
  return serializeWrite(conversationWriteScope(projectId, conversationId), async () => {
    const project = await findProject(projectId)
    const conversation = findConversation(project, conversationId)
    const message = conversation.messages.find((item) => item.id === messageId)
    if (!message) throw new Error('Conversation message not found')
    message.turn = turn
    await persistConversation(projectId, conversation)
    return project
  })
}

export function saveConversationContext(
  projectId: string,
  conversationId: string,
  agentMessages: Conversation['agentMessages'],
  context: Conversation['context'],
): Promise<Project> {
  return serializeWrite(conversationWriteScope(projectId, conversationId), async () => {
    const project = await findProject(projectId)
    const conversation = findConversation(project, conversationId)
    for (const message of agentMessages) await persistImageAttachments(projectId, conversationId, message.images)
    conversation.agentMessages = agentMessages
    conversation.context = context
    await persistConversation(projectId, conversation)
    return project
  })
}

export function updateConversationAgentMessages(
  projectId: string,
  conversationId: string,
  update: (messages: Conversation['agentMessages']) => Conversation['agentMessages'],
): Promise<Project> {
  return serializeWrite(conversationWriteScope(projectId, conversationId), async () => {
    const project = await findProject(projectId)
    const conversation = findConversation(project, conversationId)
    conversation.agentMessages = update(conversation.agentMessages)
    await persistConversation(projectId, conversation)
    return project
  })
}
