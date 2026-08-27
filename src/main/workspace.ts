import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  await writeFile(path, JSON.stringify(value), 'utf8')
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

async function loadShardedProjects(manifest: WorkspaceManifest): Promise<Project[]> {
  const loaded: Project[] = []
  for (const projectId of manifest.projectIds) {
    const metadata = JSON.parse(await readFile(projectPath(projectId), 'utf8')) as StoredProjectMetadata
    const conversations: Conversation[] = []
    for (const conversationId of metadata.conversationIds) {
      const stored = JSON.parse(await readFile(conversationPath(projectId, conversationId), 'utf8')) as StoredConversation
      conversations.push(await normalizeConversation(stored))
    }
    loaded.push(await normalizeProjectMetadata(metadata, conversations))
  }
  return loaded
}

async function loadProjects(): Promise<Project[]> {
  userDataPath()
  if (projects) return projects
  if (projectsLoad) return projectsLoad
  projectsLoad = (async () => {
    try {
      const stored = JSON.parse(await readFile(getWorkspacePath(), 'utf8')) as WorkspaceManifest | LegacyStoredProject[]
      projects = Array.isArray(stored)
        ? await migrateLegacyProjects(stored)
        : await loadShardedProjects(stored)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read projects')
      projects = []
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

export async function getProject(projectId: string): Promise<Project> {
  await awaitPendingWrites()
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
