import type { ImageAttachment } from '../shared/image-attachments'
import type { MediaAttachment } from '../shared/media-attachments'
import type { ContextMessage } from './context'

export type ProviderMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

export type ProviderMessageContent = string | ProviderMessagePart[] | null

export type ProviderMessage = {
  role: ContextMessage['role']
  content: ProviderMessageContent
  tool_calls?: ContextMessage['tool_calls']
  tool_call_id?: string
}

function attachmentDescription(attachment: ImageAttachment): string {
  const base64 = attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const bytes = (base64.length * 3) / 4 - padding
  return `[image data omitted: ${attachment.mediaType}, ${bytes} bytes]`
}

function mediaAttachmentDescription(attachment: MediaAttachment): string {
  const base64 = attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const bytes = (base64.length * 3) / 4 - padding
  return `[${attachment.kind} data omitted: ${attachment.mediaType}, ${bytes} bytes]`
}

function audioInputFormat(mediaType: MediaAttachment['mediaType']): string {
  switch (mediaType) {
    case 'audio/mpeg': return 'mp3'
    case 'audio/wav': return 'wav'
    case 'audio/ogg': return 'ogg'
    case 'audio/mp4': return 'm4a'
    case 'audio/webm': return 'webm'
    default: return mediaType.split('/')[1] ?? 'mp3'
  }
}

function mediaAttachmentPart(attachment: MediaAttachment): ProviderMessagePart {
  if (attachment.kind === 'video') {
    return { type: 'video_url', video_url: { url: attachment.dataUrl } }
  }
  if (attachment.kind === 'audio') {
    const separator = attachment.dataUrl.indexOf(',')
    return {
      type: 'input_audio',
      input_audio: {
        data: separator >= 0 ? attachment.dataUrl.slice(separator + 1) : '',
        format: audioInputFormat(attachment.mediaType),
      },
    }
  }
  return { type: 'file', file: { filename: attachment.name, file_data: attachment.dataUrl } }
}

export function toProviderMessages(messages: ContextMessage[]): ProviderMessage[] {
  return messages.map((message) => {
    const isUser = message.role === 'user'
    const images = isUser ? message.images ?? [] : []
    const attachments = isUser ? message.attachments ?? [] : []
    const content: ProviderMessageContent = images.length > 0 || attachments.length > 0
      ? [
          ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
          ...images.map((image) => ({
            type: 'image_url' as const,
            image_url: { url: image.dataUrl },
          })),
          ...attachments.map(mediaAttachmentPart),
        ]
      : message.content

    return {
      role: message.role,
      content,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    }
  })
}

export function redactProviderMessages(
  messages: ProviderMessage[],
  sourceMessages: ContextMessage[],
): ProviderMessage[] {
  return messages.map((message, index) => {
    if (!Array.isArray(message.content)) return message
    const source = sourceMessages[index]
    const images = source?.images ?? []
    const attachments = source?.attachments ?? []
    let imageIndex = 0
    let attachmentIndex = 0
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === 'image_url') {
          const attachment = images[imageIndex++]
          return {
            ...part,
            image_url: {
              url: attachment ? attachmentDescription(attachment) : '[image data omitted]',
            },
          }
        }
        if (part.type === 'video_url') {
          const attachment = attachments[attachmentIndex++]
          return {
            ...part,
            video_url: {
              url: attachment ? mediaAttachmentDescription(attachment) : '[video data omitted]',
            },
          }
        }
        if (part.type === 'input_audio') {
          const attachment = attachments[attachmentIndex++]
          return {
            ...part,
            input_audio: {
              data: attachment ? mediaAttachmentDescription(attachment) : '[audio data omitted]',
              format: part.input_audio.format,
            },
          }
        }
        if (part.type === 'file') {
          const attachment = attachments[attachmentIndex++]
          return {
            ...part,
            file: {
              filename: part.file.filename,
              file_data: attachment ? mediaAttachmentDescription(attachment) : '[file data omitted]',
            },
          }
        }
        return part
      }),
    }
  })
}
