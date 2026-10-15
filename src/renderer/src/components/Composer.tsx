import { Button, Switch, Textarea } from '@fluentui/react-components'
import { memo, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ImageAttachment, ImageMediaType, MediaAttachment, MediaKind } from '../../../shared/types'
import { maximumImageAttachmentBytes, maximumImageAttachments, supportedImageMediaTypes } from '../../../shared/image-attachments'
import {
  maximumMediaAttachmentBytes,
  maximumMediaAttachments,
  supportedMediaTypes,
} from '../../../shared/media-attachments'
/** Media upload menu entries (video/audio/PDF) are hidden until provider
 *  support stabilizes; the full pipeline stays wired behind this flag. */
const mediaUploadMenuEnabled = false

function readImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve({
      id: crypto.randomUUID(),
      name: file.name || `clipboard-${crypto.randomUUID()}.${file.type.split('/')[1] ?? 'png'}`,
      mediaType: file.type as ImageMediaType,
      dataUrl: String(reader.result),
    })
    reader.readAsDataURL(file)
  })
}

function readMedia(file: File, kind: MediaKind): Promise<MediaAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve({
      id: crypto.randomUUID(),
      name: file.name || `${kind}-${crypto.randomUUID()}`,
      kind,
      mediaType: file.type as MediaAttachment['mediaType'],
      dataUrl: String(reader.result),
    })
    reader.readAsDataURL(file)
  })
}

type ComposerProps = {
  canSend: boolean
  supportsImageInput: boolean
  supportsVideoInput: boolean
  supportsAudioInput: boolean
  supportsPdfInput: boolean
  configured: boolean
  conversationWorking: boolean
  hasActiveConversation: boolean
  hasProjectFolders: boolean
  interactionLocked: boolean
  networkAccessEnabled: boolean
  stopping: boolean
  onError: (message: string) => void
  onNetworkAccessChange: (enabled: boolean) => void
  onStop: () => void
  onSubmit: (content: string, images: ImageAttachment[], attachments: MediaAttachment[]) => boolean
}

