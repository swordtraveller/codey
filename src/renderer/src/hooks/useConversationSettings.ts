import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  defaultAgentLimitsConfig,
  defaultCommandExecutionConfig,
  defaultContextManagementConfig,
  type AppConfig,
  type Conversation,
  type ContextManagementConfig,
  type CommandExecutionConfig,
  type ResourceSelectionOverride,
  type Project,
  type ShellDetectionResult,
} from '../../../shared/types'
import { isValidContextManagementConfig as isValidContextConfig } from '../../../shared/context-validation'
import { isValidAgentLimits, isValidCommandExecutionDraft } from '../components/CommandReviewSettings'

type UseConversationSettingsOptions = {
  config: AppConfig
  projects: Project[]
  interactionLocked: boolean
  replaceProject: (project: Project) => void
  setSaving: (saving: boolean) => void
  setSettingsError: (error: string) => void
  setOpenProjectMenuId: (id: string | null) => void
  setShellDetection: (detection: ShellDetectionResult | null) => void
  runShellDetection: () => Promise<void>
  activeProject?: Project
  activeConversation?: Conversation
  skillBusy: boolean
  knowledgeBaseBusy: boolean
  setSkillBusy: (busy: boolean) => void
  setSkillError: (error: string) => void
  setKnowledgeBaseBusy: (busy: boolean) => void
  setKnowledgeBaseError: (error: string) => void
  changeConversationModelConfig: (id: string) => Promise<void>
  changeProjectModelConfig: (projectId: string, id: string) => Promise<void>
}

