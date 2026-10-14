import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageNavigationEntry } from '../../shared/message-navigation'
import { setAppLanguage } from './i18n'

export function MessageNavigationApp(): React.JSX.Element {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<MessageNavigationEntry[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.codey.getConfig().then((config) => { if (active) setAppLanguage(config.language) }).catch(() => undefined)
    void window.codey.getMessageNavigationEntries().then((items) => { if (active) setEntries(items) })
      .catch((reason) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [])
  useEffect(() => { document.title = t('messageNavigation') }, [t])
  useEffect(() => {
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') window.close() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [])
  return <main className="message-navigation-window">
    <h1>{t('messageNavigation')}</h1>
    {error ? <p role="alert">{t('unableLoadConversationMessages')} {error}</p>
      : entries === null ? <p role="status">{t('loadingConversationMessages')}</p>
      : entries.length === 0 ? <p>{t('messageNavigationEmpty')}</p>
      : <ol className="message-navigation-list">
        {entries.map((entry, index) => <li key={entry.id}>
          <button type="button" onClick={() => window.codey.selectMessageNavigation(entry.id)}>
            <span className="message-navigation-number" aria-hidden="true">{index + 1}</span>
            <span className="message-navigation-preview" title={entry.preview}>{entry.preview || t('messageNavigationAttachment')}</span>
          </button>
        </li>)}
      </ol>}
  </main>
}
