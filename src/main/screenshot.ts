import { clipboard, desktopCapturer, type BrowserWindow, type Display, type NativeImage, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  maximumImageAttachmentBytes,
  type ImageAttachment,
  type ImageMediaType,
} from '../shared/image-attachments'
import type { ScreenshotSelection } from '../shared/types'

const captureDelayMs = 200

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function captureDisplay(window: BrowserWindow, hideWindow: boolean): Promise<{
  display: Display
  image: NativeImage
  restoreWindow: () => void
}> {
  const display = screen.getDisplayMatching(window.getBounds())
  const wasVisible = window.isVisible()
  if (hideWindow && wasVisible) {
    window.hide()
    await delay(captureDelayMs)
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    })
    const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty()) throw new Error('Unable to capture the display')
    let restored = false
    const restoreWindow = (): void => {
      if (restored) return
      restored = true
      if (hideWindow && wasVisible && !window.isDestroyed()) {
        window.show()
        window.focus()
      }
    }
    return { display, image: source.thumbnail, restoreWindow }
  } catch (error) {
    if (hideWindow && wasVisible && !window.isDestroyed()) {
      window.show()
      window.focus()
    }
    throw error
  }
}

export function cropScreenshot(image: NativeImage, selection: ScreenshotSelection, display: Display): NativeImage {
  const sourceSize = image.getSize()
  const scaleX = sourceSize.width / display.bounds.width
  const scaleY = sourceSize.height / display.bounds.height
  const left = Math.max(0, Math.min(display.bounds.width, selection.x))
  const top = Math.max(0, Math.min(display.bounds.height, selection.y))
  const right = Math.max(left, Math.min(display.bounds.width, selection.x + selection.width))
  const bottom = Math.max(top, Math.min(display.bounds.height, selection.y + selection.height))
  const x = Math.floor(left * scaleX)
  const y = Math.floor(top * scaleY)
  const width = Math.max(1, Math.floor((right - left) * scaleX))
  const height = Math.max(1, Math.floor((bottom - top) * scaleY))
  return image.crop({
    x,
    y,
    width: Math.min(width, sourceSize.width - x),
    height: Math.min(height, sourceSize.height - y),
  })
}

export function createImageAttachment(image: NativeImage): ImageAttachment {
  let encoded = image.toPNG()
  let mediaType: ImageMediaType = 'image/png'
  let extension = 'png'
  let resized = image

  if (encoded.length > maximumImageAttachmentBytes) {
    encoded = resized.toJPEG(85)
    mediaType = 'image/jpeg'
    extension = 'jpg'
  }

  while (encoded.length > maximumImageAttachmentBytes && resized.getSize().width > 640) {
    const size = resized.getSize()
    resized = resized.resize({ width: Math.floor(size.width * 0.8), quality: 'good' })
    encoded = resized.toJPEG(85)
  }

  if (encoded.length > maximumImageAttachmentBytes) {
    throw new Error('Screenshot is too large to attach')
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return {
    id: randomUUID(),
    name: `screenshot-${timestamp}.${extension}`,
    mediaType,
    dataUrl: `data:${mediaType};base64,${encoded.toString('base64')}`,
  }
}

export function copyImageToClipboard(image: NativeImage): void {
  clipboard.writeImage(image)
}