export function useConversationSettings({
  config,
  projects,
  interactionLocked,
  replaceProject,
  setSaving,
  setSettingsError,
  setOpenProjectMenuId,
  setShellDetection,
  runShellDetection,
  activeProject,
  activeConversation,
  skillBusy,
  knowledgeBaseBusy,
  setSkillBusy,
  setSkillError,
  setKnowledgeBaseBusy,
  setKnowledgeBaseError,
  changeConversationModelConfig,
  changeProjectModelConfig,
}: UseConversationSettingsOptions) {
  const { t } = useTranslation()
  const [conversationSkillsOpen, setConversationSkillsOpen] = useState(false)
  const [conversationSkillDraft, setConversationSkillDraft] = useState<ResourceSelectionOverride>({ enabledIds: [], disabledIds: [] })
  const [conversationKnowledgeBasesOpen, setConversationKnowledgeBasesOpen] = useState(false)
  const [conversationKnowledgeBaseDraft, setConversationKnowledgeBaseDraft] = useState<ResourceSelectionOverride>({ enabledIds: [], disabledIds: [] })
  const [contextDialogOpen, setContextDialogOpen] = useState(false)
  const [contextScope, setContextScope] = useState<'project' | 'conversation'>('conversation')
  const [contextProjectId, setContextProjectId] = useState('')
  const [contextOverrideEnabled, setContextOverrideEnabled] = useState(false)
  const [contextDraft, setContextDraft] = useState(defaultContextManagementConfig)
  const [agentLimitsDialogOpen, setAgentLimitsDialogOpen] = useState(false)
  const [agentLimitsProjectId, setAgentLimitsProjectId] = useState('')
  const [agentLimitsConversationId, setAgentLimitsConversationId] = useState('')
  const [agentLimitsDraft, setAgentLimitsDraft] = useState(defaultAgentLimitsConfig)
  const [agentLimitsOverride, setAgentLimitsOverride] = useState(false)
  const [commandDialogOpen, setCommandDialogOpen] = useState(false)
  const [commandProjectId, setCommandProjectId] = useState('')
  const [commandConversationId, setCommandConversationId] = useState('')
  const [commandOverride, setCommandOverride] = useState(false)
  const [commandDraft, setCommandDraft] = useState<CommandExecutionConfig>(defaultCommandExecutionConfig)

  const invalidContextOverride = contextOverrideEnabled && !isValidContextConfig(contextDraft)

  function openConversationSkills(): void {
    if (!activeProject || !activeConversation || interactionLocked) return
    setConversationSkillDraft({
      enabledIds: [...activeConversation.skillSelection.enabledIds],
      disabledIds: [...activeConversation.skillSelection.disabledIds],
    })
    setSkillError('')
    setConversationSkillsOpen(true)
  }

  async function saveConversationSkills(): Promise<void> {
    if (!activeProject || !activeConversation || interactionLocked || skillBusy) return
    setSkillBusy(true)
    setSkillError('')
    try {
      const updated = await window.codey.setConversationSkillSelection(
        activeProject.id,
        activeConversation.id,
        conversationSkillDraft,
      )
      replaceProject(updated)
      setConversationSkillsOpen(false)
    } catch (reason) {
      setSkillError(reason instanceof Error ? reason.message : t('unableChangeSkills'))
    } finally {
      setSkillBusy(false)
    }
  }

  function openConversationKnowledgeBases(): void {
    if (!activeProject || !activeConversation || interactionLocked) return
    setConversationKnowledgeBaseDraft({
      enabledIds: [...activeConversation.knowledgeBaseSelection.enabledIds],
      disabledIds: [...activeConversation.knowledgeBaseSelection.disabledIds],
    })
    setKnowledgeBaseError('')
    setConversationKnowledgeBasesOpen(true)
  }

  async function saveConversationKnowledgeBases(): Promise<void> {
    if (!activeProject || !activeConversation || interactionLocked || knowledgeBaseBusy) return
    setKnowledgeBaseBusy(true)
    setKnowledgeBaseError('')
    try {
      const updated = await window.codey.setConversationKnowledgeBaseSelection(
        activeProject.id,
        activeConversation.id,
        conversationKnowledgeBaseDraft,
      )
      replaceProject(updated)
      setConversationKnowledgeBasesOpen(false)
    } catch (reason) {
      setKnowledgeBaseError(reason instanceof Error ? reason.message : t('unableChangeKnowledgeBases'))
    } finally {
      setKnowledgeBaseBusy(false)
    }
  }

  function updateContextDraft(patch: Partial<ContextManagementConfig>): void {
    setContextDraft((current) => ({ ...current, ...patch }))
  }

  async function changeContextModelConfig(modelConfigId: string): Promise<void> {
    if (interactionLocked) {
      return
    }
    if (contextScope === 'conversation') {
      await changeConversationModelConfig(modelConfigId)
      return
    }
    if (contextProjectId) {
      await changeProjectModelConfig(contextProjectId, modelConfigId)
    }
  }

  function openContextSettings(scope: 'project' | 'conversation', project = activeProject): void {
    if (!project || interactionLocked) {
      return
    }
    const override = scope === 'project'
      ? project.contextConfigOverride
      : activeConversation?.contextConfigOverride
    const inherited = scope === 'project'
      ? config.contextManagement
      : project.contextConfigOverride ?? config.contextManagement
    setContextScope(scope)
    setContextProjectId(project.id)
    setContextOverrideEnabled(Boolean(override))
    setContextDraft({ ...(override ?? inherited) })
    setSettingsError('')
    setContextDialogOpen(true)
    setOpenProjectMenuId(null)
  }

  async function saveContextSettings(): Promise<void> {
    const targetProject = projects.find((project) => project.id === contextProjectId)
    if (!targetProject || interactionLocked) {
      return
    }
    setSaving(true)
    setSettingsError('')
    try {
      const value = contextOverrideEnabled ? contextDraft : null
      const updated = contextScope === 'project'
        ? await window.codey.setProjectContextConfig(targetProject.id, value)
        : activeConversation
          ? await window.codey.setConversationContextConfig(targetProject.id, activeConversation.id, value)
          : null
      if (updated) {
        replaceProject(updated)
      }
      setContextDialogOpen(false)
    } catch {
      setSettingsError(t('unableChangeContextConfig'))
    } finally {
      setSaving(false)
    }
  }

  function openAgentLimitsSettings(): void {
    if (!activeProject || !activeConversation || interactionLocked) {
      return
    }
    setAgentLimitsProjectId(activeProject.id)
    setAgentLimitsConversationId(activeConversation.id)
    // Three-level inheritance: conversation ?? project default ?? global.
    const effective = activeConversation.agentLimits ?? activeProject.agentLimitsDefault ?? config.agentLimitsGlobal
    setAgentLimitsOverride(activeConversation.agentLimits !== null)
    setAgentLimitsDraft({ ...effective })
    setSettingsError('')
    setAgentLimitsDialogOpen(true)
  }

  async function saveAgentLimitsSettings(): Promise<void> {
    if (interactionLocked || (agentLimitsOverride && !isValidAgentLimits(agentLimitsDraft))) {
      return
    }
    setSaving(true)
    setSettingsError('')
    try {
      const updated = await window.codey.setConversationAgentLimits(
        agentLimitsProjectId,
        agentLimitsConversationId,
        agentLimitsOverride ? agentLimitsDraft : null,
      )
      replaceProject(updated)
      setAgentLimitsDialogOpen(false)
    } catch {
      setSettingsError(t('unableChangeAgentLimits'))
    } finally {
      setSaving(false)
    }
  }

  /** Materializes the effective config for a conversation: its own override,
   *  else the project default, else the global execution default — with
   *  review falling back to the global review config. */
  function effectiveConversationCommandConfig(): CommandExecutionConfig {
    const base = activeConversation?.commandExecution ?? activeProject?.commandExecutionDefault ?? config.commandExecutionGlobal
    return { ...structuredClone(base), review: base.review ?? structuredClone(config.commandReviewGlobal) }
  }

  function openCommandSettings(): void {
    if (!activeProject || !activeConversation || interactionLocked) return
    setCommandProjectId(activeProject.id)
    setCommandConversationId(activeConversation.id)
    setCommandOverride(activeConversation.commandExecution !== null)
    setCommandDraft(activeConversation.commandExecution
      ? structuredClone(activeConversation.commandExecution)
      : effectiveConversationCommandConfig())
    setSettingsError('')
    setCommandDialogOpen(true)
    // Availability checks need a detection; run one if none is cached so the
    // first save does not fail with "run environment detection".
    void window.codey.getCachedShellDetection().then((cached) => {
      if (cached) {
        setShellDetection(cached)
        return
      }
      return runShellDetection()
    }).catch(() => undefined)
  }

  async function saveCommandExecutionSettings(): Promise<void> {
    if (interactionLocked || (commandOverride && !isValidCommandExecutionDraft(commandDraft))) {
      return
    }
    setSaving(true)
    setSettingsError('')
    try {
      const updated = await window.codey.setConversationCommandExecution(
        commandProjectId,
        commandConversationId,
        commandOverride ? commandDraft : null,
      )
      replaceProject(updated)
      setCommandDialogOpen(false)
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : t('unableChangeCommandExecution'))
    } finally {
      setSaving(false)
    }
  }

  return {
    conversationSkillsOpen,
    setConversationSkillsOpen,
    conversationSkillDraft,
    setConversationSkillDraft,
    conversationKnowledgeBasesOpen,
    setConversationKnowledgeBasesOpen,
    conversationKnowledgeBaseDraft,
    setConversationKnowledgeBaseDraft,
    contextDialogOpen,
    setContextDialogOpen,
    contextScope,
    contextProjectId,
    contextOverrideEnabled,
    setContextOverrideEnabled,
    contextDraft,
    agentLimitsDialogOpen,
    setAgentLimitsDialogOpen,
    agentLimitsDraft,
    setAgentLimitsDraft,
    agentLimitsOverride,
    setAgentLimitsOverride,
    commandDialogOpen,
    setCommandDialogOpen,
    commandOverride,
    setCommandOverride,
    commandDraft,
    setCommandDraft,
    openConversationSkills,
    saveConversationSkills,
    openConversationKnowledgeBases,
    saveConversationKnowledgeBases,
    updateContextDraft,
    changeContextModelConfig,
    openContextSettings,
    saveContextSettings,
    openAgentLimitsSettings,
    saveAgentLimitsSettings,
    openCommandSettings,
    saveCommandExecutionSettings,
    invalidContextOverride,
  }
}
