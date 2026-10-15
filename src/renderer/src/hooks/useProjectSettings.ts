import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  defaultAgentLimitsConfig,
  defaultCommandExecutionConfig,
  defaultContextManagementConfig,
  type AppConfig,
  type CommandExecutionConfig,
  type ResourceSelectionOverride,
  type Project,
  type ShellDetectionResult,
} from '../../../shared/types'
import { isValidContextManagementConfig as isValidContextConfig } from '../../../shared/context-validation'
import { isValidAgentLimits, isValidCommandExecutionDraft } from '../components/CommandReviewSettings'

type UseProjectSettingsOptions = {
  config: AppConfig
  projects: Project[]
  interactionLocked: boolean
  replaceProject: (project: Project) => void
  setSaving: (saving: boolean) => void
  setSettingsError: (error: string) => void
  setOpenProjectMenuId: (id: string | null) => void
  setShellDetection: (detection: ShellDetectionResult | null) => void
  runShellDetection: () => Promise<void>
}

export function useProjectSettings({
  config,
  projects,
  interactionLocked,
  replaceProject,
  setSaving,
  setSettingsError,
  setOpenProjectMenuId,
  setShellDetection,
  runShellDetection,
}: UseProjectSettingsOptions) {
  const { t } = useTranslation()
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false)
  const [projectSettingsProjectId, setProjectSettingsProjectId] = useState('')
  const [projectSettingsTab, setProjectSettingsTab] = useState<'model' | 'agentLimits' | 'command' | 'context' | 'skills' | 'knowledgeBases'>('model')
  const [projectSettingsModelConfigId, setProjectSettingsModelConfigId] = useState('')
  const [projectAgentLimitsOverride, setProjectAgentLimitsOverride] = useState(false)
  const [projectAgentLimitsDraft, setProjectAgentLimitsDraft] = useState(defaultAgentLimitsConfig)
  const [projectCommandOverride, setProjectCommandOverride] = useState(false)
  const [projectCommandDraft, setProjectCommandDraft] = useState<CommandExecutionConfig>(defaultCommandExecutionConfig)
  const [projectContextOverride, setProjectContextOverride] = useState(false)
  const [projectContextDraft, setProjectContextDraft] = useState(defaultContextManagementConfig)
  const [projectSkillDraft, setProjectSkillDraft] = useState<ResourceSelectionOverride>({ enabledIds: [], disabledIds: [] })
  const [projectKnowledgeBaseDraft, setProjectKnowledgeBaseDraft] = useState<ResourceSelectionOverride>({ enabledIds: [], disabledIds: [] })

  const projectSettingsTarget = projects.find((entry) => entry.id === projectSettingsProjectId)
  const projectSettingsValid = Boolean(projectSettingsTarget) &&
    (!projectAgentLimitsOverride || isValidAgentLimits(projectAgentLimitsDraft)) &&
    (!projectCommandOverride || isValidCommandExecutionDraft(projectCommandDraft)) &&
    (!projectContextOverride || isValidContextConfig(projectContextDraft))

  function openProjectSettings(project: Project): void {
    if (interactionLocked) {
      return
    }
    setProjectSettingsProjectId(project.id)
    setProjectSettingsTab('model')
    setProjectSettingsModelConfigId(project.defaultModelConfigId ?? '')
    setProjectAgentLimitsOverride(project.agentLimitsDefault !== null)
    setProjectAgentLimitsDraft({ ...(project.agentLimitsDefault ?? config.agentLimitsGlobal) })
    setProjectCommandOverride(project.commandExecutionDefault !== null)
    setProjectCommandDraft(project.commandExecutionDefault
      ? structuredClone(project.commandExecutionDefault)
      : { ...structuredClone(config.commandExecutionGlobal), review: structuredClone(config.commandReviewGlobal) })
    setProjectContextOverride(project.contextConfigOverride !== null)
    setProjectContextDraft({ ...(project.contextConfigOverride ?? config.contextManagement) })
    setProjectSkillDraft({
      enabledIds: [...project.skillSelection.enabledIds],
      disabledIds: [...project.skillSelection.disabledIds],
    })
    setProjectKnowledgeBaseDraft({
      enabledIds: [...project.knowledgeBaseSelection.enabledIds],
      disabledIds: [...project.knowledgeBaseSelection.disabledIds],
    })
    setSettingsError('')
    setProjectSettingsOpen(true)
    setOpenProjectMenuId(null)
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

  async function saveProjectSettings(): Promise<void> {
    const project = projects.find((entry) => entry.id === projectSettingsProjectId)
    if (!project || interactionLocked) {
      return
    }
    if (projectAgentLimitsOverride && !isValidAgentLimits(projectAgentLimitsDraft)) return
    if (projectCommandOverride && !isValidCommandExecutionDraft(projectCommandDraft)) return
    if (projectContextOverride && !isValidContextConfig(projectContextDraft)) return
    setSaving(true)
    setSettingsError('')
    try {
      await window.codey.setProjectModelConfig(project.id, projectSettingsModelConfigId || null)
      await window.codey.setProjectAgentLimitsDefault(project.id, projectAgentLimitsOverride ? projectAgentLimitsDraft : null)
      const updated = await window.codey.setProjectCommandExecutionDefault(project.id, projectCommandOverride ? projectCommandDraft : null)
      await window.codey.setProjectContextConfig(project.id, projectContextOverride ? projectContextDraft : null)
      await window.codey.setProjectSkillSelection(project.id, projectSkillDraft)
      const finalProject = await window.codey.setProjectKnowledgeBaseSelection(project.id, projectKnowledgeBaseDraft)
      replaceProject(finalProject ?? updated)
      setProjectSettingsOpen(false)
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : t('unableChangeProjectSettings'))
    } finally {
      setSaving(false)
    }
  }

  return {
    projectSettingsOpen,
    setProjectSettingsOpen,
    projectSettingsTab,
    setProjectSettingsTab,
    projectSettingsModelConfigId,
    setProjectSettingsModelConfigId,
    projectAgentLimitsOverride,
    setProjectAgentLimitsOverride,
    projectAgentLimitsDraft,
    setProjectAgentLimitsDraft,
    projectCommandOverride,
    setProjectCommandOverride,
    projectCommandDraft,
    setProjectCommandDraft,
    projectContextOverride,
    setProjectContextOverride,
    projectContextDraft,
    setProjectContextDraft,
    projectSkillDraft,
    setProjectSkillDraft,
    projectKnowledgeBaseDraft,
    setProjectKnowledgeBaseDraft,
    openProjectSettings,
    saveProjectSettings,
    projectSettingsTarget,
    projectSettingsValid,
  }
}
