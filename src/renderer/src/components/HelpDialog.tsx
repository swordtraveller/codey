import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Tab,
  TabList,
} from '@fluentui/react-components'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToolHelpSnapshot } from '../../../shared/types'

export type HelpTab = 'tools' | 'commandRules'

export type HelpDialogProps = {
  open: boolean
  selectedTab: HelpTab
  toolHelp: ToolHelpSnapshot | null
  onOpenChange: (open: boolean) => void
  onTabChange: (tab: HelpTab) => void
}

/** Renders text with <mark> highlights around case-insensitive keyword matches. */
function HighlightedText({ text, keyword }: { text: string; keyword: string }): React.JSX.Element {
  const trimmed = keyword.trim()
  if (!trimmed) return <>{text}</>
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'ig'))
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === trimmed.toLowerCase()
          ? <mark key={index}>{part}</mark>
          : <span key={index}>{part}</span>,
      )}
    </>
  )
}

export function HelpDialog({
  open,
  selectedTab,
  toolHelp,
  onOpenChange,
  onTabChange,
}: HelpDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [toolSearch, setToolSearch] = useState('')
  const [toolMatchIndex, setToolMatchIndex] = useState(0)
  const toolListRef = useRef<HTMLDivElement>(null)

  const toolKeyword = toolSearch.trim().toLowerCase()
  const toolMatches = useMemo(
    () => (toolHelp && toolKeyword
      ? toolHelp.entries.filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(toolKeyword))
      : []),
    [toolHelp, toolKeyword],
  )

  // Keyword changes reset the jump position; the effect scrolls to it.
  useEffect(() => {
    setToolMatchIndex(0)
  }, [toolKeyword])

  useEffect(() => {
    if (!open || toolMatches.length === 0) return
    const container = toolListRef.current
    if (!container) return
    const name = toolMatches[Math.min(toolMatchIndex, toolMatches.length - 1)]?.name ?? ''
    const target = container.querySelector<HTMLElement>(`[data-tool-name="${CSS.escape(name)}"]`)
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [toolMatchIndex, toolMatches, open])

  function jumpToMatch(direction: 1 | -1): void {
    if (toolMatches.length === 0) return
    setToolMatchIndex((current) => (current + direction + toolMatches.length) % toolMatches.length)
  }

  function isCurrentMatch(name: string): boolean {
    if (toolMatches.length === 0) return false
    return toolMatches[Math.min(toolMatchIndex, toolMatches.length - 1)]?.name === name
  }

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('help')}</DialogTitle>
          <DialogContent className="dialog-fields">
            <TabList
              selectedValue={selectedTab}
              onTabSelect={(_, data) => onTabChange(data.value as HelpTab)}
            >
              <Tab value="tools">{t('helpTools')}</Tab>
              <Tab value="commandRules">{t('helpCommandRules')}</Tab>
            </TabList>
            {selectedTab === 'commandRules' && (
              <section className="settings-group command-rules-help">
                <p className="settings-description">{t('helpCommandRulesIntro')}</p>
                <p className="section-label">{t('helpCommandRulesPatterns')}</p>
                <ul className="command-rules-help-list">
                  <li><code>git status</code> — {t('helpCommandRulesExact')}</li>
                  <li><code>git *</code> — {t('helpCommandRulesStar')}</li>
                  <li><code>pnpm run build *</code> — {t('helpCommandRulesTailStar')}</li>
                  <li><code>npm run ?</code> — {t('helpCommandRulesQuestion')}</li>
                  <li><code>git commit -m "fix bug"</code> — {t('helpCommandRulesQuoted')}</li>
                </ul>
                <p className="section-label">{t('helpCommandRulesSemantics')}</p>
                <ul className="command-rules-help-list">
                  <li>{t('helpCommandRulesCase')}</li>
                  <li>{t('helpCommandRulesPrecedence')}</li>
                  <li>{t('helpCommandRulesMutex')}</li>
                  <li>{t('helpCommandRulesDuration')}</li>
                  <li>{t('helpCommandRulesBuiltin')}</li>
                  <li>{t('helpCommandRulesRegex')}</li>
                </ul>
              </section>
            )}
            {selectedTab === 'tools' && (
              <section className="settings-group tool-help-group">
                <p className="settings-description">
                  {toolHelp
                    ? toolSearch.trim()
                      ? t('helpToolMatchCount', { count: toolMatches.length, total: toolHelp.entries.length })
                      : t('helpToolTotalCount', { count: toolHelp.entries.length })
                    : ''}
                </p>
                {toolHelp && <p className="settings-description">{t('helpToolToolsetNote')}</p>}
                <div className="tool-search-row">
                  <div className="tool-search-field">
                    <Field label={t('helpToolSearch')}>
                      <Input
                        value={toolSearch}
                        onChange={(_, data) => setToolSearch(data.value)}
                        placeholder={t('helpToolSearchPlaceholder')}
                      />
                    </Field>
                  </div>
                  {toolMatches.length > 1 && (
                    <div className="tool-search-nav">
                      <Button appearance="subtle" size="small" aria-label={t('helpToolPreviousMatch')} onClick={() => jumpToMatch(-1)}>
                        ↑
                      </Button>
                      <span className="tool-match-position">{toolMatchIndex + 1} / {toolMatches.length}</span>
                      <Button appearance="subtle" size="small" aria-label={t('helpToolNextMatch')} onClick={() => jumpToMatch(1)}>
                        ↓
                      </Button>
                    </div>
                  )}
                </div>
                <div className="tool-help-list" ref={toolListRef}>
                  {!toolHelp && <p className="settings-description">{t('loadingPrompts')}</p>}
                  {toolHelp && (() => {
                    const renderEntry = (entry: typeof toolHelp.entries[number], showToolset: boolean) => (
                      <div className={`tool-help-entry${isCurrentMatch(entry.name) ? ' current-match' : ''}`} data-tool-name={entry.name} key={entry.name}>
                        <h3>
                          <HighlightedText keyword={toolSearch} text={entry.name} />
                          {showToolset && entry.toolset && (
                            <span className="tool-help-toolset" title={t('helpToolToolsetTitle', { toolset: entry.toolset })}>
                              {t('helpToolToolset', { toolset: entry.toolset })}
                            </span>
                          )}
                        </h3>
                        <p className="settings-description">{entry.description}</p>
                        <details>
                          <summary>{t('helpToolParameters')}</summary>
                          <pre className="prompt-content">{entry.parameters}</pre>
                        </details>
                        <p className="tool-help-returns">{t('helpToolReturns')}: {entry.returns}</p>
                      </div>
                    )
                    const groupEntries = (hidden: boolean) => {
                      const groups = new Map<string, typeof toolHelp.entries>()
                      for (const entry of toolHelp.entries) {
                        if (entry.source === 'mcp' || !entry.toolset || entry.toolsetHidden !== hidden) continue
                        const bucket = groups.get(entry.toolset) ?? []
                        bucket.push(entry)
                        groups.set(entry.toolset, bucket)
                      }
                      return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
                    }
                    const mcpGroups = new Map<string, typeof toolHelp.entries>()
                    for (const entry of toolHelp.entries) {
                      if (entry.source !== 'mcp' || !entry.toolset) continue
                      const bucket = mcpGroups.get(entry.toolset) ?? []
                      bucket.push(entry)
                      mcpGroups.set(entry.toolset, bucket)
                    }
                    // Search keeps the flat list so match navigation stays
                    // contiguous; the catalog view groups built-in tools by
                    // toolset and MCP tools by the compact facade group.
                    if (toolSearch.trim()) {
                      return toolMatches.map((entry) => renderEntry(entry, true))
                    }
                    return (
                      <>
                        <h4 className="tool-help-group-header">{t('helpToolMetaSection')}</h4>
                        {toolHelp.entries.filter((entry) => entry.source !== 'mcp' && !entry.toolset).map((entry) => renderEntry(entry, false))}
                        <h4 className="tool-help-group-header">{t('helpToolsetUnlockedSection')}</h4>
                        {groupEntries(false).map(([toolset, entries]) => (
                          <div key={toolset}>
                            <h5 className="tool-help-toolset-header">
                              {toolset}
                              <span className="tool-help-toolset-state">{t('helpToolsetUnlockedLabel')}</span>
                            </h5>
                            {entries.map((entry) => renderEntry(entry, false))}
                          </div>
                        ))}
                        <h4 className="tool-help-group-header">{t('helpToolsetOnDemandSection')}</h4>
                        {groupEntries(true).map(([toolset, entries]) => (
                          <div key={toolset}>
                            <h5 className="tool-help-toolset-header">
                              {toolset}
                              <span className="tool-help-toolset-state">{t('helpToolsetOnDemandLabel')}</span>
                            </h5>
                            {entries.map((entry) => renderEntry(entry, false))}
                          </div>
                        ))}
                        {mcpGroups.size > 0 && (
                          <>
                            <h4 className="tool-help-group-header">{t('helpMcpSection')}</h4>
                            {[...mcpGroups.entries()]
                              .sort(([a], [b]) => a.localeCompare(b))
                              .map(([toolset, entries]) => (
                                <div key={toolset}>
                                  <h5 className="tool-help-toolset-header">
                                    {toolset}
                                    <span className="tool-help-toolset-state">{t('helpMcpRuntimeLabel')}</span>
                                  </h5>
                                  {entries.map((entry) => renderEntry(entry, false))}
                                </div>
                              ))}
                          </>
                        )}
                      </>
                    )
                  })()}
                </div>
              </section>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>
              {t('close')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
