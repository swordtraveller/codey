import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import i18n from '../../../src/renderer/src/i18n'
import { CommandExecutionEditorFields, CommandReviewEditor } from '../../../src/renderer/src/components/CommandReviewSettings'
import { defaultModelConfig, defaultCommandReviewConfig, defaultCommandExecutionConfig, type CommandReviewConfig } from '../../../src/shared/types'

const models = [
  { ...defaultModelConfig, id: 'same', name: 'Session model', modelName: 'executor' },
  { ...defaultModelConfig, id: 'auditor', name: 'Auditor', modelName: 'auditor' },
]
const groups = [
  { id: 'group', name: 'Audit group', modelIds: ['same', 'auditor'], retriesPerModel: 2 },
  { id: 'conflict', name: 'Conflicting group', modelIds: ['same'], retriesPerModel: 1 },
  { id: 'empty', name: 'Empty group', modelIds: ['removed'], retriesPerModel: 1 },
]
const assert = (ok: unknown, detail: string) => { if (!ok) throw new Error(detail) }
let draft: CommandReviewConfig
function Harness({ initialId, full, disabled }: { initialId: string; full?: boolean; disabled?: boolean }) {
  const [value, onChange] = useState<CommandReviewConfig>({ ...defaultCommandReviewConfig, contentRules: [],
    reviewers: { auditModel: true, auditModelConfigId: initialId, manualConfirmation: true } })
  draft = value
  const props = { modelConfigs: models, modelGroups: groups, sessionModel: models[0], disabled }
  return <FluentProvider theme={webLightTheme}>
    {full ? <CommandExecutionEditorFields {...props} value={{ ...defaultCommandExecutionConfig, enabled: true, review: value }}
      globalReview={defaultCommandReviewConfig} onChange={next => onChange(next.review!)} />
      : <CommandReviewEditor {...props} value={value} onChange={onChange} />}
  </FluentProvider>
}

export async function runCommandReviewTests(): Promise<string[]> {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  let revision = 0
  const render = async (initialId: string, full = false, disabled = false) => {
    await act(async () => root.render(<Harness key={++revision} initialId={initialId} full={full} disabled={disabled} />))
  }
  const select = () => {
    const label = [...element.querySelectorAll('label')].find(node => node.textContent === i18n.t('commandAuditModel'))
    const input = label?.htmlFor ? document.getElementById(label.htmlFor) : null
    assert(input instanceof HTMLSelectElement, 'audit selector has an accessible translated label')
    return input as HTMLSelectElement
  }
  const warning = () => element.querySelector('[role="alert"]')?.textContent
  try {
    for (const language of ['en', 'zh-CN']) {
      await act(async () => { await i18n.changeLanguage(language) })
      await render('auditor')
      assert(select().value === 'auditor', 'legacy single-model selection retained')
      assert(
        [...select().options].map(option => option.value).join(',') === ['', ...groups.map(group => group.id), ...models.map(model => model.id)].join(','),
        'not configured first, model groups above individual models',
      )
      assert([...select().options].some(option => option.value === 'group' && option.textContent === i18n.t('modelGroupOption', { name: 'Audit group' })), 'group option localized')
      await act(async () => { select().value = 'group'; select().dispatchEvent(new Event('change', { bubbles: true })) })
      assert(draft.reviewers.auditModelConfigId === 'group', 'selecting a group updates the stored target id')
      assert(warning() === i18n.t('commandAuditGroupPartialConflict'), 'partial-conflict warning localized')
      await render('conflict')
      assert(warning() === i18n.t('commandAuditGroupConflict'), 'all-conflict warning localized')
      await render('empty')
      assert(warning() === i18n.t('commandAuditTargetUnavailable'), 'empty group warning localized')
      await render('removed')
      assert(select().value === 'removed' && warning() === i18n.t('commandAuditTargetUnavailable'), 'deleted target stays visible with a warning')
      await render('same')
      assert(select().value === 'same' && warning() === i18n.t('commandAuditModelConflict'), 'conflicting single model stays visible')
      await render('group', true)
      assert(select().value === 'group', 'project/conversation execution editor forwards group options')
      await render('group', true, true)
      assert(select().disabled, 'interaction lock also disables group selection')
      for (const key of ['commandAuditModel', 'commandAuditModelHint', 'commandAuditTargetUnavailable', 'commandAuditGroupConflict', 'commandAuditGroupPartialConflict']) {
        assert(i18n.hasResourceBundle(language, 'translation') && i18n.getResource(language, 'translation', key), language + ' translation missing: ' + key)
      }
    }
    return ['audit group selectors, conflicts, inheritance editor and English/Chinese translations']
  } finally {
    await act(async () => { root.unmount(); await i18n.changeLanguage('en') })
    element.remove()
  }
}
