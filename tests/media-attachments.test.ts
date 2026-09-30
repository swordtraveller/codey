import { describe, expect, it } from 'vitest'
import {
  maximumMediaAttachmentBytes,
  maximumMediaAttachments,
  mediaDataBytes,
  validateMediaAttachments,
  type MediaAttachment,
} from '../src/shared/media-attachments'
import { countContextTokens, type ContextMessage } from '../src/main/context'
import { redactProviderMessages, toProviderMessages } from '../src/main/model-messages'

function media(kind: MediaAttachment['kind'] = 'pdf', data = 'aGVsbG8='): MediaAttachment {
  const mediaType = kind === 'video'
    ? 'video/mp4'
    : kind === 'audio'
      ? 'audio/mpeg'
      : 'application/pdf'
  return {
    id: `${kind}-1`,
    name: `clip.${kind === 'pdf' ? 'pdf' : kind}`,
    kind,
    mediaType,
    dataUrl: `data:${mediaType};base64,${data}`,
  }
}

describe('media attachments', () => {
  it('accepts supported files and rejects invalid input', () => {
    expect(validateMediaAttachments([media('video')])).toBeNull()
    expect(validateMediaAttachments([media('audio')])).toBeNull()
    expect(validateMediaAttachments([media('pdf')])).toBeNull()
    expect(validateMediaAttachments([{ ...media(), mediaType: 'application/zip' }])).toBe('unsupported-type')
    expect(validateMediaAttachments([{ ...media(), kind: 'doc' as MediaAttachment['kind'] }])).toBe('invalid')
    expect(validateMediaAttachments([{ ...media(), dataUrl: 'data:application/pdf;base64,' }])).toBe('invalid')
    expect(validateMediaAttachments(Array.from({ length: maximumMediaAttachments + 1 }, (_, index) => ({ ...media(), id: `pdf-${index}` })))).toBe('too-many')

    const oversizedBase64 = 'A'.repeat(Math.ceil((maximumMediaAttachmentBytes.pdf + 1) / 3) * 4)
    expect(validateMediaAttachments([media('pdf', oversizedBase64)])).toBe('too-large')
  })

  it('maps each kind to its provider content part and redacts data from logs', () => {
    const source: ContextMessage[] = [
      {
        id: 'internal-id',
        role: 'user',
        content: 'Analyze these files.',
        attachments: [media('video'), media('audio'), media('pdf')],
        contextLayer: 'hot',
      },
    ]

    const messages = toProviderMessages(source)
    expect(messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'Analyze these files.' },
        { type: 'video_url', video_url: { url: media('video').dataUrl } },
        { type: 'input_audio', input_audio: { data: 'aGVsbG8=', format: 'mp3' } },
        { type: 'file', file: { filename: 'clip.pdf', file_data: media('pdf').dataUrl } },
      ],
    }])

    const logged = JSON.stringify(redactProviderMessages(messages, source))
    expect(logged).toContain('[video data omitted: video/mp4, 5 bytes]')
    expect(logged).toContain('[audio data omitted: audio/mpeg, 5 bytes]')
    expect(logged).toContain('[pdf data omitted: application/pdf, 5 bytes]')
    expect(logged).not.toContain('aGVsbG8=')
  })

  it('uses a bounded token estimate instead of counting base64 text', () => {
    const small = countContextTokens({ role: 'user', content: '', attachments: [media('pdf', 'AAAA')] })
    const large = countContextTokens({ role: 'user', content: '', attachments: [media('pdf', 'A'.repeat(400_000))] })

    expect(Math.abs(large - small)).toBeLessThan(10)
    expect(small).toBeGreaterThan(1_000)
  })

  it('computes decoded byte sizes from data URLs', () => {
    expect(mediaDataBytes('data:application/pdf;base64,aGVsbG8=')).toBe(5)
    expect(mediaDataBytes('data:application/pdf;base64,aGVsbG8')).toBeNull()
    expect(mediaDataBytes('not a data url')).toBeNull()
  })
})
