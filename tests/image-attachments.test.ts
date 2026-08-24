import { describe, expect, it } from 'vitest'
import {
  maximumImageAttachmentBytes,
  validateImageAttachments,
  type ImageAttachment,
} from '../src/shared/image-attachments'
import { countContextTokens, type ContextMessage } from '../src/main/context'
import { redactProviderMessages, toProviderMessages } from '../src/main/model-messages'

function image(data = 'aGVsbG8='): ImageAttachment {
  return {
    id: 'image-1',
    name: 'screen.png',
    mediaType: 'image/png',
    dataUrl: `data:image/png;base64,${data}`,
  }
}

describe('image attachments', () => {
  it('accepts bounded supported images and rejects invalid input', () => {
    expect(validateImageAttachments([image()])).toBeNull()
    expect(validateImageAttachments([{ ...image(), mediaType: 'image/gif' }])).toBe('unsupported-type')
    expect(validateImageAttachments([{ ...image(), dataUrl: 'data:image/png;base64,' }])).toBe('invalid')

    const oversizedBase64 = 'A'.repeat(Math.ceil((maximumImageAttachmentBytes + 1) / 3) * 4)
    expect(validateImageAttachments([image(oversizedBase64)])).toBe('too-large')
  })

  it('creates OpenAI-compatible image_url content and redacts image data from logs', () => {
    const source: ContextMessage[] = [
      {
        id: 'internal-id',
        role: 'user',
        content: 'Describe this screenshot.',
        images: [image()],
        contextLayer: 'hot',
      },
    ]

    const messages = toProviderMessages(source)
    expect(messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this screenshot.' },
        { type: 'image_url', image_url: { url: image().dataUrl } },
      ],
    }])

    const logged = JSON.stringify(redactProviderMessages(messages, source))
    expect(logged).toContain('[image data omitted: image/png, 5 bytes]')
    expect(logged).not.toContain('aGVsbG8=')
  })

  it('uses a bounded token estimate instead of counting base64 text', () => {
    const small = countContextTokens({ role: 'user', content: '', images: [image('AAAA')] })
    const large = countContextTokens({ role: 'user', content: '', images: [image('A'.repeat(400_000))] })

    expect(Math.abs(large - small)).toBeLessThan(10)
    expect(small).toBeGreaterThan(1_000)
  })
})
