import type { ImageAttachment } from '../shared/image-attachments'
import type { ContextMessage } from './context'

export type ProviderMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >
  | null

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

export function toProviderMessages(messages: ContextMessage[]): ProviderMessage[] {
  return messages.map((message) => {
    const images = message.role === 'user' ? message.images ?? [] : []
    const content: ProviderMessageContent = images.length > 0
      ? [
          ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
          ...images.map((image) => ({
            type: 'image_url' as const,
            image_url: { url: image.dataUrl },
          })),
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
    const images = sourceMessages[index]?.images ?? []
    let imageIndex = 0
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'image_url') return part
        const attachment = images[imageIndex++]
        return {
          ...part,
          image_url: {
            url: attachment ? attachmentDescription(attachment) : '[image data omitted]',
          },
        }
      }),
    }
  })
}