export const Composer = memo(function Composer({
  canSend,
  supportsImageInput,
  supportsVideoInput,
  supportsAudioInput,
  supportsPdfInput,
  configured,
  conversationWorking,
  hasActiveConversation,
  hasProjectFolders,
  interactionLocked,
  networkAccessEnabled,
  stopping,
  onError,
  onNetworkAccessChange,
  onStop,
  onSubmit,
}: ComposerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const [draftImages, setDraftImages] = useState<ImageAttachment[]>([])
  const [draftAttachments, setDraftAttachments] = useState<MediaAttachment[]>([])
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const pdfInputRef = useRef<HTMLInputElement>(null)
  const attachmentMenuRef = useRef<HTMLDivElement>(null)
  const draftImagesRef = useRef<ImageAttachment[]>([])
  const draftAttachmentsRef = useRef<MediaAttachment[]>([])
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!attachmentMenuOpen) return
    function closeAttachmentMenu(event: MouseEvent): void {
      if (!attachmentMenuRef.current?.contains(event.target as Node)) setAttachmentMenuOpen(false)
    }
    function closeAttachmentMenuOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setAttachmentMenuOpen(false)
    }
    document.addEventListener('mousedown', closeAttachmentMenu)
    document.addEventListener('keydown', closeAttachmentMenuOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeAttachmentMenu)
      document.removeEventListener('keydown', closeAttachmentMenuOnEscape)
    }
  }, [attachmentMenuOpen])

  function replaceDraftImages(images: ImageAttachment[]): void {
    draftImagesRef.current = images
    setDraftImages(images)
  }

  function replaceDraftAttachments(attachments: MediaAttachment[]): void {
    draftAttachmentsRef.current = attachments
    setDraftAttachments(attachments)
  }

  function appendImageAttachments(attachments: ImageAttachment[]): void {
    const current = draftImagesRef.current
    if (current.length + attachments.length > maximumImageAttachments) {
      onError(t('tooManyImages', { count: maximumImageAttachments }))
      return
    }
    replaceDraftImages([...current, ...attachments])
    onError('')
  }

  function appendMediaAttachments(attachments: MediaAttachment[]): void {
    const current = draftAttachmentsRef.current
    if (current.length + attachments.length > maximumMediaAttachments) {
      onError(t('tooManyAttachments', { count: maximumMediaAttachments }))
      return
    }
    replaceDraftAttachments([...current, ...attachments])
    onError('')
  }

  async function addImageFiles(files: File[]): Promise<void> {
    if (files.length === 0) return
    if (draftImagesRef.current.length + files.length > maximumImageAttachments) {
      onError(t('tooManyImages', { count: maximumImageAttachments }))
      return
    }
    if (files.some((file) => !supportedImageMediaTypes.includes(file.type as ImageMediaType))) {
      onError(t('unsupportedImage'))
      return
    }
    if (files.some((file) => file.size > maximumImageAttachmentBytes)) {
      onError(t('imageTooLarge', { size: maximumImageAttachmentBytes / 1024 / 1024 }))
      return
    }

    try {
      const attachments = await Promise.all(files.map(readImage))
      if (mountedRef.current) appendImageAttachments(attachments)
    } catch {
      if (mountedRef.current) onError(t('imageReadFailed'))
    }
  }

  async function addMediaFiles(files: File[], kind: MediaKind): Promise<void> {
    if (files.length === 0) return
    if (draftAttachmentsRef.current.length + files.length > maximumMediaAttachments) {
      onError(t('tooManyAttachments', { count: maximumMediaAttachments }))
      return
    }
    const allowed = supportedMediaTypes[kind]
    if (files.some((file) => !(allowed as readonly string[]).includes(file.type))) {
      onError(t(`unsupportedAttachment_${kind}`))
      return
    }
    const maximumBytes = maximumMediaAttachmentBytes[kind]
    if (files.some((file) => file.size > maximumBytes)) {
      onError(t('attachmentTooLarge', { size: maximumBytes / 1024 / 1024 }))
      return
    }

    try {
      const attachments = await Promise.all(files.map((file) => readMedia(file, kind)))
      if (mountedRef.current) appendMediaAttachments(attachments)
    } catch {
      if (mountedRef.current) onError(t('attachmentReadFailed'))
    }
  }

  async function selectImages(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    await addImageFiles(files)
  }

  async function selectMedia(kind: MediaKind, event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    await addMediaFiles(files, kind)
  }

  async function captureScreen(hideWindow: boolean): Promise<void> {
    if (!canSend || interactionLocked) return
    try {
      const attachment = await window.codey.screenshot(hideWindow)
      if (attachment && mountedRef.current) appendImageAttachments([attachment])
    } catch {
      if (mountedRef.current) onError(t('screenshotFailed'))
    }
  }

  async function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const image = [...event.clipboardData.items]
      .find((item) => item.kind === 'file' && supportedImageMediaTypes.includes(item.type as ImageMediaType))
      ?.getAsFile()
    if (!image) return

    event.preventDefault()
    await addImageFiles([image])
  }

  function submitMessage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const content = draft.trim()
    const images = draftImages
    const attachments = draftAttachments
    if ((!content && images.length === 0 && attachments.length === 0) || !canSend || interactionLocked) return
    if (!onSubmit(content, images, attachments)) return
    setDraft('')
    replaceDraftImages([])
    replaceDraftAttachments([])
    setAttachmentMenuOpen(false)
  }

  return (
    <form className="composer" onSubmit={submitMessage}>
      <input
        accept={supportedImageMediaTypes.join(',')}
        hidden
        multiple
        onChange={(event) => void selectImages(event)}
        ref={imageInputRef}
        type="file"
      />
      <input
        accept={supportedMediaTypes.video.join(',')}
        hidden
        multiple
        onChange={(event) => void selectMedia('video', event)}
        ref={videoInputRef}
        type="file"
      />
      <input
        accept={supportedMediaTypes.audio.join(',')}
        hidden
        multiple
        onChange={(event) => void selectMedia('audio', event)}
        ref={audioInputRef}
        type="file"
      />
      <input
        accept={supportedMediaTypes.pdf.join(',')}
        hidden
        multiple
        onChange={(event) => void selectMedia('pdf', event)}
        ref={pdfInputRef}
        type="file"
      />
      {draftImages.length > 0 && (
        <div className="draft-images">
          {draftImages.map((image) => (
            <div className="draft-image" key={image.id}>
              <img alt={image.name} src={image.dataUrl} />
              <Button
                aria-label={t('removeImage')}
                appearance="subtle"
                onClick={() => replaceDraftImages(draftImagesRef.current.filter((item) => item.id !== image.id))}
                shape="circular"
                size="small"
                title={t('removeImage')}
                type="button"
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      )}
      {draftAttachments.length > 0 && (
        <div className="draft-attachments">
          {draftAttachments.map((attachment) => (
            <span className={`draft-attachment draft-attachment-${attachment.kind}`} key={attachment.id}>
              <span>{attachment.name}</span>
              <Button
                aria-label={t('removeAttachment')}
                appearance="subtle"
                onClick={() => replaceDraftAttachments(draftAttachmentsRef.current.filter((item) => item.id !== attachment.id))}
                shape="circular"
                size="small"
                title={t('removeAttachment')}
                type="button"
              >
                ×
              </Button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-side-controls">
        <div className="attachment-menu" ref={attachmentMenuRef}>
          <Button
            appearance="secondary"
            aria-expanded={attachmentMenuOpen}
            aria-haspopup="menu"
            disabled={!canSend || interactionLocked}
            onClick={() => setAttachmentMenuOpen((open) => !open)}
            title={t('addAttachment')}
            type="button"
          >
            +
          </Button>
          {attachmentMenuOpen && (
            <div className="attachment-menu-popover" role="menu">
              <Button
                appearance="subtle"
                className="attachment-menu-item" disabled={!supportsImageInput}
                onClick={() => {
                  setAttachmentMenuOpen(false)
                  void captureScreen(false)
                }}
                role="menuitem"
                type="button"
              >
                {t('captureScreenshot')}
              </Button>
              <Button
                appearance="subtle"
                className="attachment-menu-item" disabled={!supportsImageInput}
                onClick={() => {
                  setAttachmentMenuOpen(false)
                  void captureScreen(true)
                }}
                role="menuitem"
                type="button"
              >
                {t('captureScreenshotHideWindow')}
              </Button>
              <Button
                appearance="subtle"
                className="attachment-menu-item" disabled={!supportsImageInput}
                onClick={() => {
                  setAttachmentMenuOpen(false)
                  imageInputRef.current?.click()
                }}
                role="menuitem"
                type="button"
              >
                {t('uploadImage')}
              </Button>
              {mediaUploadMenuEnabled && (
                <>
                  <Button
                    appearance="subtle"
                    className="attachment-menu-item" disabled={!supportsVideoInput}
                    onClick={() => {
                      setAttachmentMenuOpen(false)
                      videoInputRef.current?.click()
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {t('uploadVideo')}
                  </Button>
                  <Button
                    appearance="subtle"
                    className="attachment-menu-item" disabled={!supportsAudioInput}
                    onClick={() => {
                      setAttachmentMenuOpen(false)
                      audioInputRef.current?.click()
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {t('uploadAudio')}
                  </Button>
                  <Button
                    appearance="subtle"
                    className="attachment-menu-item" disabled={!supportsPdfInput}
                    onClick={() => {
                      setAttachmentMenuOpen(false)
                      pdfInputRef.current?.click()
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {t('uploadPdf')}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
        <Switch
          checked={networkAccessEnabled}
          className="network-access-switch"
          disabled={interactionLocked}
          label={t('networkAccess')}
          onChange={(_, data) => onNetworkAccessChange(data.checked)}
          title={t('networkAccessWarning')}
        />
      </div>
      <Textarea
        aria-label={t('developmentRequest')}
        className="message-input"
        disabled={!canSend || interactionLocked}
        size="large"
        value={draft}
        onChange={(_, data) => setDraft(data.value)}
        onPaste={(event) => void handlePaste(event)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
        placeholder={
          !configured
            ? t('configureModel')
            : !hasProjectFolders
              ? t('addFolderFirst')
              : t('describeTask')
        }
      />
      {conversationWorking ? (
        <Button
          appearance="primary"
          disabled={stopping || !hasActiveConversation}
          onClick={onStop}
          size="large"
          type="button"
        >
          {t('stop')}
        </Button>
      ) : (
        <Button
          appearance="primary"
          disabled={!canSend || (!draft.trim() && draftImages.length === 0 && draftAttachments.length === 0) || interactionLocked}
          size="large"
          type="submit"
        >
          {t('send')}
        </Button>
      )}
    </form>
  )
})

