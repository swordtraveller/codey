import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ScreenshotSelection, ScreenshotSource } from '../../shared/types'

type Point = { x: number; y: number }

function selectionFromPoints(start: Point, end: Point): ScreenshotSelection {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

export function ScreenshotOverlay(): React.JSX.Element {
  const { t } = useTranslation()
  const [source, setSource] = useState<ScreenshotSource | null>(null)
  const [selection, setSelection] = useState<ScreenshotSelection | null>(null)
  const startRef = useRef<Point | null>(null)
  const captureIdRef = useRef('')

  useEffect(() => window.codey.onScreenshotSource((nextSource) => {
    captureIdRef.current = nextSource.captureId
    setSource(nextSource)
  }), [])

  useEffect(() => {
    function cancelOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape' && captureIdRef.current) {
        window.codey.cancelScreenshotSelection(captureIdRef.current)
      }
    }
    window.addEventListener('keydown', cancelOnEscape)
    return () => window.removeEventListener('keydown', cancelOnEscape)
  }, [])

  function beginSelection(event: PointerEvent<HTMLDivElement>): void {
    if (!source) return
    event.currentTarget.setPointerCapture(event.pointerId)
    startRef.current = { x: event.nativeEvent.offsetX, y: event.nativeEvent.offsetY }
    setSelection(null)
  }

  function updateSelection(event: PointerEvent<HTMLDivElement>): void {
    const start = startRef.current
    if (!source || !start) return
    setSelection(selectionFromPoints(start, {
      x: event.nativeEvent.offsetX,
      y: event.nativeEvent.offsetY,
    }))
  }

  function finishSelection(event: PointerEvent<HTMLDivElement>): void {
    const start = startRef.current
    if (!source || !start) return
    const next = selectionFromPoints(start, {
      x: event.nativeEvent.offsetX,
      y: event.nativeEvent.offsetY,
    })
    startRef.current = null
    if (next.width < 4 || next.height < 4) return
    setSelection(next)
    window.codey.completeScreenshotSelection(source.captureId, next)
  }

  function cancel(): void {
    if (captureIdRef.current) window.codey.cancelScreenshotSelection(captureIdRef.current)
  }

  return (
    <main className="screenshot-overlay">
      {source && (
        <>
          <img alt="" className="screenshot-overlay-image" draggable={false} src={source.dataUrl} />
          <div className="screenshot-overlay-shade" />
          {selection && (
            <div
              className="screenshot-overlay-selection"
              style={{
                left: `${selection.x}px`,
                top: `${selection.y}px`,
                width: `${selection.width}px`,
                height: `${selection.height}px`,
              }}
            />
          )}
          <div
            className="screenshot-overlay-interaction"
            onPointerDown={beginSelection}
            onPointerMove={updateSelection}
            onPointerUp={finishSelection}
          />
          <div className="screenshot-overlay-toolbar">
            <span>{t('screenshotSelectHint')}</span>
            <button onClick={cancel} type="button">{t('cancel')}</button>
          </div>
        </>
      )}
    </main>
  )
}