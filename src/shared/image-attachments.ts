export const supportedImageMediaTypes = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const

export type ImageMediaType = (typeof supportedImageMediaTypes)[number]

export type ImageAttachment = {
  id: string
  name: string
  mediaType: ImageMediaType
  dataUrl: string
}

export const maximumImageAttachments = 4
export const maximumImageAttachmentBytes = 5 * 1024 * 1024
export const estimatedImageTokens = 1024

export type ImageAttachmentValidationError =
  | 'too-many'
  | 'unsupported-type'
  | 'too-large'
  | 'invalid'

export function imageDataBytes(dataUrl: string): number | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!match || match[2].length % 4 !== 0) return null
  const padding = match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0
  return (match[2].length * 3) / 4 - padding
}

export function validateImageAttachments(value: unknown): ImageAttachmentValidationError | null {
  if (!Array.isArray(value)) return 'invalid'
  if (value.length > maximumImageAttachments) return 'too-many'

  const ids = new Set<string>()
  for (const attachment of value) {
    if (!attachment || typeof attachment !== 'object') return 'invalid'
    const item = attachment as Partial<ImageAttachment>
    if (
      typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
      typeof item.name !== 'string' || !item.name || item.name.length > 255 ||
      typeof item.mediaType !== 'string' ||
      typeof item.dataUrl !== 'string'
    ) {
      return 'invalid'
    }
    if (!supportedImageMediaTypes.includes(item.mediaType as ImageMediaType)) {
      return 'unsupported-type'
    }
    if (!item.dataUrl.startsWith(`data:${item.mediaType};base64,`)) {
      return 'invalid'
    }
    ids.add(item.id)
    const bytes = imageDataBytes(item.dataUrl)
    if (bytes === null) return 'invalid'
    if (bytes > maximumImageAttachmentBytes) return 'too-large'
  }
  return null
}
