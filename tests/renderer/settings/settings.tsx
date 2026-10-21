import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { defaultAppConfig, type Conversation, type Project } from '../../../src/shared/types'
import { useProjectSettings } from '../../../src/renderer/src/hooks/useProjectSettings'
import { useConversationSettings } from '../../../src/renderer/src/hooks/useConversationSettings'

// Exercise real React state and asynchronous IPC boundaries in Chromium.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
await i18next.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: {} } }, initAsync: false })
const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message) }
function equal(actual: unknown, expected: unknown, message: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
}
function conversation(id: string): Conversation {
  return { id, title: id, archived: false, modelConfigId: null, contextConfigOverride: null,
    agentLimits: null, commandExecution: null, skillSelection: { enabledIds: [], disabledIds: [] },
    knowledgeBaseSelection: { enabledIds: [], disabledIds: [] }, messages: [], agentMessages: [] }
}
function project(): Project {
  return { id: 'project', name: 'Project', archived: false, defaultModelConfigId: null,
    contextConfigOverride: null, commandExecutionDefault: null, agentLimitsDefault: null,
    skillSelection: { enabledIds: ['project-skill'], disabledIds: [] },
    knowledgeBaseSelection: { enabledIds: ['project-kb'], disabledIds: [] }, folders: [],
    pythonEnvironmentFolderId: null, conversations: [conversation('first'), conversation('second')] }
}
type Call = { name: string; args: unknown[] }
let calls: Call[] = []
let failures = new Map<string, number>()
let config = structuredClone(defaultAppConfig)
let data = project()
let locked = false
let activeIndex = 0
let detected = 0
let cached: unknown = null
let replaced: Project[] = []
let ui: { saving: boolean; error: string; skillBusy: boolean; skillError: string; knowledgeBaseBusy: boolean; knowledgeBaseError: string }
let projects: ReturnType<typeof useProjectSettings>
let conversations: ReturnType<typeof useConversationSettings>
const methods = [
  'setProjectModelConfig', 'setProjectAgentLimitsDefault', 'setProjectCommandExecutionDefault',
  'setProjectContextConfig', 'setProjectSkillSelection', 'setProjectKnowledgeBaseSelection',
  'setConversationAgentLimits', 'setConversationCommandExecution', 'setConversationContextConfig',
  'setConversationSkillSelection', 'setConversationKnowledgeBaseSelection',
] as const
const ipc = Object.fromEntries(methods.map((name) => [name, async (...args: unknown[]) => {
  calls.push({ name, args: structuredClone(args) })
  if (failures.get(name)) {
    failures.set(name, failures.get(name)! - 1)
    throw new Error(`disk unavailable: ${name}`)
  }
  return data
}]))
Object.assign(window, { codey: { ...ipc, getCachedShellDetection: async () => cached } })

function Harness(): null {
  const [saving, setSaving] = useState(false)
  const [error, setSettingsError] = useState('')
  const [skillBusy, setSkillBusy] = useState(false)
  const [skillError, setSkillError] = useState('')
  const [knowledgeBaseBusy, setKnowledgeBaseBusy] = useState(false)
  const [knowledgeBaseError, setKnowledgeBaseError] = useState('')
  const options = {
    config, projects: [data], interactionLocked: locked, replaceProject: (value: Project) => { replaced.push(value) },
    setSaving, setSettingsError, setOpenProjectMenuId: () => {}, setShellDetection: () => {},
    runShellDetection: async () => { detected++ },
  }
  projects = useProjectSettings(options)
  conversations = useConversationSettings({ ...options, activeProject: data, activeConversation: data.conversations[activeIndex],
    skillBusy, knowledgeBaseBusy, setSkillBusy, setSkillError, setKnowledgeBaseBusy, setKnowledgeBaseError,
    changeConversationModelConfig: async (id) => { calls.push({ name: 'conversation-model', args: [id] }) },
    changeProjectModelConfig: async (...args) => { calls.push({ name: 'project-model', args }) },
  })
  ui = { saving, error, skillBusy, skillError, knowledgeBaseBusy, knowledgeBaseError }
  return null
}
let root: ReturnType<typeof createRoot>
async function render(): Promise<void> { await act(async () => { root.render(<Harness />) }) }
const passed: string[] = []
async function test(name: string, check: () => Promise<void>): Promise<void> {
  config = structuredClone(defaultAppConfig); data = project(); locked = false; activeIndex = 0
  calls = []; failures = new Map(); replaced = []; detected = 0; cached = null
  root = createRoot(document.getElementById('root')!)
  try { await render(); await check(); passed.push(name) }
  catch (error) { throw new Error(`${name}: ${String(error)}`, { cause: error }) }
  finally { await act(async () => { root.unmount() }) }
}

