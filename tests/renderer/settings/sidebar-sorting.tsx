import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import i18n from '../../../src/renderer/src/i18n'
import { ListSortMenu } from '../../../src/renderer/src/components/ListSortMenu'
import { SidebarStatus } from '../../../src/renderer/src/components/SidebarStatus'
import { useSidebarSorting } from '../../../src/renderer/src/hooks/useSidebarSorting'
import { useListScrollAnchor } from '../../../src/renderer/src/hooks/useListScrollAnchor'
import { defaultAppConfig, type AppConfig, type SidebarSortPreferences } from '../../../src/shared/types'

const assert = (value: unknown, detail: string) => { if (!value) throw new Error(detail) }
const equal = (actual: unknown, expected: unknown, detail: string) => {
  assert(JSON.stringify(actual) === JSON.stringify(expected), detail + ': ' + JSON.stringify(actual))
}
let state: { config: AppConfig; draft: AppConfig; api: ReturnType<typeof useSidebarSorting> }
function Harness() {
  const [config, setConfig] = useState(() => structuredClone(defaultAppConfig))
  const [draft, setConfigDraft] = useState<AppConfig>(() => ({ ...structuredClone(defaultAppConfig), language: 'en' as const, developerMode: true }))
  const api = useSidebarSorting({ config, setConfig, setConfigDraft, onError: message => errors.push(message) })
  state = { config, draft, api }
  return <FluentProvider theme={webLightTheme}><ListSortMenu label={i18n.t('projects')}
    value={config.sidebarSort.projects} disabled={api.sortingSaving} onChange={value => void api.saveSort('projects', value)} /></FluentProvider>
}
let errors: string[] = []
let saveCalls: SidebarSortPreferences[] = []
let save: (value: SidebarSortPreferences) => Promise<SidebarSortPreferences>
let ids = Array.from({ length: 15 }, (_, index) => 'row-' + index)
let scope = 'project-one'
function ScrollHarness() {
  const anchor = useListScrollAnchor(ids, scope)
  return <nav {...anchor} style={{ height: 90, overflowY: 'auto', overflowAnchor: 'none' }}>
    {ids.map(id => <div key={id} data-nav-id={id} style={{ height: 30 }}>{id}</div>)}
  </nav>
}

