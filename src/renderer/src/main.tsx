import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './i18n'
import { App } from './App'
import { ContextDebugApp } from './ContextDebugApp'
import { ScreenshotOverlay } from './ScreenshotOverlay'
import './styles.css'

const root = document.querySelector<HTMLDivElement>('#root')
if (!root) throw new Error('Application root was not found')

const params = new URLSearchParams(window.location.search)
const content = params.get('view') === 'context-debug'
  ? <ContextDebugApp
      projectId={params.get('projectId') ?? ''}
      conversationId={params.get('conversationId') ?? ''}
    />
  : params.get('view') === 'screenshot-overlay'
    ? <ScreenshotOverlay />
    : <App />

createRoot(root).render(<StrictMode>{content}</StrictMode>)