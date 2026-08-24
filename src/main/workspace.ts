import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  defaultAgentLimitsConfig,
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

type StoredConversation = Omit<Conversation, 'agentMessages' | 'modelConfigId' | 'contextConfigOverride' | 'agentLimits'> & {
  agentMessages?: Conversation['agentMessages']
  modelConfigId?: string | null
  contextConfigOverride?: Partial<ContextManagementConfig> | null
  agentLimits?: Partial<AgentLimitsConfig>
}

type StoredProject = Omit<
  Project,
  'defaultModelConfigId' | 'contextConfigOverride' | 'folders' | 'pythonEnvironmentFolderId' | 'conversations'
> & {
  defaultModelConfigId?: string | null
  contextConfigOverride?: Partial<ContextManagementConfig> | null
  folders: Array<ProjectFolder | string>
  pythonEnvironmentFolderId?: string | null
  conversations: StoredConversation[]
}

let projects: Project[] | undefined

function getWorkspacePath(): string {
  return join(app.getPath('userData'), 'workspace.json')
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
  if (!contextConfig) {
    return null
  }
  const normalized = normalizeContextManagementConfig(contextConfig)
  if (!isValidContextManagementConfig(normalized)) {
    throw new Error('Enter valid context settings')
  }
  return normalized
}

function normalizeProject(value: StoredProject): Project {
  const folders = value.folders.map((folder) =>
    typeof folder === 'string' ? { id: randomUUID(), path: folder } : folder,
  )
  const configuredFolder = folders.some((folder) => folder.id === value.pythonEnvironmentFolderId)
  return {
    ...value,
    defaultModelConfigId: value.defaultModelConfigId ?? null,
    contextConfigOverride: normalizeOverride(value.contextConfigOverride),
    folders,
    conversations: value.conversations.map((conversation) => ({
      ...conversation,
      modelConfigId: conversation.modelConfigId ?? null,
      contextConfigOverride: normalizeOverride(conversation.contextConfigOverride),
      agentLimits: normalizeStoredAgentLimits(conversation.agentLimits),
      agentMessages:
        conversation.agentMessages ??
        conversation.messages.map(({ role, content, images }) => ({ role, content, images })),
    })),
    pythonEnvironmentFolderId: configuredFolder
      ? (value.pythonEnvironmentFolderId ?? null)
      : (folders[0]?.id ?? null),
  }
}

async function loadProjects(): Promise<Project[]> {
  if (projects) {
    return projects
  }

  try {
    const stored = JSON.parse(await readFile(getWorkspacePath(), 'utf8')) as StoredProject[]
    const needsMigration = stored.some((project) =>
      project.defaultModelConfigId === undefined ||
      project.contextConfigOverride === undefined ||
      project.pythonEnvironmentFolderId === undefined ||
      project.folders.some((folder) => typeof folder === 'string') ||
      project.conversations.some((conversation) =>
        conversation.modelConfigId === undefined ||
        conversation.contextConfigOverride === undefined ||
        conversation.agentLimits === undefined ||
        !conversation.agentMessages,
      ),
    )
    projects = stored.map(normalizeProject)
    if (needsMigration) {
      await saveProjects()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Unable to read projects')
    }
    projects = []
  }

  return projects
}

async function saveProjects(): Promise<void> {
  await writeFile(getWorkspacePath(), JSON.stringify(projects), 'utf8')
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
  if (!project) {
    throw new Error('Project not found')
  }
  return project
}

function findConversation(project: Project, conversationId: string): Conversation {
  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) {
    throw new Error('Conversation not found')
  }
  return conversation
}

export async function getProjects(): Promise<Project[]> {
  return loadProjects()
}

export async function getProject(projectId: string): Promise<Project> {
  return findProject(projectId)
}

export async function createProject(
  name: string,
  defaultModelConfigId: string | null = null,
): Promise<Project> {
  const normalizedName = name.trim()
  if (!normalizedName) {
    throw new Error('Enter a project name')
  }

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
  await saveProjects()
  return project
}

