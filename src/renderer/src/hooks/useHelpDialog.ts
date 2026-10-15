import { useState } from 'react'
import type { ToolHelpSnapshot } from '../../../shared/types'
import type { HelpDialogProps, HelpTab } from '../components/HelpDialog'

export function useHelpDialog(projectRoot?: string) {
  const [open, setOpen] = useState(false)
  const [selectedTab, setSelectedTab] = useState<HelpTab>('tools')
  const [toolHelp, setToolHelp] = useState<ToolHelpSnapshot | null>(null)

  function loadToolHelp(): void {
    setToolHelp(null)
    void window.codey
      .getToolHelpSnapshot(projectRoot)
      .then(setToolHelp)
      .catch(() => setToolHelp(null))
  }

  function openHelp(): void {
    setOpen(true)
    loadToolHelp()
  }

  function openCommandRulesHelp(): void {
    setSelectedTab('commandRules')
    setOpen(true)
  }

  function selectTab(tab: HelpTab): void {
    setSelectedTab(tab)
    if (tab === 'tools' && !toolHelp) loadToolHelp()
  }

  function invalidateToolHelp(): void {
    setToolHelp(null)
  }

  const dialogProps: HelpDialogProps = {
    open,
    selectedTab,
    toolHelp,
    onOpenChange: setOpen,
    onTabChange: selectTab,
  }

  return { dialogProps, openHelp, openCommandRulesHelp, invalidateToolHelp }
}