async function runTests() {
  await test('project settings inherit globals; cancelling does not change source selections', async () => {
    await act(async () => { projects.openProjectSettings(data) })
    assert(projects.projectSettingsOpen && projects.projectSettingsValid, 'valid dialog opens')
    equal(projects.projectAgentLimitsDraft, config.agentLimitsGlobal, 'global limits')
    equal(projects.projectContextDraft, config.contextManagement, 'global context')
    assert(!projects.projectAgentLimitsOverride && !projects.projectCommandOverride && !projects.projectContextOverride, 'inheritance enabled')
    assert(detected === 1, 'detect shells if cache is empty')
    await act(async () => {
      projects.setProjectSkillDraft({ enabledIds: ['changed'], disabledIds: [] })
      projects.setProjectSettingsOpen(false)
    })
    equal(data.skillSelection.enabledIds, ['project-skill'], 'cancel preserves project')
    equal(calls, [], 'cancel does not persist')
    await act(async () => { projects.openProjectSettings(data) })
    equal(projects.projectSkillDraft.enabledIds, ['project-skill'], 'reopen resets draft')
  })
  await test('project save preserves inheritance as null and publishes final result', async () => {
    await act(async () => { projects.openProjectSettings(data) })
    await act(async () => { await projects.saveProjectSettings() })
    equal(calls.map(({ name }) => name), methods.slice(0, 6), 'all sections saved')
    equal(calls.slice(0, 4).map(({ args }) => args), Array.from({ length: 4 }, () => ['project', null]), 'null overrides')
    equal(calls[4].args, ['project', data.skillSelection], 'skills payload')
    equal(calls[5].args, ['project', data.knowledgeBaseSelection], 'knowledge bases payload')
    assert(!projects.projectSettingsOpen && !ui.saving && replaced.length === 1, 'success closes and releases saving')
  })
  await test('project override save uses edited values', async () => {
    await act(async () => { projects.openProjectSettings(data) })
    const limits = { modelRequestsPerRound: 7, toolCallsPerRequest: 3 }
    const context = { ...config.contextManagement, recentKeepRounds: 3 }
    await act(async () => {
      projects.setProjectSettingsModelConfigId('model-b')
      projects.setProjectAgentLimitsOverride(true); projects.setProjectAgentLimitsDraft(limits)
      projects.setProjectCommandOverride(true)
      projects.setProjectContextOverride(true); projects.setProjectContextDraft(context)
    })
    await act(async () => { await projects.saveProjectSettings() })
    equal(calls[0].args, ['project', 'model-b'], 'model override')
    equal(calls[1].args, ['project', limits], 'limits override')
    equal(calls[2].args, ['project', projects.projectCommandDraft], 'execution override')
    equal(calls[3].args, ['project', context], 'context override')
  })
  await test('project partial save failure keeps draft open and supports retry', async () => {
    await act(async () => { projects.openProjectSettings(data); projects.setProjectSettingsModelConfigId('retry-model') })
    failures.set('setProjectContextConfig', 1)
    await act(async () => { await projects.saveProjectSettings() })
    assert(projects.projectSettingsOpen && !ui.saving && ui.error.includes('disk unavailable'), 'failure visible and editable')
    assert(replaced.length === 0 && calls.length === 4, 'failure stops later writes')
    await act(async () => { await projects.saveProjectSettings() })
    assert(!projects.projectSettingsOpen && !ui.saving && !ui.error, 'retry succeeds')
    equal(calls[4].args, ['project', 'retry-model'], 'retry retains draft')
  })
  await test('invalid project overrides and interaction lock prevent writes', async () => {
    await act(async () => { projects.openProjectSettings(data); projects.setProjectAgentLimitsOverride(true); projects.setProjectAgentLimitsDraft({ modelRequestsPerRound: 0, toolCallsPerRequest: 1 }) })
    assert(!projects.projectSettingsValid, 'invalid draft disables saving')
    await act(async () => { await projects.saveProjectSettings() })
    equal(calls, [], 'invalid limits not written')
    await act(async () => { projects.setProjectAgentLimitsOverride(false) })
    locked = true; await render()
    await act(async () => { await projects.saveProjectSettings() })
    equal(calls, [], 'locked save not written')
  })
  await test('conversation limits follow global, project, then conversation precedence', async () => {
    await act(async () => { conversations.openAgentLimitsSettings() })
    equal(conversations.agentLimitsDraft, config.agentLimitsGlobal, 'global fallback')
    data.agentLimitsDefault = { modelRequestsPerRound: 8, toolCallsPerRequest: 4 }; await render()
    await act(async () => { conversations.openAgentLimitsSettings() })
    equal(conversations.agentLimitsDraft, data.agentLimitsDefault, 'project precedence')
    data.conversations[0].agentLimits = { modelRequestsPerRound: 5, toolCallsPerRequest: 2 }; await render()
    await act(async () => { conversations.openAgentLimitsSettings() })
    equal(conversations.agentLimitsDraft, data.conversations[0].agentLimits, 'conversation precedence')
    await act(async () => { conversations.setAgentLimitsOverride(false) })
    await act(async () => { await conversations.saveAgentLimitsSettings() })
    equal(calls[0].args, ['project', 'first', null], 'disable override restores inheritance')
  })
  await test('conversation limit failure and invalid drafts are recoverable', async () => {
    await act(async () => { conversations.openAgentLimitsSettings(); conversations.setAgentLimitsOverride(true); conversations.setAgentLimitsDraft({ modelRequestsPerRound: 0, toolCallsPerRequest: 1 }) })
    await act(async () => { await conversations.saveAgentLimitsSettings() })
    equal(calls, [], 'invalid limits rejected')
    const limits = { modelRequestsPerRound: 4, toolCallsPerRequest: 2 }
    await act(async () => { conversations.setAgentLimitsDraft(limits) })
    failures.set('setConversationAgentLimits', 1)
    await act(async () => { await conversations.saveAgentLimitsSettings() })
    assert(conversations.agentLimitsDialogOpen && !ui.saving && ui.error, 'failure keeps dialog usable')
    activeIndex = 1; await render()
    await act(async () => { await conversations.saveAgentLimitsSettings() })
    equal(calls.at(-1)?.args, ['project', 'first', limits], 'save retains originally opened conversation')
    assert(!conversations.agentLimitsDialogOpen && !ui.saving, 'retry closes dialog')
  })
  await test('command settings inherit project execution and global review', async () => {
    data.commandExecutionDefault = structuredClone(config.commandExecutionGlobal)
    data.commandExecutionDefault.review = null
    cached = { cached: true }; await render()
    await act(async () => { conversations.openCommandSettings() })
    equal(conversations.commandDraft.review, config.commandReviewGlobal, 'global review inherited')
    assert(!conversations.commandOverride && detected === 0, 'cached shell detection reused')
    failures.set('setConversationCommandExecution', 1)
    await act(async () => { await conversations.saveCommandExecutionSettings() })
    assert(conversations.commandDialogOpen && ui.error.includes('disk unavailable') && !ui.saving, 'command failure retained')
    activeIndex = 1; await render()
    await act(async () => { await conversations.saveCommandExecutionSettings() })
    equal(calls.at(-1)?.args, ['project', 'first', null], 'command save keeps scope and inheritance')
    assert(!conversations.commandDialogOpen && !ui.saving, 'command retry succeeds')
  })
  await test('context settings route model and config changes to the selected scope', async () => {
    data.contextConfigOverride = { ...config.contextManagement, recentKeepRounds: 3 }; await render()
    await act(async () => { conversations.openContextSettings('conversation') })
    equal(conversations.contextDraft, data.contextConfigOverride, 'conversation inherits project context')
    await act(async () => { await conversations.changeContextModelConfig('conversation-model'); await conversations.saveContextSettings() })
    equal(calls[0], { name: 'conversation-model', args: ['conversation-model'] }, 'conversation model routing')
    equal(calls[1], { name: 'setConversationContextConfig', args: ['project', 'first', null] }, 'conversation config routing')
    await act(async () => { conversations.openContextSettings('project') })
    await act(async () => { conversations.updateContextDraft({ recentKeepRounds: 4 }) })
    await act(async () => { await conversations.changeContextModelConfig('project-model'); await conversations.saveContextSettings() })
    equal(calls[2], { name: 'project-model', args: ['project', 'project-model'] }, 'project model routing')
    equal(calls[3].args, ['project', { ...data.contextConfigOverride, recentKeepRounds: 4 }], 'project context edits')
  })
  await test('context save failure leaves dialog open for retry', async () => {
    await act(async () => { conversations.openContextSettings('conversation') })
    failures.set('setConversationContextConfig', 1)
    await act(async () => { await conversations.saveContextSettings() })
    assert(conversations.contextDialogOpen && !ui.saving && ui.error, 'context failure visible')
    await act(async () => { await conversations.saveContextSettings() })
    assert(!conversations.contextDialogOpen && !ui.saving && !ui.error, 'context retry succeeds')
  })
  for (const kind of ['skill', 'knowledgeBase'] as const) {
    await test(`${kind} selection saves only conversation deltas and retries failed writes`, async () => {
      const skills = kind === 'skill'
      const api = skills ? 'setConversationSkillSelection' : 'setConversationKnowledgeBaseSelection'
      await act(async () => { if (skills) conversations.openConversationSkills(); else conversations.openConversationKnowledgeBases() })
      const selection = { enabledIds: ['local'], disabledIds: ['inherited'] }
      await act(async () => { if (skills) conversations.setConversationSkillDraft(selection); else conversations.setConversationKnowledgeBaseDraft(selection) })
      const save = async () => { if (skills) await conversations.saveConversationSkills(); else await conversations.saveConversationKnowledgeBases() }
      failures.set(api, 1)
      await act(save)
      assert(skills ? conversations.conversationSkillsOpen && ui.skillError && !ui.skillBusy : conversations.conversationKnowledgeBasesOpen && ui.knowledgeBaseError && !ui.knowledgeBaseBusy, 'resource failure recoverable')
      locked = true; await render(); await act(save)
      assert(calls.length === 1, 'interaction lock prevents resource write')
      locked = false; await render(); await act(save)
      equal(calls.at(-1), { name: api, args: ['project', 'first', selection] }, 'resource payload')
      assert(skills ? !conversations.conversationSkillsOpen && !ui.skillBusy : !conversations.conversationKnowledgeBasesOpen && !ui.knowledgeBaseBusy, 'retry closes resource dialog')
      equal(data.conversations[0][skills ? 'skillSelection' : 'knowledgeBaseSelection'].enabledIds, [], 'editing draft did not mutate source')
    })
  }
  await test('interaction lock prevents opening settings dialogs', async () => {
    locked = true; await render()
    await act(async () => {
      projects.openProjectSettings(data); conversations.openAgentLimitsSettings(); conversations.openCommandSettings()
      conversations.openContextSettings('conversation'); conversations.openConversationSkills(); conversations.openConversationKnowledgeBases()
    })
    assert(!projects.projectSettingsOpen && !conversations.agentLimitsDialogOpen && !conversations.commandDialogOpen && !conversations.contextDialogOpen && !conversations.conversationSkillsOpen && !conversations.conversationKnowledgeBasesOpen, 'all dialogs locked')
    assert(detected === 0 && calls.length === 0, 'locked open has no side effects')
  })
  return { passed: passed.length, tests: passed }
}
Object.assign(window, { runTests })
