import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { dirname, join, relative, resolve } from 'node:path'
import type { MediaAttachment, MediaAttachmentMediaType } from '../shared/media-attachments'
import { mediaDataBytes } from '../shared/media-attachments'

const mediaExtensions: Record<MediaAttachmentMediaType, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/webm': 'weba',
  'application/pdf': 'pdf',
}

export type StoredMediaReference = {
  id: string
  name: string
  kind: MediaAttachment['kind']
  mediaType: MediaAttachmentMediaType
  path: string
}

const hydratedMediaCache = new Map<string, string>()

function storageRoot(): string {
  return join(app.getPath('userData'), 'workspace-data')
}

function key(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url') || 'empty'
}

function absoluteMediaPath(projectId: string, conversationId: string, media: Pick<MediaAttachment, 'id' | 'mediaType'>): string {
  return join(storageRoot(), 'media', key(projectId), key(conversationId), `${key(media.id)}.${mediaExtensions[media.mediaType]}`)
}

function relativeMediaPath(projectId: string, conversationId: string, media: Pick<MediaAttachment, 'id' | 'mediaType'>): string {
  return relative(storageRoot(), absoluteMediaPath(projectId, conversationId, media)).replaceAll('\\', '/')
}

function isStoredMediaReference(value: unknown): value is StoredMediaReference {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<StoredMediaReference>
  return typeof item.id === 'string' && typeof item.name === 'string' &&
    typeof item.kind === 'string' && ['video', 'audio', 'pdf'].includes(item.kind) &&
    typeof item.mediaType === 'string' && item.mediaType in mediaExtensions &&
    typeof item.path === 'string' && item.path.startsWith('media/')
}

function resolveStoredPath(path: string): string {
  const root = resolve(storageRoot())
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
    throw new Error('Invalid stored media path')
  }
  return target
}

export async function persistMediaAttachments(
  projectId: string,
  conversationId: string,
  attachments: MediaAttachment[] | undefined,
): Promise<StoredMediaReference[] | undefined> {
  if (!attachments?.length) return undefined
  const references: StoredMediaReference[] = []
  for (const media of attachments) {
    const separator = media.dataUrl.indexOf(',')
    const base64 = separator >= 0 ? media.dataUrl.slice(separator + 1) : ''
    if (!base64 || mediaDataBytes(media.dataUrl) === null) throw new Error('Invalid media attachment')
    const target = absoluteMediaPath(projectId, conversationId, media)
    await mkdir(dirname(target), { recursive: true })
    try {
      await writeFile(target, Buffer.from(base64, 'base64'), { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    hydratedMediaCache.set(target, media.dataUrl)
    references.push({ id: media.id, name: media.name, kind: media.kind, mediaType: media.mediaType, path: relativeMediaPath(projectId, conversationId, media) })
  }
  return references
}

export function mediaReferences(
  projectId: string,
  conversationId: string,
  attachments: MediaAttachment[] | undefined,
): StoredMediaReference[] | undefined {
  if (!attachments?.length) return undefined
  return attachments.map((media) => ({
    id: media.id,
    name: media.name,
    kind: media.kind,
    mediaType: media.mediaType,
    path: relativeMediaPath(projectId, conversationId, media),
  }))
}

export async function hydrateMediaAttachments(attachments: unknown): Promise<MediaAttachment[] | undefined> {
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined
  const hydrated: MediaAttachment[] = []
  for (const value of attachments) {
    if (!isStoredMediaReference(value)) {
      hydrated.push(value as MediaAttachment)
      continue
    }
    const target = resolveStoredPath(value.path)
    let dataUrl = hydratedMediaCache.get(target)
    if (!dataUrl) {
      const bytes = await readFile(target)
      dataUrl = `data:${value.mediaType};base64,${bytes.toString('base64')}`
      hydratedMediaCache.set(target, dataUrl)
    }
    hydrated.push({ id: value.id, name: value.name, kind: value.kind, mediaType: value.mediaType, dataUrl })
  }
  return hydrated
}