export async function addProjectFolder(projectId: string, folderPath: string): Promise<Project> {
  const project = await findProject(projectId)
  const exists = project.folders.some(
    (current) => current.path.toLowerCase() === folderPath.toLowerCase(),
  )

  if (!exists) {
    const folder = { id: randomUUID(), path: folderPath }
    project.folders.push(folder)
    project.pythonEnvironmentFolderId ??= folder.id
    await saveProjects()
  }

  return project
}

export async function setProjectModelConfig(
  projectId: string,
  modelConfigId: string | null,
): Promise<Project> {
  const project = await findProject(projectId)
  project.defaultModelConfigId = modelConfigId
  await saveProjects()
  return project
}

export async function setProjectContextConfig(
  projectId: string,
  contextConfig: ContextManagementConfig | null,
): Promise<Project> {
  const project = await findProject(projectId)
  project.contextConfigOverride = validateOverride(contextConfig)
  await saveProjects()
  return project
}

export async function createConversation(projectId: string): Promise<Project> {
  const project = await findProject(projectId)
  project.conversations.push(createConversationRecord(project.conversations.length + 1))
  await saveProjects()
  return project
}

export async function setConversationModelConfig(
  projectId: string,
  conversationId: string,
  modelConfigId: string | null,
): Promise<Project> {
  const project = await findProject(projectId)
  findConversation(project, conversationId).modelConfigId = modelConfigId
  await saveProjects()
  return project
}

export async function setConversationContextConfig(
  projectId: string,
  conversationId: string,
  contextConfig: ContextManagementConfig | null,
): Promise<Project> {
  const project = await findProject(projectId)
  findConversation(project, conversationId).contextConfigOverride = validateOverride(contextConfig)
  await saveProjects()
  return project
}

export async function setConversationAgentLimits(
  projectId: string,
  conversationId: string,
  agentLimits: AgentLimitsConfig,
): Promise<Project> {
  const normalized = normalizeAgentLimitsConfig(agentLimits)
  if (!isValidAgentLimitsConfig(normalized)) {
    throw new Error('Enter valid Agent limits')
  }
  const project = await findProject(projectId)
  findConversation(project, conversationId).agentLimits = normalized
  await saveProjects()
  return project
}

export async function addMessage(
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
): Promise<Project> {
  const project = await findProject(projectId)
  const conversation = findConversation(project, conversationId)

  conversation.messages.push({ id: randomUUID(), role, content, images, blocks, compression, modelConfig, contextConfig, turn })
  if (role === 'user' && conversation.messages.length === 1) {
    const title = content || images?.[0]?.name || 'Image request'
    conversation.title = title.length > 36 ? `${title.slice(0, 36)}…` : title
  }
  await saveProjects()
  return project
}

export async function updateConversationTurn(
  projectId: string,
  conversationId: string,
  messageId: string,
  turn: ConversationTurnRecord,
): Promise<Project> {
  const project = await findProject(projectId)
  const message = findConversation(project, conversationId).messages.find((item) => item.id === messageId)
  if (!message) {
    throw new Error('Conversation message not found')
  }
  message.turn = turn
  await saveProjects()
  return project
}

export async function saveConversationContext(
  projectId: string,
  conversationId: string,
  agentMessages: Conversation['agentMessages'],
  context: Conversation['context'],
): Promise<Project> {
  const project = await findProject(projectId)
  const conversation = findConversation(project, conversationId)
  conversation.agentMessages = agentMessages
  conversation.context = context
  await saveProjects()
  return project
}

export async function updateConversationAgentMessages(
  projectId: string,
  conversationId: string,
  update: (messages: Conversation['agentMessages']) => Conversation['agentMessages'],
): Promise<Project> {
  const project = await findProject(projectId)
  const conversation = findConversation(project, conversationId)
  conversation.agentMessages = update(conversation.agentMessages)
  await saveProjects()
  return project
}