import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { dirname, join, relative, resolve } from 'node:path'
import type { ImageAttachment, ImageMediaType } from '../shared/image-attachments'
import { imageDataBytes } from '../shared/image-attachments'

const imageExtensions: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export type StoredImageReference = {
  id: string
  name: string
  mediaType: ImageMediaType
  path: string
}

const hydratedImageCache = new Map<string, string>()

function storageRoot(): string {
  return join(app.getPath('userData'), 'workspace-data')
}

function key(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url') || 'empty'
}

function absoluteImagePath(projectId: string, conversationId: string, image: Pick<ImageAttachment, 'id' | 'mediaType'>): string {
  return join(storageRoot(), 'images', key(projectId), key(conversationId), `${key(image.id)}.${imageExtensions[image.mediaType]}`)
}

function relativeImagePath(projectId: string, conversationId: string, image: Pick<ImageAttachment, 'id' | 'mediaType'>): string {
  return relative(storageRoot(), absoluteImagePath(projectId, conversationId, image)).replaceAll('\\', '/')
}

function isStoredImageReference(value: unknown): value is StoredImageReference {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<StoredImageReference>
  return typeof item.id === 'string' && typeof item.name === 'string' &&
    typeof item.mediaType === 'string' && item.mediaType in imageExtensions &&
    typeof item.path === 'string' && item.path.startsWith('images/')
}

function resolveStoredPath(path: string): string {
  const root = resolve(storageRoot())
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
    throw new Error('Invalid stored image path')
  }
  return target
}

export async function persistImageAttachments(
  projectId: string,
  conversationId: string,
  images: ImageAttachment[] | undefined,
): Promise<StoredImageReference[] | undefined> {
  if (!images?.length) return undefined
  const references: StoredImageReference[] = []
  for (const image of images) {
    const separator = image.dataUrl.indexOf(',')
    const base64 = separator >= 0 ? image.dataUrl.slice(separator + 1) : ''
    if (!base64 || imageDataBytes(image.dataUrl) === null) throw new Error('Invalid image attachment')
    const target = absoluteImagePath(projectId, conversationId, image)
    await mkdir(dirname(target), { recursive: true })
    try {
      await writeFile(target, Buffer.from(base64, 'base64'), { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    hydratedImageCache.set(target, image.dataUrl)
    references.push({ id: image.id, name: image.name, mediaType: image.mediaType, path: relativeImagePath(projectId, conversationId, image) })
  }
  return references
}

export function imageReferences(
  projectId: string,
  conversationId: string,
  images: ImageAttachment[] | undefined,
): StoredImageReference[] | undefined {
  if (!images?.length) return undefined
  return images.map((image) => ({
    id: image.id,
    name: image.name,
    mediaType: image.mediaType,
    path: relativeImagePath(projectId, conversationId, image),
  }))
}

export async function hydrateImageAttachments(images: unknown): Promise<ImageAttachment[] | undefined> {
  if (!Array.isArray(images) || images.length === 0) return undefined
  const hydrated: ImageAttachment[] = []
  for (const value of images) {
    if (!isStoredImageReference(value)) {
      hydrated.push(value as ImageAttachment)
      continue
    }
    const target = resolveStoredPath(value.path)
    let dataUrl = hydratedImageCache.get(target)
    if (!dataUrl) {
      const bytes = await readFile(target)
      dataUrl = `data:${value.mediaType};base64,${bytes.toString('base64')}`
      hydratedImageCache.set(target, dataUrl)
    }
    hydrated.push({ id: value.id, name: value.name, mediaType: value.mediaType, dataUrl })
  }
  return hydrated
}

export function getWorkspaceDataRoot(): string {
  return storageRoot()
}
