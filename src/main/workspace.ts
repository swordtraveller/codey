import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, Conversation, Project } from '../shared/types'

let projects: Project[] | undefined

function getWorkspacePath(): string {
  return join(app.getPath('userData'), 'workspace.json')
}

async function loadProjects(): Promise<Project[]> {
  if (projects) {
    return projects
  }

  try {
    projects = JSON.parse(await readFile(getWorkspacePath(), 'utf8')) as Project[]
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
    messages: [],
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

export async function createProject(name: string): Promise<Project> {
  const normalizedName = name.trim()
  if (!normalizedName) {
    throw new Error('Enter a project name')
  }

  const project: Project = {
    id: randomUUID(),
    name: normalizedName,
    folders: [],
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
    (current) => current.toLowerCase() === folderPath.toLowerCase(),
  )

  if (!exists) {
    project.folders.push(folderPath)
    await saveProjects()
  }

  return project
}

export async function createConversation(projectId: string): Promise<Project> {
  const project = await findProject(projectId)
  project.conversations.push(createConversationRecord(project.conversations.length + 1))
  await saveProjects()
  return project
}

export async function addMessage(
  projectId: string,
  conversationId: string,
  role: ChatMessage['role'],
  content: string,
): Promise<Project> {
  const project = await findProject(projectId)
  const conversation = project.conversations.find((item) => item.id === conversationId)
  if (!conversation) {
    throw new Error('Conversation not found')
  }

  conversation.messages.push({ id: randomUUID(), role, content })
  if (role === 'user' && conversation.messages.length === 1) {
    conversation.title = content.length > 36 ? `${content.slice(0, 36)}…` : content
  }
  await saveProjects()
  return project
}
