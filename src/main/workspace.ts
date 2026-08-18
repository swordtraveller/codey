import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AssistantMessageBlock,
  ChatMessage,
  ContextCompressionNotice,
  Conversation,
  ModelConfigSnapshot,
  Project,
  ProjectFolder,
} from '../shared/types'

type StoredConversation = Omit<Conversation, 'agentMessages' | 'modelConfigId'> & {
  agentMessages?: Conversation['agentMessages']
  modelConfigId?: string | null
}

type StoredProject = Omit<
  Project,
  'defaultModelConfigId' | 'folders' | 'pythonEnvironmentFolderId' | 'conversations'
> & {
  defaultModelConfigId?: string | null
  folders: Array<ProjectFolder | string>
  pythonEnvironmentFolderId?: string | null
  conversations: StoredConversation[]
}

let projects: Project[] | undefined

function getWorkspacePath(): string {
  return join(app.getPath('userData'), 'workspace.json')
}

function normalizeProject(value: StoredProject): Project {
  const folders = value.folders.map((folder) =>
    typeof folder === 'string' ? { id: randomUUID(), path: folder } : folder,
  )
  const configuredFolder = folders.some((folder) => folder.id === value.pythonEnvironmentFolderId)
  return {
    ...value,
    defaultModelConfigId: value.defaultModelConfigId ?? null,
    folders,
    conversations: value.conversations.map((conversation) => ({
      ...conversation,
      modelConfigId: conversation.modelConfigId ?? null,
      agentMessages:
        conversation.agentMessages ??
        conversation.messages.map(({ role, content }) => ({ role, content })),
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
      project.pythonEnvironmentFolderId === undefined ||
      project.folders.some((folder) => typeof folder === 'string') ||
      project.conversations.some((conversation) =>
        conversation.modelConfigId === undefined || !conversation.agentMessages,
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
  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) {
    throw new Error('Conversation not found')
  }

  conversation.modelConfigId = modelConfigId
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
): Promise<Project> {
  const project = await findProject(projectId)
  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) {
    throw new Error('Conversation not found')
  }

  conversation.messages.push({ id: randomUUID(), role, content, blocks, compression, modelConfig })
  if (role === 'user' && conversation.messages.length === 1) {
    conversation.title = content.length > 36 ? `${content.slice(0, 36)}…` : content
  }
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
  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) {
    throw new Error('Conversation not found')
  }

  conversation.agentMessages = agentMessages
  conversation.context = context
  await saveProjects()
  return project
}
