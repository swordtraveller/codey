import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppConfig, ListSortPreference, SidebarSortPreferences } from '../../../shared/types'

export function useSidebarSorting({ config, setConfig, setConfigDraft, onError }: {
  config: AppConfig
  setConfig: Dispatch<SetStateAction<AppConfig>>
  setConfigDraft: Dispatch<SetStateAction<AppConfig>>
  onError: (message: string) => void
}): { sortingSaving: boolean; saveSort: (list: keyof SidebarSortPreferences, value: ListSortPreference) => Promise<void> } {
  const { t } = useTranslation()
  const busy = useRef(false)
  const [sortingSaving, setSortingSaving] = useState(false)
  async function saveSort(list: keyof SidebarSortPreferences, value: ListSortPreference): Promise<void> {
    if (busy.current) return
    busy.current = true
    setSortingSaving(true)
    try {
      const sidebarSort = await window.codey.saveSidebarSort({ ...config.sidebarSort, [list]: value })
      setConfig(current => ({ ...current, sidebarSort }))
      setConfigDraft(current => ({ ...current, sidebarSort }))
    } catch {
      onError(t('sidebarSortSaveFailed'))
    } finally {
      busy.current = false
      setSortingSaving(false)
    }
  }
  return { sortingSaving, saveSort }
}