export async function runSidebarSortingTests(): Promise<string[]> {
  const oldSave = window.codey.saveSidebarSort
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  const passed: string[] = []
  let revision = 0
  window.codey.saveSidebarSort = async value => { saveCalls.push(structuredClone(value)); return save(value) }
  const render = async () => {
    errors = []; saveCalls = []; save = async value => value
    await act(async () => { root.render(<Harness key={++revision} />) })
  }
  const click = async (node: HTMLElement | undefined | null) => {
    assert(node, 'expected clickable element')
    await act(async () => { node!.click() })
  }
  const radio = (key: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent === i18n.t(key))
  try {
    await act(async () => {
      root.render(<FluentProvider theme={webLightTheme}><SidebarStatus unreadCount={2} error runningCount={1} project /></FluentProvider>)
    })
    const processing = element.querySelector('.sidebar-processing')
    assert(processing, 'running sidebar item renders a processing indicator')
    assert(processing?.getAttribute('title') === i18n.t('projectProcessing', { count: 1 }), 'project processing tooltip is localized')
    assert(processing?.querySelector('[aria-label]')?.getAttribute('aria-label') === i18n.t('projectProcessing', { count: 1 }), 'processing indicator is accessible')
    assert(element.textContent?.includes('2'), 'running state preserves unread count')
    assert(element.textContent?.includes('!'), 'running state preserves error marker')
    await act(async () => {
      root.render(<FluentProvider theme={webLightTheme}><SidebarStatus unreadCount={2} error runningCount={0} /></FluentProvider>)
    })
    assert(!element.querySelector('.sidebar-processing'), 'finished sidebar item removes processing indicator')
    passed.push('sidebar processing indicator coexists with unread and error badges')

    for (const language of ['en', 'zh-CN']) {
      await act(async () => { await i18n.changeLanguage(language) })
      for (const project of [false, true]) {
        for (const runningCount of [1, 2]) {
          await act(async () => {
            root.render(<FluentProvider theme={webLightTheme}><SidebarStatus unreadCount={0} runningCount={runningCount} project={project} /></FluentProvider>)
          })
          const label = project ? i18n.t('projectProcessing', { count: runningCount }) : i18n.t('conversationProcessing')
          assert(element.querySelector('.sidebar-processing')?.getAttribute('title') === label, language + ' localized processing tooltip')
          assert(!label.includes('projectProcessing'), 'project plural translation resolves')
          assert(element.querySelectorAll('.sidebar-processing').length === 1, 'concurrent tasks share one project spinner')
        }
      }
      await act(async () => { root.render(<SidebarStatus unreadCount={0} runningCount={0} />) })
      assert(!element.querySelector('.sidebar-status'), 'idle and read item has no status badge')
      await render()
      const button = element.querySelector('button')!
      assert(button.getAttribute('aria-label') === i18n.t('sidebarSortList', { list: i18n.t('projects') }), 'sort button accessible label is localized')
      await click(button)
      for (const key of ['sidebarSortName', 'sidebarSortActivity', 'sidebarSortCreated', 'sidebarSortNewest', 'sidebarSortOldest']) {
        assert(radio(key), language + ' missing menu radio ' + key)
      }
      assert(radio('sidebarSortActivity')?.getAttribute('aria-checked') === 'true', 'activity selected by default')
      await click(radio('sidebarSortName'))
      equal(state.config.sidebarSort.projects, { by: 'name', direction: 'asc' }, 'name chooses natural ascending default')
      // Open if selection closed the menu; radio menus may remain open in Fluent.
      if (!radio('sidebarSortZA')) await click(button)
      await click(radio('sidebarSortZA'))
      equal(state.config.sidebarSort.projects, { by: 'name', direction: 'desc' }, 'name descending persisted')
      if (!radio('sidebarSortCreated')) await click(button)
      await click(radio('sidebarSortCreated'))
      equal(state.config.sidebarSort.projects, { by: 'created', direction: 'desc' }, 'creation chooses newest default')
      if (!radio('sidebarSortOldest')) await click(button)
      await click(radio('sidebarSortOldest'))
      equal(state.config.sidebarSort.projects, { by: 'created', direction: 'asc' }, 'oldest direction persisted')
      equal(state.config.sidebarSort.conversations, defaultAppConfig.sidebarSort.conversations, 'project menu leaves conversation preference unchanged')
      passed.push(language + ' sidebar sort menu modes, directions and labels')
    }
    await render()
    let resolve!: (value: SidebarSortPreferences) => void
    save = () => new Promise(done => { resolve = done })
    let first!: Promise<void>
    await act(async () => {
      first = state.api.saveSort('projects', { by: 'name', direction: 'asc' })
      void state.api.saveSort('conversations', { by: 'created', direction: 'asc' })
    })
    assert(saveCalls.length === 1 && state.api.sortingSaving, 'rapid duplicate requests are locked before React rerenders')
    assert(element.querySelector('button')?.disabled, 'button disabled during save')
    equal(state.config.sidebarSort, defaultAppConfig.sidebarSort, 'no reorder before durable save')
    await act(async () => { resolve(saveCalls[0]); await first })
    equal(state.config.sidebarSort, saveCalls[0], 'successful save updates live config')
    equal(state.draft.sidebarSort, saveCalls[0], 'successful save updates draft preferences only')
    assert(state.draft.language === 'en' && state.draft.developerMode, 'unrelated unsaved draft settings preserved')
    assert(!state.api.sortingSaving, 'save lock released')
    passed.push('sidebar save lock, durable state and unsaved draft preservation')

    await render()
    save = async () => { throw new Error('disk unavailable') }
    await act(async () => { await state.api.saveSort('conversations', { by: 'name', direction: 'asc' }) })
    equal(state.config.sidebarSort, defaultAppConfig.sidebarSort, 'failure preserves previous order')
    equal(errors, [i18n.t('sidebarSortSaveFailed')], 'failure toast localized')
    assert(!state.api.sortingSaving, 'failed save releases busy lock')
    save = async value => value
    await act(async () => { await state.api.saveSort('conversations', { by: 'name', direction: 'asc' }) })
    equal(state.config.sidebarSort.conversations, { by: 'name', direction: 'asc' }, 'retry succeeds')
    passed.push('sidebar save failure and retry')

    await act(async () => { root.render(<ScrollHarness />) })
    const list = element.querySelector('nav')!
    list.scrollTop = 92
    await act(async () => { list.dispatchEvent(new Event('scroll', { bubbles: true })) })
    const anchored = element.querySelector<HTMLElement>('[data-nav-id="row-3"]')!
    const top = anchored.getBoundingClientRect().top
    ids = ['new-row', ...ids]
    await act(async () => { root.render(<ScrollHarness />) })
    assert(Math.abs(anchored.getBoundingClientRect().top - top) <= 1, 'background reordering preserves first visible row offset')
    scope = 'project-two'
    ids = Array.from({ length: 15 }, (_, index) => 'other-' + index)
    await act(async () => { root.render(<ScrollHarness />) })
    assert(list.scrollTop === 0, 'switching projects resets unrelated conversation scroll')
    ids = ['newest', ...ids]
    await act(async () => { root.render(<ScrollHarness />) })
    assert(list.scrollTop === 0, 'list at top remains at top when a new item arrives')
    passed.push('sidebar scroll anchoring and project scope reset')
    return passed
  } finally {
    window.codey.saveSidebarSort = oldSave
    await act(async () => { root.unmount(); await i18n.changeLanguage('en') })
    element.remove()
  }
}
