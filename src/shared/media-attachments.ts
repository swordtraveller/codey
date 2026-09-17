export const supportedVideoMediaTypes = [
  'video/mp4',
  'video/webm',
] as const

export const supportedAudioMediaTypes = [
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
  'audio/webm',
] as const

export const supportedPdfMediaTypes = [
  'application/pdf',
] as const

export type VideoMediaType = (typeof supportedVideoMediaTypes)[number]
export type AudioMediaType = (typeof supportedAudioMediaTypes)[number]
export type PdfMediaType = (typeof supportedPdfMediaTypes)[number]

export type MediaAttachmentMediaType = VideoMediaType | AudioMediaType | PdfMediaType

export type MediaKind = 'video' | 'audio' | 'pdf'

export const supportedMediaTypes: Record<MediaKind, readonly MediaAttachmentMediaType[]> = {
  video: supportedVideoMediaTypes,
  audio: supportedAudioMediaTypes,
  pdf: supportedPdfMediaTypes,
}

export type MediaAttachment = {
  id: string
  name: string
  kind: MediaKind
  mediaType: MediaAttachmentMediaType
  dataUrl: string
}

export const maximumMediaAttachments = 4

export const maximumMediaAttachmentBytes: Record<MediaKind, number> = {
  video: 50 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
}

export const estimatedMediaAttachmentTokens = 2048

export type MediaAttachmentValidationError =
  | 'too-many'
  | 'unsupported-type'
  | 'too-large'
  | 'invalid'

export function mediaKindForMediaType(mediaType: string): MediaKind | null {
  if ((supportedVideoMediaTypes as readonly string[]).includes(mediaType)) return 'video'
  if ((supportedAudioMediaTypes as readonly string[]).includes(mediaType)) return 'audio'
  if ((supportedPdfMediaTypes as readonly string[]).includes(mediaType)) return 'pdf'
  return null
}

export function mediaDataBytes(dataUrl: string): number | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!match || match[2].length % 4 !== 0) return null
  const padding = match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0
  return (match[2].length * 3) / 4 - padding
}

export function validateMediaAttachments(value: unknown): MediaAttachmentValidationError | null {
  if (!Array.isArray(value)) return 'invalid'
  if (value.length > maximumMediaAttachments) return 'too-many'

  const ids = new Set<string>()
  for (const attachment of value) {
    if (!attachment || typeof attachment !== 'object') return 'invalid'
    const item = attachment as Partial<MediaAttachment>
    if (
      typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
      typeof item.name !== 'string' || !item.name || item.name.length > 255 ||
      typeof item.kind !== 'string' ||
      typeof item.mediaType !== 'string' ||
      typeof item.dataUrl !== 'string'
    ) {
      return 'invalid'
    }
    if (item.kind !== 'video' && item.kind !== 'audio' && item.kind !== 'pdf') return 'invalid'
    if (!supportedMediaTypes[item.kind].includes(item.mediaType as MediaAttachmentMediaType)) {
      return 'unsupported-type'
    }
    if (!item.dataUrl.startsWith(`data:${item.mediaType};base64,`)) {
      return 'invalid'
    }
    ids.add(item.id)
    const bytes = mediaDataBytes(item.dataUrl)
    if (bytes === null) return 'invalid'
    if (bytes > maximumMediaAttachmentBytes[item.kind]) return 'too-large'
  }
  return null
}
