import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { modelReferenceKey, reconcileModelReferences } from '../../../src/shared/model-deletion'
import { auditReview } from '../../model-deletion-fixtures'
import i18n from '../../../src/renderer/src/i18n'
import { createDevelopmentProgressState } from '../../../src/shared/development-progress'
import { defaultAppConfig, defaultModelDefinition, type AppConfig, type Project } from '../../../src/shared/types'

const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
const click = async (node: Element | null | undefined) => {
  assert(node, 'click target exists: ' + new Error().stack)
  await act(async () => { (node as HTMLElement).click() })
}
const button = (scope: ParentNode, key: string) => {
  const found = [...scope.querySelectorAll('button')].find(node => node.textContent === i18n.t(key))
  assert(found, 'button exists: ' + key + '; available=' + [...scope.querySelectorAll('button')].map(node => node.textContent).join(', '))
  return found
}
const input = (scope: ParentNode, key: string) => {
  const label = [...scope.querySelectorAll('label')].find(node => node.textContent?.replace(/\s*\*$/, '') === i18n.t(key))
  const field = label?.htmlFor ? document.getElementById(label.htmlFor) : null
  assert(field instanceof HTMLInputElement, 'input exists: ' + key)
  return field as HTMLInputElement
}

const changeInput = async (field: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const escapeDialog = async (surface: Element) => {
  await act(async () => {
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
  })
}
const waitGone = async (selector: string) => {
  for (let attempt = 0; attempt < 100 && document.querySelector(selector); attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
  }
  assert(!document.querySelector(selector), 'dialog closes: ' + selector + '; remaining=' + [...document.querySelectorAll('[role="dialog"]')].map(node => node.textContent?.slice(0, 900)).join(' | '))
}
const waitClosed = () => waitGone('[role="dialog"]')

export async function runModelSettingsTests(): Promise<string[]> {
  const oldCodey = window.codey
  const element = document.createElement('div')
  document.body.appendChild(element)
  const passed: string[] = []
  try {
    for (const language of ['en', 'zh-CN'] as const) {
      await act(async () => { await i18n.changeLanguage(language) })
      let saved: AppConfig = {
        ...structuredClone(defaultAppConfig), language,
        providers: [{ id: 'provider', name: 'Provider', baseUrl: 'https://example.invalid/v1', apiKey: 'test-only' }],
        modelDefinitions: [{ ...defaultModelDefinition, id: 'definition', modelName: 'example-model' }],
        models: [{ id: 'original', name: 'Original', providerId: 'provider', definitionId: 'definition' }],
        modelGroups: [{ id: 'group', name: 'Group', modelIds: ['original'], retriesPerModel: 2 }],
        activeModelConfigId: 'original',
      }
      const project: Project = {
        id: 'model-project', name: 'Project', archived: false, defaultModelConfigId: null,
        contextConfigOverride: null, agentLimitsDefault: null, commandExecutionDefault: null,
        skillSelection: { enabledIds: [], disabledIds: [] }, knowledgeBaseSelection: { enabledIds: [], disabledIds: [] },
        folders: [], pythonEnvironmentFolderId: null,
        conversations: [{ id: 'model-conversation', title: 'Conversation', archived: false, modelConfigId: null,
          contextConfigOverride: null, agentLimits: null, commandExecution: null,
          skillSelection: { enabledIds: [], disabledIds: [] }, knowledgeBaseSelection: { enabledIds: [], disabledIds: [] },
          messages: [], agentMessages: [] }],
      }
      let rejectSave = false
      let saveCalls = 0
      let savedReplacements: Record<string, string | null> = {}
      let selected = ''
      let resolveSave: (() => void) | undefined
      let delaySave = false
      let resolveCapabilities: ((value: unknown) => void) | undefined
      const subscribe = () => () => undefined
      let publishProject: ((project: Project) => void) | undefined
      Object.assign(window, { codey: {
        getConfig: async () => structuredClone(saved),
        saveConfig: async (next: AppConfig, replacements: Record<string, string | null> = {}) => {
          savedReplacements = replacements
          saveCalls++
          if (delaySave) await new Promise<void>(resolve => { resolveSave = resolve })
          if (rejectSave) throw new Error('save failed')
          const repaired = reconcileModelReferences(next, [project], replacements, true, saved)
          Object.assign(project, repaired.projects[0])
          saved = structuredClone(repaired.config)
          return structuredClone(saved)
        },
        fetchModelCapabilities: async () => new Promise(resolve => { resolveCapabilities = resolve }),
        testProviderConnectivity: async () => ({ status: 'ok', models: 1 }),
        listProviderModels: async () => ({ status: 'ok', models: ['example-model', 'extra-model'] }),
        getProjects: async () => [structuredClone(project)],
        getConversationMessages: async () => ({ messages: [], before: null, revision: '' }),
        getConversationRuntimeStates: async () => ({}),
        subscribeDevelopmentProgress: async () => createDevelopmentProgressState(),
        listSkills: async () => [], listKnowledgeBases: async () => [],
        getPerformanceTraceStatus: async () => null,
        getCachedShellDetection: async () => null,
        recordPerformanceTrace: () => undefined,
        onDevelopmentProgress: subscribe, onConversationStateChange: subscribe, onProjectUpdated: (listener: (project: Project) => void) => { publishProject = listener; return () => undefined },
        onNotificationClicked: subscribe, onMessageNavigation: subscribe, onCommandReviewRequest: subscribe,
        setConversationModelConfig: async (_project: string, _conversation: string, id: string) => {
          assert(saved.models.some(model => model.id === id), 'selection references a persisted model')
          selected = id
          const updated = structuredClone(project)
          updated.conversations[0]!.modelConfigId = id
          return updated
        },
      } as unknown as typeof window.codey })
      const root = createRoot(element)
      const picker = () => element.querySelector<HTMLSelectElement>('select[aria-label="' + i18n.t('conversationModel') + '"]')!
      const dialog = () => document.querySelector('.settings-dialog-surface')!
      const confirmation = () => document.querySelector('.unsaved-settings-dialog')!
      const saveButton = () => button(dialog(), 'save') as HTMLButtonElement
      try {
        const open = async () => { await click(button(element, 'settings')) }
        const cancel = async () => { await click(button(dialog(), 'cancel')) }
        const discard = async () => { await click(button(confirmation(), 'settingsDiscardExit')); await waitClosed() }
        const addModel = async (name: string) => {
          const select = dialog().querySelector('select[aria-label="' + i18n.t('modelsSection') + '"]')!
          await click(button(select.closest('.layer-config-toolbar')!, 'addModelConfig'))
          await changeInput(input(dialog(), 'modelConfigName'), name)
          return (dialog().querySelector('select[aria-label="' + i18n.t('modelsSection') + '"]') as HTMLSelectElement).value
        }
        await act(async () => { root.render(<App />) })
        assert(picker()?.options.length === 3, 'inheritance, group and original model initially visible')
        await open()
        await cancel()
        await waitClosed()
        assert(!confirmation(), 'unchanged settings close without confirmation')
        await open()
        await changeInput(input(dialog(), 'providerName'), 'Changed provider')
        await changeInput(input(dialog(), 'providerName'), 'Provider')
        await cancel()
        await waitClosed()
        assert(!confirmation(), 'reverted edits close without confirmation')
        passed.push(language + ' unchanged and reverted drafts do not prompt')

        const deletion = () => document.querySelector('.model-deletion-dialog')!
        for (const key of ['deleteModelConfig', 'deleteProvider', 'deleteDefinition', 'deleteGroup']) {
          await open()
          await click(button(dialog(), key))
          assert(deletion()?.textContent?.includes('Group'), 'linked confirmation names the affected group')
          if (key !== 'deleteGroup') {
            assert(deletion().textContent?.includes('Original'), 'cascade confirmation names concrete model')
            assert((button(deletion(), 'modelDeleteConfirm') as HTMLButtonElement).disabled, 'last concrete model cannot be deleted')
            assert(deletion().textContent?.includes(i18n.t('modelDeleteLastBlocked')), 'last model guidance is localized')
          }
          await escapeDialog(deletion())
          await waitGone('.model-deletion-dialog')
          assert(dialog() && !confirmation(), 'Escape dismisses only deletion confirmation')
          await cancel()
          await waitClosed()
          assert(!confirmation(), 'cancelled deletion does not dirty settings')
        }
        passed.push(language + ' all deletion types preview dependencies; last model is protected; Escape preserves settings')


        await open()
        await changeInput(input(dialog(), 'apiKey'), 'secret-must-not-appear')
        await cancel()
        assert(confirmation()?.textContent?.includes('Provider'), 'summary identifies modified provider')
        assert(!confirmation().textContent?.includes('secret-must-not-appear'), 'summary does not expose credentials')
        await click(button(confirmation(), 'settingsContinueEditing'))
        await waitGone('.unsaved-settings-dialog')
        assert(dialog() && input(dialog(), 'apiKey').value === 'secret-must-not-appear', 'continue editing preserves changes')
        await escapeDialog(dialog())
        assert(confirmation(), 'escape on settings prompts before closing')
        await discard()
        await open()
        assert(input(dialog(), 'apiKey').value === 'test-only', 'discard restores saved values')
        await cancel()
        await waitClosed()
        passed.push(language + ' cancel and Escape protect drafts; discard restores saved state')

        await open()
        const draftModelId = await addModel('New model')
        assert(dialog().querySelectorAll('.group-member-picker input[type="checkbox"]').length === 1, 'new model is offered to group from draft')
        await click(button(dialog(), 'addGroup'))
        assert(saveButton().disabled, 'invalid group prevents footer save')
        await cancel()
        assert((button(confirmation(), 'save') as HTMLButtonElement).disabled, 'invalid group cannot bypass confirmation validation')
        assert(confirmation().textContent?.includes(i18n.t('settingsCannotSave')), 'invalid settings guidance localized')
        await escapeDialog(confirmation())
        await waitGone('.unsaved-settings-dialog')
        await changeInput(input(dialog(), 'groupName'), 'New group')
        assert(!saveButton().disabled, 'valid draft enables save')
        assert(dialog().textContent?.includes(i18n.t('modelSettingsSaveHint')), 'single save policy localized')
        assert(![...picker().options].some(option => option.value === draftModelId), 'unsaved models cannot become executable selections')
        assert(!element.textContent?.includes('模型配置未保存') && !element.textContent?.includes('Model settings not saved'), 'conversation no longer exposes unsaved-model reminder')
        await cancel()
        assert(saved.models.length === 1 && saveCalls === 0, 'cancel does not auto-save')
        assert(confirmation().textContent?.includes('New model') && confirmation().textContent?.includes('New group'), 'confirmation lists each unsaved model and group')
        rejectSave = true
        await click(button(confirmation(), 'save'))
        assert(confirmation().textContent?.includes(i18n.t('settingsSaveFailed')), 'failed save remains open with localized error')
        assert(![...picker().options].some(option => option.value === draftModelId), 'failed save does not publish draft')
        rejectSave = false
        delaySave = true
        await click(button(confirmation(), 'save'))
        assert((button(confirmation(), 'settingsDiscardExit') as HTMLButtonElement).disabled, 'cannot discard an in-flight save')
        await escapeDialog(confirmation())
        assert(confirmation(), 'cannot dismiss an in-flight save')
        assert(saveCalls === 2, 'only one retry is submitted')
        await act(async () => { resolveSave!() })
        delaySave = false
        await waitClosed()
        const options = [...picker().options]
        assert(options.some(option => option.value === draftModelId && option.text === 'New model'), 'saved model appears immediately without restart')
        assert(options[1]?.value === 'group' && options[2]?.text.includes('New group'), 'groups remain above individual models')
        await act(async () => { picker().value = draftModelId; picker().dispatchEvent(new Event('change', { bubbles: true })) })
        assert(selected === draftModelId && picker().value === draftModelId, 'saved model can be selected by conversation')
        passed.push(language + ' confirmation validates, retries failed saves, guards in-flight saves and refreshes picker')

        await open()
        await changeInput(input(dialog(), 'providerName'), 'Renamed provider')
        await click(saveButton())
        await waitClosed()
        assert(saved.providers[0]!.name === 'Renamed provider', 'footer save still persists and closes')
        await open()
        const providerToolbar = dialog().querySelector('select[aria-label="' + i18n.t('providersSection') + '"]')!.closest('.layer-config-toolbar')!
        await click(button(providerToolbar, 'testConnectivity'))
        await cancel()
        await waitClosed()
        assert(!confirmation(), 'connectivity testing does not mark settings dirty')
        passed.push(language + ' footer save and read-only connectivity test retain consistent behavior')
        await open()
        await click(button(dialog(), 'modelComboButton'))
        await click(button(dialog().querySelector('.model-combo-actions')!, 'cancel'))
        await cancel()
        await waitClosed()
        assert(!confirmation(), 'combination queries do not mark configuration dirty')
        await open()
        await click(button(dialog(), 'addDefinition'))
        await changeInput(input(dialog(), 'modelName'), 'extra-model')
        await click(button(dialog(), 'modelComboButton'))
        await click(button(dialog().querySelector('.model-combo-actions')!, 'modelComboAdd'))
        assert(!saved.models.some(model => model.name.includes('extra-model')), 'applying a combination updates only draft')
        await cancel()
        assert(confirmation().textContent?.includes('extra-model'), 'added combinations are summarized as unsaved changes')
        await discard()
        passed.push(language + ' combination query is read-only and applying combinations requires save')


        await open()
        await click(button(dialog(), 'fetchModelCapabilities'))
        assert(saveButton().disabled, 'wait for capability draft updates before saving')
        await cancel()
        await waitClosed()
        await open()
        await act(async () => { resolveCapabilities!({ status: 'ok', maxContextTokens: 123456, image: true, pdf: true, video: false, audio: false }) })
        await cancel()
        await waitClosed()
        assert(!confirmation(), 'late capability reply after close cannot alter reopened draft')
        await open()
        await click(button(dialog(), 'fetchModelCapabilities'))
        await act(async () => { resolveCapabilities!({ status: 'ok', maxContextTokens: 123456, image: true, pdf: true, video: false, audio: false }) })
        await cancel()
        assert(confirmation().textContent?.includes('example-model'), 'fetched capabilities are unsaved definition edits')
        await discard()
        passed.push(language + ' fetched capabilities require save; stale asynchronous results are ignored')

        const requestOriginalDeletion = async () => {
          await open()
          const models = dialog().querySelector<HTMLSelectElement>('select[aria-label="' + i18n.t('modelsSection') + '"]')!
          await act(async () => { models.value = 'original'; models.dispatchEvent(new Event('change', { bubbles: true })) })
          await click(button(dialog(), 'deleteModelConfig'))
          assert(deletion().textContent?.includes('Original') && deletion().textContent?.includes('Group'), 'confirmation lists model and empty group')
          const confirm = button(deletion(), 'modelDeleteConfirm') as HTMLButtonElement
          assert(!confirm.disabled, 'affected references may be cleared and configured before sending')
          const replacement = deletion().querySelector('select')!
          await act(async () => { replacement.value = draftModelId; replacement.dispatchEvent(new Event('change', { bubbles: true })) })
          assert(!confirm.disabled, 'valid replacement enables linked deletion')
          await click(confirm)
          await waitGone('.model-deletion-dialog')
          assert(saved.models.some(model => model.id === 'original'), 'confirmed deletion remains a draft before Save')
          assert([...picker().options].some(option => option.value === 'original'), 'draft deletion does not change executable picker')
        }
        await requestOriginalDeletion()
        await cancel()
        assert(confirmation().textContent?.includes('Original'), 'exit summary includes draft deletion')
        await discard()
        assert(saved.models.some(model => model.id === 'original'), 'discard restores deleted entities')
        await act(async () => { picker().value = 'original'; picker().dispatchEvent(new Event('change', { bubbles: true })) })
        await requestOriginalDeletion()
        rejectSave = true
        await click(saveButton())
        assert(dialog().textContent?.includes(i18n.t('settingsSaveFailed')), 'failed linked save retains the draft and error')
        assert(saved.models.some(model => model.id === 'original'), 'failed linked save does not publish deletion')
        rejectSave = false
        await click(saveButton())
        await waitClosed()
        assert(!saved.models.some(model => model.id === 'original'), 'successful save applies deletion')
        assert(saved.activeModelConfigId === draftModelId && savedReplacements.original === draftModelId, 'replacement is persisted and sent to main process')
        assert(![...picker().options].some(option => option.value === 'original' || option.value === 'group'), 'saved deletion immediately removes executable model and empty group')
        assert(picker().value !== 'original', 'affected conversation returns to inheritance')
        passed.push(language + ' linked deletion supports discard, failed-save retry, explicit replacement and immediate picker refresh')


        // Stale references can predate this settings session, including archived conversations.
        const stale = structuredClone(project)
        stale.defaultModelConfigId = 'stale'
        stale.commandExecutionDefault = { ...saved.commandExecutionGlobal, review: auditReview('stale') }
        stale.conversations[0]!.modelConfigId = null
        const archived = { ...structuredClone(stale.conversations[0]!), id: 'archived', title: 'Archived conversation', archived: true,
          modelConfigId: 'stale', commandExecution: { ...saved.commandExecutionGlobal, review: auditReview('stale') } }
        stale.conversations.push(archived)
        Object.assign(project, stale)
        await act(async () => { publishProject!(structuredClone(stale)) })
        const repairReferences = async () => {
          await open()
          await click(saveButton())
          assert(deletion()?.textContent?.includes(i18n.t('modelReferenceRepairTitle')), 'saving stale references opens centralized repair')
          const selects = [...deletion().querySelectorAll('select')]
          assert(selects.length === 5, 'bulk selector and all four project/archived references are listed')
          assert(deletion().textContent?.includes('Archived conversation'), 'archived conversation is identifiable')
          await act(async () => { selects[0].value = draftModelId; selects[0].dispatchEvent(new Event('change', { bubbles: true })) })
          assert([...deletion().querySelectorAll('select')].every(select => select.value === draftModelId), 'bulk replacement updates each row')
          const archivedAudit = [...deletion().querySelectorAll('select')].find(select => select.getAttribute('aria-label')?.includes('Archived conversation') && select.getAttribute('aria-label')?.includes(i18n.t('modelReferenceAudit')))!
          await act(async () => { archivedAudit.value = ''; archivedAudit.dispatchEvent(new Event('change', { bubbles: true })) })
          await click(button(deletion(), 'modelReferenceApply'))
          await waitGone('.model-deletion-dialog')
        }
        await repairReferences()
        await cancel()
        assert(confirmation()?.textContent?.includes(i18n.t('modelReferenceRepairTitle')), 'reference-only edits participate in unsaved-change protection')
        await discard()
        assert(project.defaultModelConfigId === 'stale', 'discard leaves project references unchanged')
        await repairReferences()
        await click(saveButton())
        await waitClosed()
        assert(project.defaultModelConfigId === draftModelId, 'selected project model is saved')
        assert(savedReplacements[modelReferenceKey('audit', project.id, 'archived')] === null, 'individual clear overrides bulk replacement')
        assert(project.conversations.find(conversation => conversation.id === 'archived')!.commandExecution?.review?.reviewers.auditModel === true, 'clearing audit selection retains enabled audit')
        await open()
        await click(saveButton())
        await waitClosed()
        passed.push(language + ' stale references offer bulk and individual repair, clearing, archived scopes and discard protection')

        await open()
        await addModel('Navigation draft')
        await click([...dialog().querySelectorAll('[role="tab"]')].find(tab => tab.textContent?.includes(i18n.t('archivedItems'))))
        await click(button(dialog(), 'openArchivedItems'))
        assert(confirmation()?.textContent?.includes('Navigation draft'), 'archive navigation cannot silently discard model edits')
        await click(button(confirmation(), 'save'))
        await waitGone('.unsaved-settings-dialog')
        await waitGone('.settings-dialog-surface')
        assert(saved.models.some(model => model.name === 'Navigation draft'), 'save completes before archive navigation')
        assert(document.querySelector('[role="dialog"]'), 'archive destination opens after save')
        passed.push(language + ' archive navigation shares the same guarded settings exit')
      } finally {
        await act(async () => { root.unmount() })
      }
    }
    return passed
  } finally {
    Object.assign(window, { codey: oldCodey })
    element.remove()
    await act(async () => { await i18n.changeLanguage('en') })
  }
}
