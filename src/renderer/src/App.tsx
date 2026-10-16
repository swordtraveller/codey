import type { MessageNavigationTarget } from '../../shared/message-navigation'
import { conversationReadState } from '../../shared/conversation-read-state'
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Switch,
  FluentProvider,
  Input,
  Tab,
  TabList,
  Textarea,
  webLightTheme,
} from '@fluentui/react-components'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { setAppLanguage } from './i18n'
import { isContextConfigValidForModel, isValidContextManagementConfig } from '../../shared/context-validation'
import type { BridgeChannelStatus } from '../../shared/bridge'
import { defaultLocalEmbeddingModelId } from '../../shared/types'
import type {
  ImageAttachment,
  MediaAttachment,
  KnowledgeBase,
  KnowledgeBaseMode,
  PerformanceTraceFile,
  PerformanceTraceStatus,
  InstalledSkill,
  SkillImportPreview,
} from '../../shared/types'
import { useConversationMessages } from './useConversationMessages'
import {
  defaultAppConfig,
  defaultCommandExecutionConfig,
  type CommandApprovalMemory,
  type CommandApprovalRequest,
  type ModelConfig,
  type Project,
  type PromptSnapshot,
  type ShellDetectionResult,
  type Wsl2ManualConfig,
} from '../../shared/types'
import { UnreadBadge } from './components/UnreadBadge'
import { McpSettings } from './components/McpSettings'
import type { UpdateCheckResult } from '../../shared/update-check'
import { flattenModelLink, resolveModelTarget } from '../../shared/model-targets'
import { validateCommandReviewConfig } from '../../shared/command-rules'
import {
  CommandApprovalDialog,
  isValidAgentLimits,
  isValidCommandExecutionDraft,
} from './components/CommandReviewSettings'
import { GlobalSettingsPanel, type GlobalSettingsTab } from './components/GlobalSettingsPanel'
import { ModelSettingsPanel } from './components/ModelSettingsPanel'
import { SkillsSettingsPanel } from './components/SkillsSettingsPanel'
import { KnowledgeBaseSettingsPanel } from './components/KnowledgeBaseSettingsPanel'
import { AppPreferencesPanel } from './components/AppPreferencesPanel'
import { Composer } from './components/Composer'
import { useConversationRuntime } from './hooks/useConversationRuntime'
import { ConversationMessages } from './components/ConversationMessages'
import { HelpDialog } from './components/HelpDialog'
import { useHelpDialog } from './hooks/useHelpDialog'
import { resolveEffectiveResourceIds } from './resource-selection'
import { ProjectSettingsDialog } from './components/ProjectSettingsDialog'
import { ConversationSettingsDialogs } from './components/ConversationSettingsDialogs'
import { useProjectSettings } from './hooks/useProjectSettings'
import { useConversationSettings } from './hooks/useConversationSettings'
import { useModelSettings } from './hooks/useModelSettings'

const isValidContextConfig = isValidContextManagementConfig

type RenameTarget =
  | { kind: 'project'; projectId: string; name: string }
  | { kind: 'conversation'; projectId: string; conversationId: string; name: string }

export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState('')
  const [activeConversationId, setActiveConversationId] = useState('')
  const [config, setConfig] = useState(defaultAppConfig)
  const [configDraft, setConfigDraft] = useState(defaultAppConfig)
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([])
  const [skillUrl, setSkillUrl] = useState('')
  const [skillPreview, setSkillPreview] = useState<SkillImportPreview | null>(null)
  const [selectedSkillCandidateIds, setSelectedSkillCandidateIds] = useState<string[]>([])
  const [skillBusy, setSkillBusy] = useState(false)
  const [skillError, setSkillError] = useState('')
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [knowledgeBaseDirectory, setKnowledgeBaseDirectory] = useState('')
  const [knowledgeBaseName, setKnowledgeBaseName] = useState('')
  const [knowledgeBaseMode, setKnowledgeBaseMode] = useState<KnowledgeBaseMode>('rg')
  const [knowledgeBaseBusy, setKnowledgeBaseBusy] = useState(false)
  const [knowledgeBaseError, setKnowledgeBaseError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bridgeDialogOpen, setBridgeDialogOpen] = useState(false)
  const [bridgeUrl, setBridgeUrl] = useState('http://127.0.0.1:8787')
  const [bridgeChannels, setBridgeChannels] = useState<BridgeChannelStatus[]>([])
  const [bridgeError, setBridgeError] = useState('')
  const [bridgeBusy, setBridgeBusy] = useState(false)
  const [approvalRequest, setApprovalRequest] = useState<CommandApprovalRequest | null>(null)
  const [shellDetection, setShellDetection] = useState<ShellDetectionResult | null>(null)
  const [shellDetectBusy, setShellDetectBusy] = useState(false)
  const [wslDistros, setWslDistros] = useState<string[]>([])
  const [wsl2Draft, setWsl2Draft] = useState<Wsl2ManualConfig>({ distro: '', sandboxUser: '' })
  const [wsl2ConfigBusy, setWsl2ConfigBusy] = useState(false)
  const [promptSnapshot, setPromptSnapshot] = useState<PromptSnapshot | null>(null)
  const [wsl2ConfigOpen, setWsl2ConfigOpen] = useState(false)
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null)
  const [openConversationMenuId, setOpenConversationMenuId] = useState<string | null>(null)
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [renameError, setRenameError] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [error, setError] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [toast, setToast] = useState<{ message: string; tone: 'info' | 'error' } | null>(null)
  const [performanceDialogOpen, setPerformanceDialogOpen] = useState(false)
  const [performanceStatus, setPerformanceStatus] = useState<PerformanceTraceStatus | null>(null)
  const [performanceFiles, setPerformanceFiles] = useState<PerformanceTraceFile[]>([])
  const [performanceError, setPerformanceError] = useState('')
  const [projectError, setProjectError] = useState('')
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null)
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false)
  const [updateCheckError, setUpdateCheckError] = useState('')
  const [navigationTarget, setNavigationTarget] = useState<(MessageNavigationTarget & { requestId: number }) | null>(null)
  const [scrollRequest, setScrollRequest] = useState<(MessageNavigationTarget & { requestId: number }) | undefined>()
  const navigationSequence = useRef(0)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const conversationRef = useRef<HTMLDivElement>(null)
  const conversationEndRef = useRef<HTMLDivElement>(null)
  const toastTimerRef = useRef<number | undefined>(undefined)
  const settingsOpenedOnceRef = useRef(false)
  const [settingsTab, setSettingsTab] = useState<'models' | 'global' | 'skills' | 'knowledgeBases' | 'mcp' | 'language' | 'power' | 'archive' | 'developer' | 'prompts' | 'notifications' | 'about'>('models')
  const [globalSettingsTab, setGlobalSettingsTab] = useState<GlobalSettingsTab>('model')

  const {
    activeConversationKey,
    activeConversationKeyRef,
    beginTurn,
    clearRun,
    conversationStates,
    conversationTurns,
    finishTurn,
    sessionModelDisplay,
    setStopping,
    stoppingConversations,
    updateTurnUserMessage,
  } = useConversationRuntime({ activeProjectId, activeConversationId })

  const visibleProjects = projects.filter((project) => !project.archived)
  const activeProject = visibleProjects.find((project) => project.id === activeProjectId)
  const { dialogProps: helpDialogProps, openHelp, openCommandRulesHelp, invalidateToolHelp } = useHelpDialog(activeProject?.folders[0]?.path)
  const {
    panelProps: modelSettingsPanelProps,
    createSettingsDraft,
    invalidModelConfig,
    flatDraftModelConfigs,
    sortedConfigDraftModelGroups,
    sortedConfigDraftModels,
  } = useModelSettings({ config, configDraft, setConfigDraft, showToast })
  const visibleConversations = activeProject?.conversations.filter((conversation) => !conversation.archived) ?? []
  const archivedProjects = projects.filter((project) => project.archived)
  const archivedConversations = projects
    .filter((project) => !project.archived)
    .flatMap((project) => project.conversations
      .filter((conversation) => conversation.archived)
      .map((conversation) => ({ project, conversation })))
  const selectedConversation = visibleConversations.find(
    (conversation) => conversation.id === activeConversationId,
  )
  const messageHistory = useConversationMessages(activeProject?.id, selectedConversation?.id, selectedConversation?.history?.revision)
  const activeConversation = selectedConversation ? { ...selectedConversation, messages: messageHistory.messages } : undefined
  const installedSkillIds = new Set(installedSkills.map((skill) => skill.id))
  const effectiveSkillIds = resolveEffectiveResourceIds(
    config.defaultSkillIds,
    activeProject?.skillSelection,
    activeConversation?.skillSelection,
  ).filter((id) => installedSkillIds.has(id))
  const effectiveSkills = effectiveSkillIds
    .map((id) => installedSkills.find((skill) => skill.id === id))
    .filter((skill): skill is InstalledSkill => Boolean(skill))
  const knowledgeBaseIds = new Set(knowledgeBases.map((knowledgeBase) => knowledgeBase.id))
  const effectiveKnowledgeBaseIds = resolveEffectiveResourceIds(
    config.defaultKnowledgeBaseIds,
    activeProject?.knowledgeBaseSelection,
    activeConversation?.knowledgeBaseSelection,
  ).filter((id) => knowledgeBaseIds.has(id))
  const effectiveKnowledgeBases = effectiveKnowledgeBaseIds
    .map((id) => knowledgeBases.find((knowledgeBase) => knowledgeBase.id === id))
    .filter((knowledgeBase): knowledgeBase is KnowledgeBase => Boolean(knowledgeBase))
  const unreadCounts = useMemo((): Record<string, number> => {
    const counts: Record<string, number> = {}
    for (const project of projects) {
      for (const conv of project.conversations) {
        if (conv.archived) continue
        if (conv.history) { counts[conv.id] = conv.history.unreadCount; continue }
        counts[conv.id] = conversationReadState(conv.messages, conv.lastReadMessageId).unreadCount
      }
    }
    return counts
  }, [projects])
  const conversationErrors = useMemo((): Record<string, boolean> => {
    const errors: Record<string, boolean> = {}
    for (const project of projects) {
      for (const conv of project.conversations) {
        if (conv.archived) continue
        errors[conv.id] = conv.history?.hasUnreadError ?? conversationReadState(conv.messages, conv.lastReadMessageId).hasUnreadError
      }
    }
    return errors
  }, [projects])
  const projectUnreadState = useMemo((): Record<string, { count: number; error: boolean }> => {
    const state: Record<string, { count: number; error: boolean }> = {}
    for (const project of projects) {
      let count = 0
      let error = false
      for (const conv of project.conversations) {
        if (conv.archived) continue
        count += unreadCounts[conv.id] || 0
        if (conversationErrors[conv.id]) error = true
      }
      state[project.id] = { count, error }
    }
    return state
  }, [projects, unreadCounts, conversationErrors])
  const projectModelConfigId = activeProject?.defaultModelConfigId ?? config.activeModelConfigId
  const effectiveModelConfigId = activeConversation?.modelConfigId ?? projectModelConfigId
  const effectiveModelConfig = resolveModelTarget(config, effectiveModelConfigId)
  const effectiveModelMember = effectiveModelConfig?.chain[0]
  const displayedSessionModel = sessionModelDisplay?.key === activeConversationKey
    ? sessionModelDisplay
    : effectiveModelMember
  /** Single models flattened (audit-model pickers list models only, no groups). */
  const flatModelConfigs = config.models
    .map((model) => flattenModelLink(config, model))
    .filter((model): model is ModelConfig => model !== undefined)
  const effectiveContextConfig = activeConversation?.contextConfigOverride ??
    activeProject?.contextConfigOverride ?? config.contextManagement
  const maxInputTokensError = effectiveModelConfig &&
    effectiveContextConfig.maxInputTokens > effectiveModelConfig.modelMaxContext
    ? t('maxInputTokensContextError', {
        tokens: effectiveContextConfig.maxInputTokens.toLocaleString(),
        context: effectiveModelConfig.modelMaxContext.toLocaleString(),
        model: effectiveModelConfig.name,
      })
    : ''
  const effectiveContextStrategyLabel = effectiveContextConfig.customStrategyEnabled
    ? t('contextStrategyCustom')
    : effectiveContextConfig.layeredEnabled
      ? t('contextStrategyLayeredShort')
      : t('contextStrategyDefault')
  const configured = Boolean(effectiveModelConfig?.baseUrl && effectiveModelConfig.apiKey && effectiveModelConfig.modelName)
  const conversationRoundCount = activeConversation?.history?.turnCount ?? activeConversation?.messages.filter((message) => message.role === 'user').length ?? 0
  const context = activeConversation?.context
  const contextStatus = context
    ? `${Math.round((context.compressedTokens / context.modelMaxContext) * 100)}% context / ${Math.round((context.compressedTokens / context.maxInputTokens) * 100)}% input`
    : ''
  const activeConversationState = activeConversationKey
    ? conversationStates[activeConversationKey] ?? 'idle'
    : 'idle'
  const interactionLocked = activeConversationState !== 'idle'

  const projectSettings = useProjectSettings({
    config,
    projects,
    interactionLocked,
    replaceProject,
    setSaving,
    setSettingsError,
    setOpenProjectMenuId,
    setShellDetection,
    runShellDetection,
  })
  const { openProjectSettings } = projectSettings

  const conversationSettings = useConversationSettings({
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
  })
  const {
    openConversationSkills, openConversationKnowledgeBases, openContextSettings,
    openAgentLimitsSettings, openCommandSettings,
  } = conversationSettings
  const conversationWorking = activeConversationState === 'running'
  const stopping = activeConversationKey ? stoppingConversations[activeConversationKey] === true : false
  const conversationTurn = activeConversationKey ? conversationTurns[activeConversationKey] : undefined
  const conversationContextConfigInvalid = Boolean(activeConversation && activeConversation.modelConfigId && effectiveModelConfig &&
    !isContextConfigValidForModel(
      activeConversation.contextConfigOverride ?? activeProject?.contextConfigOverride ?? config.contextManagement,
      effectiveModelConfig.modelMaxContext,
    ))
  const canSend = Boolean(messageHistory.loaded && configured && activeProject?.folders.length && activeConversation && !interactionLocked && !conversationContextConfigInvalid)
  const lastUserMessage = activeConversation
    ? [...activeConversation.messages].reverse().find((message) => message.role === 'user')
    : undefined
  const lastUserMessageId = activeConversationState === 'idle' ? lastUserMessage?.id : undefined
  const continueConversation = (): void => {
    if (!lastUserMessage || !canSend) return
    const prompts = [t('continuePromptAbnormal'), t('continuePromptNormal')]
    const lastTurn = lastUserMessage.turn
      ?? (conversationTurn?.userMessageId === lastUserMessage.id ? conversationTurn : undefined)
    const content = prompts.includes(lastUserMessage.content)
      ? lastUserMessage.content
      : lastTurn?.result === 'normal'
        ? prompts[1]
        : prompts[0]
    void sendMessage(content, [], [], lastUserMessage.id)
  }

  useEffect(() => {
    void window.codey
      .getConfig()
      .then((saved) => {
        setConfig(saved)
        setConfigDraft(saved)
        setAppLanguage(saved.language)
      })
      .catch(() => setError(t('unableLoadConfig')))

    void window.codey
      .listSkills()
      .then(setInstalledSkills)
      .catch(() => setSkillError(t('unableLoadSkills')))

    void window.codey
      .listKnowledgeBases()
      .then(setKnowledgeBases)
      .catch(() => setKnowledgeBaseError(t('unableLoadKnowledgeBases')))

    void window.codey
      .getProjects()
      .then((savedProjects) => {
        setProjects(savedProjects)
        const firstProject = savedProjects.find((project) => !project.archived)
        const firstConversation = firstProject?.conversations.find((conversation) => !conversation.archived)
        if (firstProject) {
          setActiveProjectId(firstProject.id)
          setActiveConversationId(firstConversation?.id ?? '')
        }
      })
      .catch(() => setError(t('unableLoadProjects')))
  }, [])

  useEffect(() => {
    void window.codey.getPerformanceTraceStatus().then(setPerformanceStatus).catch(() => undefined)
  }, [])

  useEffect(() => window.codey.onProjectUpdated((project) => {
    window.codey.recordPerformanceTrace({ traceId: 'renderer-session', scope: 'renderer', phase: 'project-update-received', projectId: project.id })
    setProjects((current) => current.map((item) => item.id === project.id ? project : item))
  }), [])

  useEffect(() => window.codey.onNotificationClicked(({ projectId, conversationId }) => {
    if (projectId) {
      setActiveProjectId(projectId)
      if (conversationId) {
        setActiveConversationId(conversationId)
        setTimeout(scrollToBottom, 150)
      }
    }
  }), [])

  useEffect(() => {
    function openDebugger(event: KeyboardEvent): void {
      if (
        config.developerMode &&
        activeProjectId &&
        activeConversationId &&
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'd'
      ) {
        event.preventDefault()
        void window.codey.openContextDebug(activeProjectId, activeConversationId).catch((reason) => {
          setError(reason instanceof Error ? reason.message : t('unableOpenContextDebugger'))
        })
      }
    }

    window.addEventListener('keydown', openDebugger)
    return () => window.removeEventListener('keydown', openDebugger)
  }, [activeConversationId, activeProjectId, config.developerMode, t])

  useEffect(() => window.codey.onMessageNavigation((target) => {
    setActiveProjectId(target.projectId)
    setActiveConversationId(target.conversationId)
    setNavigationTarget({ ...target, requestId: ++navigationSequence.current })
    setShowScrollToBottom(true)
  }), [])

  useEffect(() => {
    if (!navigationTarget || activeProjectId !== navigationTarget.projectId || activeConversationId !== navigationTarget.conversationId) return
    let cancelled = false
    void messageHistory.ensureMessage(navigationTarget.messageId, () => cancelled).then(() => {
      if (cancelled) return
      setShowScrollToBottom(true)
      setScrollRequest(navigationTarget)
      setNavigationTarget(null)
    }).catch((reason) => {
      if (!cancelled) { setError(String(reason)); setNavigationTarget(null) }
    })
    return () => { cancelled = true }
  }, [navigationTarget, activeProjectId, activeConversationId, messageHistory.ensureMessage])

  function scrollToBottom(): void {
    setShowScrollToBottom(false)
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }

  useEffect(() => {
    const root = conversationRef.current
    const end = conversationEndRef.current
    if (!root || !end) {
      setShowScrollToBottom(false)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        setShowScrollToBottom(entry.intersectionRatio < 0.9)

      },
      { root, threshold: 0.9 },
    )
    observer.observe(end)
    return () => observer.disconnect()
  }, [activeConversationId, activeConversation?.messages.length])

  const markVisibleReplyRead = useCallback(async (messageId: string): Promise<void> => {
    if (!activeProjectId || !activeConversationId) return
    const updated = await window.codey.setConversationReadState(activeProjectId, activeConversationId, messageId, Date.now())
    setProjects((current) => current.map((project) => project.id === updated.id ? updated : project))
  }, [activeProjectId, activeConversationId])

  function replaceProject(updated: Project): void {
    setProjects((current) => current.map((project) =>
      project.id === updated.id ? updated : project,
    ))
  }

  async function refreshSkills(): Promise<void> {
    const skills = await window.codey.listSkills()
    setInstalledSkills(skills)
  }

  async function previewSkillImport(): Promise<void> {
    if (!skillUrl.trim() || skillBusy) return
    setSkillBusy(true)
    setSkillError('')
    try {
      const preview = await window.codey.previewGitHubSkill(skillUrl.trim())
      const installed = installedSkills.find((skill) => skill.id === preview.skillId)
      const candidateIds = new Set(preview.candidates.map((candidate) => candidate.id))
      setSkillPreview(preview)
      setSelectedSkillCandidateIds(installed
        ? installed.tools.map((tool) => tool.entry).filter((entry) => candidateIds.has(entry))
        : [])
    } catch (reason) {
      setSkillPreview(null)
      setSkillError(reason instanceof Error ? reason.message : t('unablePreviewSkill'))
    } finally {
      setSkillBusy(false)
    }
  }

  async function installPreviewedSkill(): Promise<void> {
    if (!skillPreview || skillBusy) return
    setSkillBusy(true)
    setSkillError('')
    try {
      await window.codey.installSkillPreview(skillPreview.previewId, selectedSkillCandidateIds)
      await refreshSkills()
      setSkillPreview(null)
      setSelectedSkillCandidateIds([])
    } catch (reason) {
      setSkillError(reason instanceof Error ? reason.message : t('unableInstallSkill'))
    } finally {
      setSkillBusy(false)
    }
  }

  async function removeSkill(skill: InstalledSkill): Promise<void> {
    if (skillBusy || !window.confirm(t('skillRemoveConfirm', { name: skill.name }))) return
    setSkillBusy(true)
    setSkillError('')
    try {
      await window.codey.removeSkill(skill.id)
      const [skills, savedConfig, savedProjects] = await Promise.all([
        window.codey.listSkills(),
        window.codey.getConfig(),
        window.codey.getProjects(),
      ])
      setInstalledSkills(skills)
      setConfig(savedConfig)
      setProjects(savedProjects)
      setConfigDraft((current) => ({
        ...current,
        defaultSkillIds: current.defaultSkillIds.filter((id) => id !== skill.id),
      }))
      if (skillPreview?.skillId === skill.id) setSkillPreview(null)
    } catch (reason) {
      setSkillError(reason instanceof Error ? reason.message : t('unableRemoveSkill'))
    } finally {
      setSkillBusy(false)
    }
  }

  function prepareSkillUpdate(skill: InstalledSkill): void {
    setSkillUrl(skill.sourceUrl)
    setSkillPreview(null)
    setSelectedSkillCandidateIds([])
    setSkillError('')
  }

  async function refreshKnowledgeBases(): Promise<void> {
    setKnowledgeBases(await window.codey.listKnowledgeBases())
  }

  async function chooseKnowledgeBaseDirectory(): Promise<void> {
    if (knowledgeBaseBusy || interactionLocked) return
    setKnowledgeBaseError('')
    try {
      const directory = await window.codey.chooseKnowledgeBaseDirectory()
      if (directory) setKnowledgeBaseDirectory(directory)
    } catch (reason) {
      setKnowledgeBaseError(reason instanceof Error ? reason.message : t('unableChooseKnowledgeBaseDirectory'))
    }
  }

  async function createLocalKnowledgeBase(): Promise<void> {
    if (!knowledgeBaseDirectory.trim() || knowledgeBaseBusy || interactionLocked) return
    setKnowledgeBaseBusy(true)
    setKnowledgeBaseError('')
    try {
      await window.codey.createKnowledgeBase({
        name: knowledgeBaseName.trim() || undefined,
        directoryPath: knowledgeBaseDirectory.trim(),
        mode: knowledgeBaseMode,
        embeddingProvider: knowledgeBaseMode === 'rag'
          ? { kind: 'local', modelId: defaultLocalEmbeddingModelId }
          : null,
      })
      await refreshKnowledgeBases()
      setKnowledgeBaseName('')
      setKnowledgeBaseDirectory('')
      setKnowledgeBaseMode('rg')
    } catch (reason) {
      setKnowledgeBaseError(reason instanceof Error ? reason.message : t('unableCreateKnowledgeBase'))
      await refreshKnowledgeBases().catch(() => undefined)
    } finally {
      setKnowledgeBaseBusy(false)
    }
  }

  async function refreshLocalKnowledgeBase(knowledgeBase: KnowledgeBase): Promise<void> {
    if (knowledgeBaseBusy || interactionLocked) return
    setKnowledgeBaseBusy(true)
    setKnowledgeBaseError('')
    try {
      await window.codey.refreshKnowledgeBase(knowledgeBase.id)
      await refreshKnowledgeBases()
    } catch (reason) {
      setKnowledgeBaseError(reason instanceof Error ? reason.message : t('unableRefreshKnowledgeBase'))
      await refreshKnowledgeBases().catch(() => undefined)
    } finally {
      setKnowledgeBaseBusy(false)
    }
  }

  async function renameKnowledgeBase(knowledgeBase: KnowledgeBase): Promise<void> {
    if (knowledgeBaseBusy || interactionLocked) return
    const name = window.prompt(t('knowledgeBaseName'), knowledgeBase.name)?.trim()
    if (!name || name === knowledgeBase.name) return
    setKnowledgeBaseBusy(true)
    setKnowledgeBaseError('')
    try {
      await window.codey.updateKnowledgeBase(knowledgeBase.id, { name })
      await refreshKnowledgeBases()
    } catch (reason) {
      setKnowledgeBaseError(reason instanceof Error ? reason.message : t('unableUpdateKnowledgeBase'))
    } finally {
      setKnowledgeBaseBusy(false)
    }
  }

  async function changeKnowledgeBaseMode(knowledgeBase: KnowledgeBase, mode: KnowledgeBaseMode): Promise<void> {
    if (mode === knowledgeBase.mode || knowledgeBaseBusy || interactionLocked) return
    setKnowledgeBaseBusy(true)
    setKnowledgeBaseError('')
    try {
      await window.codey.updateKnowledgeBase(knowledgeBase.id, {
        mode,
        embeddingProvider: mode === 'rag'
          ? { kind: 'local', modelId: defaultLocalEmbeddingModelId }
          : null,
      })
      await refreshKnowledgeBases()
    } catch (reason) {
      setKnowledgeBaseError(reason instanceof Error ? reason.message : t('unableUpdateKnowledgeBase'))
      await refreshKnowledgeBases().catch(() => undefined)
    } finally {
      setKnowledgeBaseBusy(false)
    }
  }

  async function removeLocalKnowledgeBase(knowledgeBase: KnowledgeBase): Promise<void> {
    if (knowledgeBaseBusy || interactionLocked || !window.confirm(t('removeKnowledgeBaseConfirm', { name: knowledgeBase.name }))) return
    setKnowledgeBaseBusy(true)
    setKnowledgeBaseError('')
    try {
      await window.codey.removeKnowledgeBase(knowledgeBase.id)
      const [items, savedConfig, savedProjects] = await Promise.all([
        window.codey.listKnowledgeBases(),
        window.codey.getConfig(),
        window.codey.getProjects(),
      ])
      setKnowledgeBases(items)
      setConfig(savedConfig)
      setProjects(savedProjects)
      setConfigDraft((current) => ({
        ...current,
        defaultKnowledgeBaseIds: current.defaultKnowledgeBaseIds.filter((id) => id !== knowledgeBase.id),
      }))
    } catch (reason) {
      setKnowledgeBaseError(reason instanceof Error ? reason.message : t('unableRemoveKnowledgeBase'))
    } finally {
      setKnowledgeBaseBusy(false)
    }
  }

  function selectProject(project: Project): void {
    const firstConversation = project.conversations.find((conversation) => !conversation.archived)
    setActiveProjectId(project.id)
    setActiveConversationId(firstConversation?.id ?? '')
    setOpenProjectMenuId(null)
    setOpenConversationMenuId(null)
    setError('')
  }

  async function setProjectArchive(project: Project, archived: boolean): Promise<void> {
    try {
      const updated = await window.codey.setProjectArchived(project.id, archived)
      replaceProject(updated)
      setOpenProjectMenuId(null)
      if (archived && activeProjectId === project.id) {
        const nextProject = projects.find((item) => item.id !== project.id && !item.archived)
        if (nextProject) selectProject(nextProject)
        else {
          setActiveProjectId('')
          setActiveConversationId('')
        }
      } else if (!archived && !activeProjectId) {
        selectProject(updated)
      }
    } catch (reason) {
      setArchiveError(reason instanceof Error ? reason.message : t('unableArchive'))
    }
  }

  async function setConversationArchive(projectId: string, conversationId: string, archived: boolean): Promise<void> {
    try {
      const updated = await window.codey.setConversationArchived(projectId, conversationId, archived)
      replaceProject(updated)
      setOpenConversationMenuId(null)
      if (archived && activeProjectId === projectId && activeConversationId === conversationId) {
        const nextConversation = updated.conversations.find((conversation) => !conversation.archived)
        setActiveConversationId(nextConversation?.id ?? '')
      }
    } catch (reason) {
      setArchiveError(reason instanceof Error ? reason.message : t('unableArchive'))
    }
  }

  async function markProjectAllRead(project: Project): Promise<void> {
    for (const conv of project.conversations) {
      const lastReplyId = conv.history?.lastReplyMessageId ?? conversationReadState(conv.messages).lastReplyMessageId
      if (lastReplyId) {
        try {
          const result = await window.codey.setConversationReadState(project.id, conv.id, lastReplyId, Date.now())
          replaceProject(result)
        } catch {}
      }
    }
    setOpenProjectMenuId(null)
  }

  function openArchiveList(): void {
    setSettingsOpen(false)
    setArchiveError('')
    setArchiveDialogOpen(true)
  }

  function openSettings(): void {
    // Keep unsaved drafts (e.g. a freshly added model configuration) across
    // dialog close/reopen; only seed once when the dialog has never been
    // opened or after a successful save replaced the draft.
    if (!settingsOpenedOnceRef.current || configDraft === config) {
      setConfigDraft(createSettingsDraft())
      settingsOpenedOnceRef.current = true
    }
    setSettingsError('')
    void window.codey.getCachedShellDetection().then((cached) => {
      if (cached) setShellDetection(cached)
    }).catch(() => undefined)
    setSettingsOpen(true)
  }

  async function openPerformanceTracing(): Promise<void> {
    setPerformanceError('')
    setPerformanceDialogOpen(true)
    try {
      const [status, files] = await Promise.all([
        window.codey.getPerformanceTraceStatus(),
        window.codey.listPerformanceTraceFiles(),
      ])
      setPerformanceStatus(status)
      setPerformanceFiles(files)
    } catch {
      setPerformanceError(t('unableLoadPerformanceTrace'))
    }
  }

  async function togglePerformanceTracing(enabled: boolean): Promise<void> {
    setPerformanceError('')
    try {
      setPerformanceStatus(await window.codey.setPerformanceTracingEnabled(enabled))
      setPerformanceFiles(await window.codey.listPerformanceTraceFiles())
    } catch {
      setPerformanceError(t('unableUpdatePerformanceTrace'))
    }
  }

  async function openPerformanceTraceFile(fileName: string): Promise<void> {
    setPerformanceError('')
    try {
      await window.codey.openPerformanceTraceFile(fileName)
    } catch {
      setPerformanceError(t('unableOpenPerformanceTrace'))
    }
  }

  async function exportPerformanceTracing(): Promise<void> {
    setPerformanceError('')
    try {
      const path = await window.codey.exportPerformanceTraces()
      if (path) {
        setPerformanceError(t('performanceTraceExported'))
        setPerformanceStatus(await window.codey.getPerformanceTraceStatus())
      }
    } catch {
      setPerformanceError(t('unableExportPerformanceTrace'))
    }
  }

  async function revealPerformanceTracing(): Promise<void> {
    setPerformanceError('')
    try {
      await window.codey.revealPerformanceTraces()
    } catch {
      setPerformanceError(t('unableRevealPerformanceTrace'))
    }
  }

  async function openBridgeDialog(): Promise<void> {
    setBridgeDialogOpen(true)
    setBridgeError('')
    try {
      setBridgeChannels(await window.codey.getBridgeChannels())
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : t('unableLoadHandoverStatus'))
    }
  }

  async function createBridgeChannel(): Promise<void> {
    setBridgeBusy(true)
    setBridgeError('')
    try {
      await window.codey.createBridgeChannel(bridgeUrl)
      setBridgeChannels(await window.codey.getBridgeChannels())
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : t('createHandoverChannelFailed'))
    } finally {
      setBridgeBusy(false)
    }
  }

  async function approveBridgeRequest(channelId: string, request: BridgeChannelStatus['pendingRequests'][number]): Promise<void> {
    setBridgeBusy(true)
    setBridgeError('')
    try {
      setBridgeChannels(await window.codey.approveBridgeRequest(channelId, request.id, request.devicePublicKey))
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : t('approveHandoverRequestFailed'))
    } finally {
      setBridgeBusy(false)
    }
  }

  async function rejectBridgeRequest(channelId: string, requestId: string): Promise<void> {
    setBridgeBusy(true)
    setBridgeError('')
    try {
      setBridgeChannels(await window.codey.rejectBridgeRequest(channelId, requestId))
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : t('rejectHandoverRequestFailed'))
    } finally {
      setBridgeBusy(false)
    }
  }

  async function copyBridgeInvitation(channel: BridgeChannelStatus): Promise<void> {
    if (!channel.invitation) return
    try {
      await navigator.clipboard.writeText(channel.invitation)
      setBridgeError(t('handoverInvitationCopied'))
    } catch {
      setBridgeError(t('handoverInvitationCopyFailed'))
    }
  }

  async function syncBridgeNow(channelId?: string): Promise<void> {
    setBridgeBusy(true)
    setBridgeError('')
    try {
      setBridgeChannels(await window.codey.syncBridge(channelId))
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : t('syncHandoverFailed'))
    } finally {
      setBridgeBusy(false)
    }
  }

  async function refreshBridgeEnrollment(channelId: string): Promise<void> {
    setBridgeBusy(true)
    setBridgeError('')
    try {
      const refreshed = await window.codey.refreshBridgeEnrollment(channelId)
      setBridgeChannels((channels) => channels.map((channel) => channel.channelId === refreshed.channelId ? refreshed : channel))
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : t('refreshHandoverInvitationFailed'))
    } finally {
      setBridgeBusy(false)
    }
  }

  async function removeBridgeChannel(channel: BridgeChannelStatus): Promise<void> {
    if (!window.confirm(t('removeHandoverChannelConfirm', { channelId: channel.channelId }))) return
    setBridgeBusy(true)
    setBridgeError('')
    try {
      setBridgeChannels(await window.codey.removeBridgeChannel(channel.channelId))
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : t('removeHandoverChannelFailed'))
    } finally {
      setBridgeBusy(false)
    }
  }

  function respondCommandApproval(approved: boolean, memory?: CommandApprovalMemory): void {
    const request = approvalRequest
    if (!request) return
    setApprovalRequest(null)
    void window.codey.respondCommandReview(request.requestId, { approved, memory }).catch(() => undefined)
  }

  useEffect(() => window.codey.onCommandReviewRequest((request) => setApprovalRequest(request)), [])

  async function runShellDetection(): Promise<void> {
    if (shellDetectBusy) {
      return
    }
    setShellDetectBusy(true)
    try {
      setShellDetection(await window.codey.detectShells())
    } catch {
      setShellDetection(null)
    } finally {
      setShellDetectBusy(false)
    }
  }

  async function pickBashExecutable(): Promise<void> {
    try {
      const picked = await window.codey.pickBashExecutable()
      if (picked) {
        setShellDetection(await window.codey.detectShells())
      }
    } catch {
      showToast(t('unableChangeCommandExecution'), 'error')
    }
  }

  async function openWsl2Config(): Promise<void> {
    if (wsl2ConfigBusy) {
      return
    }
    setWsl2ConfigOpen(true)
    setWsl2ConfigBusy(true)
    try {
      const [distros, current] = await Promise.all([
        window.codey.listWslDistros(),
        window.codey.getWsl2ManualConfig(),
      ])
      setWslDistros(distros)
      setWsl2Draft(current ?? { distro: distros[0] ?? '', sandboxUser: '' })
    } catch {
      setWslDistros([])
    } finally {
      setWsl2ConfigBusy(false)
    }
  }

  async function saveWsl2Config(): Promise<void> {
    if (!wsl2Draft.distro.trim() || !wsl2Draft.sandboxUser.trim()) {
      return
    }
    setWsl2ConfigBusy(true)
    try {
      await window.codey.setWsl2ManualConfig({ distro: wsl2Draft.distro.trim(), sandboxUser: wsl2Draft.sandboxUser.trim() })
      setShellDetection(await window.codey.detectShells())
    } catch {
      showToast(t('unableChangeCommandExecution'), 'error')
    } finally {
      setWsl2ConfigBusy(false)
    }
  }

  async function clearWsl2Config(): Promise<void> {
    setWsl2ConfigBusy(true)
    try {
      await window.codey.setWsl2ManualConfig(null)
      setShellDetection(await window.codey.detectShells())
    } catch {
      showToast(t('unableChangeCommandExecution'), 'error')
    } finally {
      setWsl2ConfigBusy(false)
    }
  }

  function showToast(message: string, tone: 'info' | 'error'): void {
    if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    setToast({ message, tone })
    toastTimerRef.current = window.setTimeout(() => setToast(null), 5_000)
  }

  async function setNetworkAccess(enabled: boolean): Promise<void> {
    if (interactionLocked) return
    const next = { ...config, networkAccessEnabled: enabled }
    setConfig(next)
    setConfigDraft((current) => ({ ...current, networkAccessEnabled: enabled }))
    try {
      const saved = await window.codey.saveConfig(next)
      setConfig(saved)
      setConfigDraft(saved)
      setError('')
    } catch {
      setConfig(config)
      setConfigDraft((current) => ({ ...current, networkAccessEnabled: config.networkAccessEnabled }))
      setError(t('invalidModelConfig'))
    }
  }

  async function saveSettings(): Promise<void> {
    setSaving(true)
    setSettingsError('')

    try {
      const saved = await window.codey.saveConfig(configDraft)
      setConfig(saved)
      setConfigDraft(saved)
      setAppLanguage(saved.language)
      invalidateToolHelp()
      setError('')
      setSettingsOpen(false)
    } catch {
      setSettingsError(t('invalidModelConfig'))
    } finally {
      setSaving(false)
    }
  }

  function openProjectDialog(): void {
    setProjectName('')
    setProjectError('')
    setProjectDialogOpen(true)
  }

  function openProjectRename(project: Project): void {
    setOpenProjectMenuId(null)
    setOpenConversationMenuId(null)
    setRenameError('')
    setRenameTarget({ kind: 'project', projectId: project.id, name: project.name })
  }

  function openConversationRename(projectId: string, conversation: Project['conversations'][number]): void {
    setOpenProjectMenuId(null)
    setOpenConversationMenuId(null)
    setRenameError('')
    setRenameTarget({ kind: 'conversation', projectId, conversationId: conversation.id, name: conversation.title })
  }

  function closeRenameDialog(): void {
    if (renaming) return
    setRenameTarget(null)
    setRenameError('')
  }

  async function renameSelectedItem(): Promise<void> {
    const target = renameTarget
    if (!target || !target.name.trim() || renaming) return

    setRenaming(true)
    setRenameError('')
    try {
      const updated = target.kind === 'project'
        ? await window.codey.renameProject(target.projectId, target.name)
        : await window.codey.renameConversation(target.projectId, target.conversationId, target.name)
      replaceProject(updated)
      setRenameTarget(null)
    } catch {
      setRenameError(t(target.kind === 'project' ? 'unableRenameProject' : 'unableRenameConversation'))
    } finally {
      setRenaming(false)
    }
  }

  async function createNewProject(): Promise<void> {
    if (!projectName.trim() || creatingProject) {
      return
    }

    setCreatingProject(true)
    setProjectError('')

    try {
      const project = await window.codey.createProject(projectName)
      setProjects((current) => [...current, project])
      setActiveProjectId(project.id)
      setActiveConversationId(project.conversations[0]?.id ?? '')
      setProjectName('')
      setProjectDialogOpen(false)
    } catch {
      setProjectError(t('projectNameRequired'))
    } finally {
      setCreatingProject(false)
    }
  }

  async function addFolder(): Promise<void> {
    if (!activeProject) {
      return
    }

    try {
      const updated = await window.codey.addProjectFolder(activeProject.id)
      if (updated) {
        replaceProject(updated)
      }
    } catch {
      setError(t('unableAddFolder'))
    }
  }

  async function changeProjectModelConfig(projectId: string, modelConfigId: string): Promise<void> {
    if (interactionLocked) {
      return
    }

    try {
      const updated = await window.codey.setProjectModelConfig(projectId, modelConfigId || null)
      replaceProject(updated)
    } catch {
      setError(t('unableChangeModelConfig'))
    }
  }

  async function changeConversationModelConfig(modelConfigId: string): Promise<void> {
    if (!activeProject || !activeConversation || interactionLocked) {
      return
    }

    try {
      const updated = await window.codey.setConversationModelConfig(
        activeProject.id,
        activeConversation.id,
        modelConfigId || null,
      )
      replaceProject(updated)
    } catch {
      setError(t('unableChangeModelConfig'))
    }
  }

  async function startNewConversation(): Promise<void> {
    if (!activeProject) {
      return
    }

    try {
      const updated = await window.codey.createConversation(activeProject.id)
      replaceProject(updated)
      setActiveConversationId(updated.conversations.at(-1)?.id ?? '')
      setError('')
    } catch {
      setError(t('unableCreateConversation'))
    }
  }

  async function sendMessage(content: string, images: ImageAttachment[], attachments: MediaAttachment[], continueFromMessageId?: string): Promise<void> {
    if ((!content && images.length === 0 && attachments.length === 0) || !canSend || !activeProject || !activeConversation || interactionLocked) {
      return
    }

    const projectId = activeProject.id
    const conversationId = activeConversation.id
    const conversationKey = `${projectId}:${conversationId}`
    const traceId = crypto.randomUUID()
    const sendStartedAt = performance.now()
    setError('')
    const userMessageId = crypto.randomUUID()
    messageHistory.addOptimistic({ id: userMessageId, role: 'user', content, images, attachments, createdAt: new Date().toISOString() })
    window.codey.recordPerformanceTrace({
      traceId, scope: 'renderer', phase: 'user-message-published', projectId, conversationId,
      durationMs: performance.now() - sendStartedAt, data: { contentChars: content.length, imageCount: images.length, attachmentCount: attachments.length },
    })
    beginTurn({ projectId, conversationId, userMessageId, traceId })

    try {
      window.codey.recordPerformanceTrace({ traceId, scope: 'renderer', phase: 'develop-ipc', projectId, conversationId })
      const result = await window.codey.develop(projectId, conversationId, content, images, attachments, traceId, continueFromMessageId)
      if (result.project) {
        const updatedConversation = result.project.conversations.find(
          (conversation) => conversation.id === conversationId,
        )
        const updatedUserMessage = updatedConversation?.history?.lastUserMessage
        await messageHistory.refresh()
        if (updatedUserMessage?.id) updateTurnUserMessage(conversationKey, updatedUserMessage.id)
        replaceProject(result.project)
      }
      finishTurn(conversationKey, {
        result: result.stopped
          ? 'stopped'
          : result.error
            ? /timed out/i.test(result.error) ? 'timeout' : 'other'
            : 'normal',
        error: result.stopped ? undefined : result.error,
      })
      if (result.error && conversationKey === activeConversationKeyRef.current) {
        const files = result.writtenFiles.length
          ? t('filesWritten', { count: result.writtenFiles.length })
          : ''
        setError(`${result.error}${files}`)
      }
    } catch {
      finishTurn(conversationKey, { result: 'other', error: t('requestFailed') })
      if (conversationKey === activeConversationKeyRef.current) setError(t('unableProcessRequest'))
    } finally {
      clearRun(conversationKey)
    }
  }
  async function stopMessage(): Promise<void> {
    if (!activeProject || !activeConversation || !conversationWorking || stopping) {
      return
    }

    const conversationKey = `${activeProject.id}:${activeConversation.id}`
    setStopping(conversationKey, true)
    try {
      const accepted = await window.codey.stopDevelopment(activeProject.id, activeConversation.id)
      if (!accepted) {
        setStopping(conversationKey, false)
      }
    } catch {
      setStopping(conversationKey, false)
      if (conversationKey === activeConversationKeyRef.current) setError(t('unableStopRequest'))
    }
  }

  const emptyTitle = !activeProject
    ? t('createProject')
    : activeProject.folders.length === 0
      ? t('addProjectFolder')
      : t('whatBuild')
  const emptyDescription = !activeProject
    ? t('projectDescription')
    : activeProject.folders.length === 0
      ? t('folderDescription')
      : t('conversationDescription')
  const sortedConversationModelGroups = [...config.modelGroups].sort((a, b) => (a.name || t('unnamedModelGroup')).localeCompare(b.name || t('unnamedModelGroup')))
  const sortedConversationModels = [...config.models].sort((a, b) => (a.name || t('unnamedModel')).localeCompare(b.name || t('unnamedModel')))
  const invalidAppContextConfig = !isValidContextConfig(configDraft.contextManagement)
  const invalidGlobalCommandReview = !validateCommandReviewConfig(configDraft.commandReviewGlobal)
  const invalidGlobalAgentLimits = !isValidAgentLimits(configDraft.agentLimitsGlobal)
  const invalidGlobalCommandExecution = !isValidCommandExecutionDraft(configDraft.commandExecutionGlobal)

  return (
    <FluentProvider className="app" theme={webLightTheme}>
      <main className="shell">
        <aside className="sidebar">

          <Button appearance="primary" onClick={openProjectDialog}>
            {t('newProject')}
          </Button>

          <section className="sidebar-section projects-section">
            <p className="section-label">{t('projects')}</p>
            <nav className="nav-list" aria-label={t('projects')}>
              {visibleProjects.map((project) => (
                <div className="project-nav-item" key={project.id}>
                  <div className="project-nav-row">
                    <Button className="nav-item-button" appearance={project.id === activeProjectId ? 'secondary' : 'subtle'} onClick={() => selectProject(project)}>
                      <span className="nav-item-title">{project.name}</span>
                      <UnreadBadge count={projectUnreadState[project.id]?.count ?? 0} error={projectUnreadState[project.id]?.error ?? false} />
                    </Button>
                    <Button appearance="subtle" size="small" aria-expanded={openProjectMenuId === project.id} aria-label={t('projectOptions')} onClick={() => setOpenProjectMenuId((current) => current === project.id ? null : project.id)}>
                      …
                    </Button>
                  </div>
                  {openProjectMenuId === project.id && (
                    <div className="project-menu-panel">
                      <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => openProjectRename(project)}>{t('renameProject')}</Button>
                      <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => openProjectSettings(project)}>{t('projectSettings')}</Button>
                      <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => void markProjectAllRead(project)}>{t('markAllRead')}</Button>
                      <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => void setProjectArchive(project, true)}>{t('archiveProject')}</Button>
                    </div>
                  )}
                </div>
              ))}
            </nav>
          </section>

          {activeProject && (
            <section className="sidebar-section conversations-section">
              <div className="section-heading">
                <p className="section-label">{t('conversations')}</p>
                <Button appearance="subtle" size="small" onClick={() => void startNewConversation()}>{t('new')}</Button>
              </div>
              <nav className="nav-list" aria-label={t('conversations')}>
                {visibleConversations.map((conversation) => (
                  <div className="conversation-nav-item" key={conversation.id}>
                    <div className="conversation-nav-row">
                      <Button className="nav-item-button" appearance={conversation.id === activeConversationId ? 'secondary' : 'subtle'} onClick={() => {
                        setActiveConversationId(conversation.id);
                        setOpenConversationMenuId(null);
                        setError('');
                        scrollToBottom();

                      }}>
                        <span className="nav-item-title">{conversation.title}</span>
                        <UnreadBadge count={unreadCounts[conversation.id] ?? 0} error={conversationErrors[conversation.id] ?? false} />
                      </Button>
                      <Button appearance="subtle" size="small" aria-expanded={openConversationMenuId === conversation.id} aria-label={t('conversationOptions')} onClick={() => setOpenConversationMenuId((current) => current === conversation.id ? null : conversation.id)}>…</Button>
                    </div>
                    {openConversationMenuId === conversation.id && (
                      <div className="conversation-menu-panel">
                        <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => openConversationRename(activeProject.id, conversation)}>{t('renameConversation')}</Button>
                        <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => void setConversationArchive(activeProject.id, conversation.id, true)}>{t('archiveConversation')}</Button>
                      </div>
                    )}
                  </div>
                ))}
              </nav>
            </section>
          )}

          <Button className="settings-button" appearance="subtle" onClick={openHelp}>
            {t('help')}
          </Button>
          <Button className="settings-button" appearance="subtle" onClick={openSettings}>
            {t('settings')}
          </Button>
          <div className="performance-nav-row">
            <Button appearance="subtle" disabled={!config.developerMode} onClick={() => void openPerformanceTracing()}>
              {t('performanceTracing')}
            </Button>
            <Button
              appearance="subtle"
              className="performance-toggle-button"
              aria-label={performanceStatus?.enabled ? t('stopPerformanceTracing') : t('startPerformanceTracing')}
              title={performanceStatus?.enabled ? t('stopPerformanceTracing') : t('startPerformanceTracing')}
              disabled={!config.developerMode || !performanceStatus}
              onClick={() => void togglePerformanceTracing(!performanceStatus?.enabled)}
            >
              <span aria-hidden="true" className={performanceStatus?.enabled ? 'performance-toggle-icon stop' : 'performance-toggle-icon play'} />
            </Button>
          </div>
          <Button appearance="subtle" onClick={() => void openBridgeDialog()}>
            {t('handover')}
          </Button>
        </aside>

        <section className="workspace">
          <header className="topbar">
            <div>
              <strong>{activeProject?.name ?? 'Codey'}</strong>
              {activeConversation && <span>{activeConversation.title}</span>}
            </div>
            <div className="topbar-controls">
              {activeConversation && config.models.length > 0 ? (
                <div className="topbar-row topbar-model-row">
                  <label className="topbar-field-label">
                    <span>{t('configuration')}:</span>
                    <span className="conversation-model-picker">
                      <span>
                        {effectiveModelConfig?.name || effectiveModelConfig?.modelName || t('notConfigured')}
                        {config.modelGroups.some((group) => group.id === effectiveModelConfigId) &&
                          <span className="model-group-badge">{t('modelGroupBadge')}</span>}
                      </span>
                      <select
                        aria-label={t('conversationModel')}
                        disabled={interactionLocked}
                        value={activeConversation.modelConfigId ?? ''}
                        onChange={(event) => void changeConversationModelConfig(event.target.value)}
                      >
                        <option value="">{t('followProjectDefault')}</option>
                        {sortedConversationModelGroups.map((group) => (
                          <option key={group.id} value={group.id}>
                            {t('modelGroupOption', { name: group.name || t('unnamedModelGroup') })}
                          </option>
                        ))}
                        {sortedConversationModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name || t('unnamedModel')}
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                  <span className="topbar-model-name">
                    <span>{t('providerLabel')}:</span>
                    <strong>{configured ? displayedSessionModel?.providerName || t('notConfigured') : t('notConfigured')}</strong>
                  </span>
                  <span className="topbar-model-name">
                    <span>{t('modelLabel')}:</span>
                    <strong>{configured ? displayedSessionModel?.modelName : t('notConfigured')}</strong>
                  </span>
                </div>
              ) : (
                <div className="topbar-row topbar-model-row">
                  <span className="status">{t('notConfigured')}</span>
                </div>
              )}
              {activeConversation && (
                <div className="topbar-row">
                  <span className="conversation-round-count">{t('conversationRoundCount', { count: conversationRoundCount })}</span>
                  <Button appearance="subtle" size="small" onClick={() => {
                    void window.codey.openMessageNavigation(activeProjectId, activeConversation.id).catch((reason) => setError(String(reason)))
                  }}>
                    {t('messageNavigation')}
                  </Button>
                  <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={openAgentLimitsSettings}>
                    {t('agentLimits')}
                  </Button>
                  {config.developerMode && activeProject && (
                    <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={openCommandSettings}>
                      {t('commandAndReview')}：{(activeConversation.commandExecution ?? activeProject.commandExecutionDefault ?? defaultCommandExecutionConfig).enabled ? t('commandExecutionOn') : t('commandExecutionOff')}
                    </Button>
                  )}
                </div>
              )}
              {activeConversation && (
                <div className="topbar-row">
                  <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={openConversationSkills}>
                    {t('skills')} · {effectiveSkills.length}
                  </Button>
                  <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={openConversationKnowledgeBases}>
                    {t('knowledgeBase')} · {effectiveKnowledgeBases.length}
                  </Button>
                </div>
              )}
              {activeConversation && (
                <div className="topbar-row">
                  <Button appearance="subtle" size="small" disabled={interactionLocked} onClick={() => openContextSettings('conversation')}>
                    {t('contextSettings')} · {effectiveContextStrategyLabel}
                  </Button>
                  {config.developerMode && activeProject && (
                    <Button
                      appearance="subtle"
                      size="small"
                      title={t('contextDebuggerShortcut')}
                      onClick={() => void window.codey
                        .openContextDebug(activeProject.id, activeConversation.id)
                        .catch((reason) => setError(
                          reason instanceof Error ? reason.message : t('unableOpenContextDebugger'),
                        ))}
                    >
                      {t('openContextDebugger')}
                    </Button>
                  )}
                </div>
              )}
              {context && contextStatus && (
                <div className="topbar-row">
                  <span
                    className="context-status"
                    title={t('peakInputTitle', { original: context.originalTokens, compressed: context.compressedTokens })}
                  >
                    {contextStatus}
                  </span>
                </div>
              )}
              {conversationContextConfigInvalid && (
                <div className="topbar-row">
                  <span className="context-config-invalid" role="alert">
                    {t('conversationContextConfigInvalid', { model: effectiveModelConfig?.name || effectiveModelConfig?.modelName })}
                  </span>
                </div>
              )}
            </div>
          </header>

          {activeProject && (
            <div className="folderbar">
              <div className="folder-list">
                {activeProject.folders.length === 0 ? (
                  <span>{t('noFolders')}</span>
                ) : (
                  activeProject.folders.map((folder) => (
                    <span className="folder" key={folder.id} title={folder.path}>
                      {folder.path}
                    </span>
                  ))
                )}
              </div>
              <Button disabled={interactionLocked} size="small" onClick={() => void addFolder()}>
                {t('addFolder')}
              </Button>
            </div>
          )}

          <div className="conversation-container">
            <div
              ref={conversationRef}
              className="conversation"
              aria-label={t('conversation')}
            >
            {!activeConversation || (messageHistory.loaded && activeConversation.messages.length === 0 && !interactionLocked) ? (
              <div className="empty-state">
                <h1>{emptyTitle}</h1>
                <p>{emptyDescription}</p>
                {!activeProject && (
                  <Button appearance="primary" onClick={openProjectDialog}>
                    {t('newProject')}
                  </Button>
                )}
                {activeProject && activeProject.folders.length === 0 && (
                  <Button appearance="primary" onClick={() => void addFolder()}>
                    {t('addFolder')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="messages" aria-live="polite">
                {messageHistory.loading && <div role="status">{t('loadingConversationMessages')}</div>}
                {messageHistory.error && <div role="alert">{t('unableLoadConversationMessages')} {messageHistory.error} <Button size="small" onClick={() => void messageHistory.retry()}>{t('retryConversationMessages')}</Button></div>}
                <ConversationMessages
                  key={activeConversationKey}
                  messages={activeConversation.messages}
                  onRead={settingsOpen ? undefined : markVisibleReplyRead}
                  pagination={{ hasOlder: Boolean(messageHistory.before), loading: messageHistory.loadingOlder, loadOlder: messageHistory.loadOlder }}
                  projectId={activeProjectId}
                  conversationId={activeConversation.id}
                  conversationTurn={conversationTurn}
                  scrollContainerRef={conversationRef}
                  shouldStickToBottom={!showScrollToBottom}
                  scrollRequest={scrollRequest?.projectId === activeProjectId && scrollRequest?.conversationId === activeConversation.id ? scrollRequest : undefined}
                  lastUserMessageId={lastUserMessageId}
                  onContinue={continueConversation}
                />
                <div aria-hidden="true" className="conversation-end" ref={conversationEndRef} />
              </div>
            )}
            </div>
            {showScrollToBottom && (
              <Button
                aria-label={t('scrollToBottom')}
                className="scroll-to-bottom"
                appearance="secondary"
                shape="circular"
                onClick={scrollToBottom}
                title={t('scrollToBottom')}
              >
                ↓
              </Button>
            )}
          </div>

          {error && <p className="composer-error" role="alert">{error}</p>}
          <Composer
            key={activeConversationKey || 'no-conversation'}
            canSend={canSend}
            supportsImageInput={effectiveModelConfig?.supportsImageInput ?? false}
            supportsVideoInput={effectiveModelConfig?.supportsVideoInput ?? false}
            supportsAudioInput={effectiveModelConfig?.supportsAudioInput ?? false}
            supportsPdfInput={effectiveModelConfig?.supportsPdfInput ?? false}
            configured={configured}
            conversationWorking={conversationWorking}
            hasActiveConversation={Boolean(activeConversation)}
            hasProjectFolders={Boolean(activeProject?.folders.length)}
            interactionLocked={interactionLocked}
            networkAccessEnabled={config.networkAccessEnabled}
            stopping={stopping}
            onError={setError}
            onNetworkAccessChange={(enabled) => void setNetworkAccess(enabled)}
            onStop={() => void stopMessage()}
            onSubmit={(content, images, attachments) => {
              if (maxInputTokensError) {
                setError(maxInputTokensError)
                return false
              }
              if (!canSend || !activeProject || !activeConversation || interactionLocked) return false
              void sendMessage(content, images, attachments)
              return true
            }}
          />
        </section>
      </main>

      <Dialog
        open={projectDialogOpen}
        onOpenChange={(_, data) => setProjectDialogOpen(data.open)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('newProject')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <Field label={t('projectName')} required>
                <Input
                  autoFocus
                  value={projectName}
                  onChange={(_, data) => setProjectName(data.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void createNewProject()
                    }
                  }}
                />
              </Field>
              {projectError && <p className="dialog-error">{projectError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setProjectDialogOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={!projectName.trim() || creatingProject}
                onClick={() => void createNewProject()}
              >
                {creatingProject ? t('creating') : t('create')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(_, data) => {
          if (!data.open) closeRenameDialog()
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t(renameTarget?.kind === 'conversation' ? 'renameConversation' : 'renameProject')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <Field label={t(renameTarget?.kind === 'conversation' ? 'conversationName' : 'projectName')} required>
                <Input
                  autoFocus
                  value={renameTarget?.name ?? ''}
                  onChange={(_, data) => setRenameTarget((current) => current ? { ...current, name: data.value } : current)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void renameSelectedItem()
                    }
                  }}
                />
              </Field>
              {renameError && <p className="dialog-error">{renameError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={renaming} onClick={closeRenameDialog}>
                {t('cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={!renameTarget?.name.trim() || renaming}
                onClick={() => void renameSelectedItem()}
              >
                {renaming ? t('saving') : t('rename')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={performanceDialogOpen} onOpenChange={(_, data) => setPerformanceDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('performanceTracing')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <p className="settings-description">{t('performanceTracingDescription')}</p>
              {!config.developerMode && <p className="settings-warning">{t('performanceTracingRequiresDeveloperMode')}</p>}
              {performanceStatus && (
                <>
                  <p className="status">{performanceStatus.enabled ? t('performanceTracingEnabled') : t('performanceTracingDisabled')}</p>
                  <p className="status">{t('performanceTracePath')}: {performanceStatus.path}</p>
                  <p className="status">{t('performanceTraceSize')}: {performanceStatus.sizeBytes.toLocaleString()} B</p>
                </>
              )}
              <div className="performance-trace-files">
                <strong>{t('performanceTraceFiles')}</strong>
                {performanceFiles.length === 0 ? <p className="trace-empty">{t('noPerformanceTraceFiles')}</p> : performanceFiles.map((file) => (
                  <Button key={file.name} appearance="subtle" className="performance-trace-file" onClick={() => void openPerformanceTraceFile(file.name)}>
                    <span>{file.name}</span>
                    <small>{file.sizeBytes.toLocaleString()} B · {new Date(file.modifiedAt).toLocaleString()}</small>
                  </Button>
                ))}
              </div>
              {performanceError && <p className="dialog-error">{performanceError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => void revealPerformanceTracing()} disabled={!performanceStatus}>{t('revealPerformanceTraces')}</Button>
              <Button appearance="secondary" onClick={() => void exportPerformanceTracing()} disabled={!performanceStatus || performanceStatus.sizeBytes === 0}>{t('exportPerformanceTraces')}</Button>
              <Button appearance="secondary" onClick={() => setPerformanceDialogOpen(false)}>{t('close')}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <HelpDialog {...helpDialogProps} />

      {approvalRequest && (
        <CommandApprovalDialog
          request={approvalRequest}
          onRespond={(approved, memory) => respondCommandApproval(approved, memory)}
          onOpenSyntaxHelp={openCommandRulesHelp}
        />
      )}

      <Dialog open={settingsOpen} onOpenChange={(_, data) => setSettingsOpen(data.open)}>
        <DialogSurface className="settings-dialog-surface">
          <DialogBody className="settings-dialog-body">
            <DialogTitle>{t('settings')}</DialogTitle>
            <DialogContent className="settings-dialog-content settings-layout">
              <TabList
                className="settings-tab-list"
                vertical
                selectedValue={settingsTab}
                onTabSelect={(_, data) => {
                  const next = data.value as typeof settingsTab
                  setSettingsTab(next)
                  if (next === 'prompts' && !promptSnapshot) {
                    void window.codey.getPromptSnapshot().then(setPromptSnapshot).catch(() => setPromptSnapshot(null))
                  }
                  if (next === 'about' && appVersion === null) {
                    void window.codey.getAppVersion().then(setAppVersion).catch(() => setAppVersion(''))
                  }
                }}
              >
                <Tab value="models">{t('models')}</Tab>
                <Tab value="global">{t('globalSettings')}</Tab>
                <Tab value="skills">{t('skills')}</Tab>
                <Tab value="knowledgeBases">{t('knowledgeBases')}</Tab>
                <Tab value="mcp">{t('mcp')}</Tab>
                <Tab value="language">{t('language')}</Tab>
                <Tab value="power">{t('powerSettings')}</Tab>
                <Tab value="notifications">{t('notifications')}</Tab>
                <Tab value="archive">{t('archivedItems')}</Tab>
                <Tab value="developer">{t('developerMode')}</Tab>
                <Tab value="prompts">{t('prompts')}</Tab>
                <Tab value="about">{t('about')}</Tab>
              </TabList>
              <div className="settings-panel" key={settingsTab}>
              {settingsTab === 'models' && (
                <ModelSettingsPanel {...modelSettingsPanelProps} />
              )}
              {settingsTab === 'global' && (
                <GlobalSettingsPanel
                  selectedTab={globalSettingsTab}
                  onTabSelect={setGlobalSettingsTab}
                  configDraft={configDraft}
                  onConfigDraftChange={(updater) => setConfigDraft(updater)}
                  interactionLocked={interactionLocked}
                  sortedModelGroups={sortedConfigDraftModelGroups}
                  sortedModels={sortedConfigDraftModels}
                  flatModelConfigs={flatDraftModelConfigs}
                  onOpenSyntaxHelp={openCommandRulesHelp}
                  shellDetection={shellDetection}
                  shellDetectBusy={shellDetectBusy}
                  onRunShellDetection={() => void runShellDetection()}
                  onPickBashExecutable={() => void pickBashExecutable()}
                  wsl2ConfigOpen={wsl2ConfigOpen}
                  onOpenWsl2Config={() => void openWsl2Config()}
                  wslDistros={wslDistros}
                  wsl2Draft={wsl2Draft}
                  wsl2ConfigBusy={wsl2ConfigBusy}
                  onWsl2DraftChange={(patch) => setWsl2Draft((current) => ({ ...current, ...patch }))}
                  onSaveWsl2Config={() => void saveWsl2Config()}
                  onClearWsl2Config={() => void clearWsl2Config()}
                  onCloseWsl2Config={() => setWsl2ConfigOpen(false)}
                  installedSkills={installedSkills}
                  knowledgeBases={knowledgeBases}
                  contextModelTargets={[
                    ...sortedConversationModelGroups.map((group) => ({ id: group.id, label: t('modelGroupOption', { name: group.name || t('unnamedModelGroup') }) })),
                    ...sortedConversationModels.map((model) => ({ id: model.id, label: model.name || t('unnamedModel') })),
                  ]}
                  contextActiveModelConfigId={configDraft.activeModelConfigId}
                  contextReferenceModel={resolveModelTarget(configDraft, configDraft.activeModelConfigId)}
                  contextValue={configDraft.contextManagement}
                  onContextModelConfigChange={(id) => setConfigDraft((current) => ({ ...current, activeModelConfigId: id }))}
                  onContextChange={(patch) => setConfigDraft((current) => ({
                    ...current,
                    contextManagement: { ...current.contextManagement, ...patch },
                  }))}
                />
              )}
              {settingsTab === 'skills' && (
                <SkillsSettingsPanel
                  installedSkills={installedSkills}
                  skillUrl={skillUrl}
                  skillPreview={skillPreview}
                  selectedSkillCandidateIds={selectedSkillCandidateIds}
                  skillBusy={skillBusy}
                  skillError={skillError}
                  interactionLocked={interactionLocked}
                  onUrlChange={(url) => {
                    setSkillUrl(url)
                    setSkillPreview(null)
                    setSelectedSkillCandidateIds([])
                  }}
                  onCandidateSelectionChange={(id, selected) => setSelectedSkillCandidateIds((current) => selected
                    ? [...new Set([...current, id])]
                    : current.filter((candidateId) => candidateId !== id))}
                  onPreview={previewSkillImport}
                  onInstall={installPreviewedSkill}
                  onPrepareUpdate={prepareSkillUpdate}
                  onRemove={removeSkill}
                />
              )}
              {settingsTab === 'knowledgeBases' && (
                <KnowledgeBaseSettingsPanel
                  knowledgeBases={knowledgeBases}
                  knowledgeBaseDirectory={knowledgeBaseDirectory}
                  knowledgeBaseName={knowledgeBaseName}
                  knowledgeBaseMode={knowledgeBaseMode}
                  knowledgeBaseBusy={knowledgeBaseBusy}
                  knowledgeBaseError={knowledgeBaseError}
                  interactionLocked={interactionLocked}
                  onDirectoryChange={setKnowledgeBaseDirectory}
                  onNameChange={setKnowledgeBaseName}
                  onModeChange={setKnowledgeBaseMode}
                  onChooseDirectory={chooseKnowledgeBaseDirectory}
                  onCreate={createLocalKnowledgeBase}
                  onRename={renameKnowledgeBase}
                  onRefresh={refreshLocalKnowledgeBase}
                  onRemove={removeLocalKnowledgeBase}
                  onChangeMode={changeKnowledgeBaseMode}
                />
              )}
              {settingsTab === 'mcp' && (
                <McpSettings
                  servers={configDraft.mcpServers}
                  onChange={(mcpServers) => setConfigDraft((current) => ({ ...current, mcpServers }))}
                  disabled={interactionLocked}
                  projectRoot={activeProject?.folders[0]?.path}
                />
              )}
              {(settingsTab === 'language' || settingsTab === 'power' || settingsTab === 'notifications') && (
                <AppPreferencesPanel
                  selectedTab={settingsTab}
                  configDraft={configDraft}
                  onConfigDraftChange={setConfigDraft}
                />
              )}
              {settingsTab === 'archive' && (
               <section className="settings-group">
                 <p className="settings-description">{t('archivedItemsDescription')}</p>
                 <Button appearance="secondary" onClick={openArchiveList}>
                   {t('openArchivedItems')}
                 </Button>
               </section>
              )}
              {settingsTab === 'developer' && (
                <section className="settings-group">
                  <Switch
                    checked={configDraft.developerMode}
                    label={t('developerMode')}
                    onChange={(_, data) => setConfigDraft((current) => ({
                      ...current,
                      developerMode: data.checked,
                    }))}
                  />
                  <p className="settings-description">{t('developerModeDescription')}</p>
                </section>
              )}
              {settingsTab === 'prompts' && (
                <section className="settings-group prompt-viewer-group">
                  <p className="settings-description">{t('promptsDescription')}</p>
                  {!promptSnapshot && <p className="settings-description">{t('loadingPrompts')}</p>}
                  {promptSnapshot?.entries.map((entry) => (
                    <div className="prompt-entry" key={entry.id}>
                      <h3>{entry.title}</h3>
                      <p className="settings-description">{entry.scene}</p>
                      <pre className="prompt-content">{entry.content}</pre>
                    </div>
                  ))}
                </section>
              )}
              {settingsTab === 'about' && (
                <section className="settings-group">
                  <h2>{t('aboutCodey')}</h2>
                  <p className="settings-description">
                    {appVersion === null ? t('loading') : t('softwareVersion', { version: appVersion || t('notAvailable') })}
                  </p>
                  <h2>{t('checkForUpdates')}</h2>
                  <Button
                    appearance="secondary"
                    disabled={updateCheckBusy}
                    onClick={() => {
                      setUpdateCheckBusy(true)
                      setUpdateCheck(null)
                      setUpdateCheckError('')
                      void window.codey.checkForUpdates()
                        .then(setUpdateCheck)
                        .catch(() => setUpdateCheckError(t('updateCheckFailed')))
                        .finally(() => setUpdateCheckBusy(false))
                    }}
                  >
                    {updateCheckBusy ? t('checkingForUpdates') : t('checkForUpdates')}
                  </Button>
                  {updateCheck?.status === 'ahead' && (
                    <p className="settings-description" role="status">
                      {t('updateAhead', { version: updateCheck.latestVersion })}
                    </p>
                  )}
                  {updateCheck?.status === 'current' && (
                    <p className="settings-description" role="status">
                      {t('updateCurrent', { version: updateCheck.latestVersion })}
                    </p>
                  )}
                  {updateCheck?.status === 'behind' && (
                    <Button
                      appearance="transparent"
                      onClick={() => void window.codey.openLatestReleasePage().catch(() => setUpdateCheckError(t('unableOpenReleasePage')))}
                    >
                      {t('updateBehind', { version: updateCheck.latestVersion })}
                    </Button>
                  )}
                  {updateCheckError && <p className="dialog-error" role="alert">{updateCheckError}</p>}
                </section>
              )}
              {settingsError && <p className="dialog-error">{settingsError}</p>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setSettingsOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={invalidModelConfig || invalidAppContextConfig || invalidGlobalCommandReview || invalidGlobalAgentLimits || invalidGlobalCommandExecution || interactionLocked || saving}
                onClick={() => void saveSettings()}
              >
                {saving ? t('saving') : t('save')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={archiveDialogOpen} onOpenChange={(_, data) => setArchiveDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('archivedItems')}</DialogTitle>
            <DialogContent className="dialog-fields archive-list">
              <section>
                <h2>{t('archivedProjects')}</h2>
                {archivedProjects.length === 0 ? (
                  <p className="settings-description">{t('noArchivedProjects')}</p>
                ) : archivedProjects.map((project) => (
                  <div className="archive-list-item" key={project.id}>
                    <span>{project.name}</span>
                    <Button size="small" onClick={() => void setProjectArchive(project, false)}>
                      {t('unarchive')}
                    </Button>
                  </div>
                ))}
              </section>
              <section>
                <h2>{t('archivedConversations')}</h2>
                {archivedConversations.length === 0 ? (
                  <p className="settings-description">{t('noArchivedConversations')}</p>
                ) : archivedConversations.map(({ project, conversation }) => (
                  <div className="archive-list-item" key={`${project.id}:${conversation.id}`}>
                    <span>
                      <strong>{conversation.title}</strong>
                      <small>{project.name}</small>
                    </span>
                    <Button size="small" onClick={() => void setConversationArchive(project.id, conversation.id, false)}>
                      {t('unarchive')}
                    </Button>
                  </div>
                ))}
              </section>
              {archiveError && <p className="dialog-error">{archiveError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setArchiveDialogOpen(false)}>
                {t('close')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={bridgeDialogOpen} onOpenChange={(_, data) => setBridgeDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('handoverChannelTitle')}</DialogTitle>
            <DialogContent className="dialog-fields">
              <Field label={t('bridgeAddress')} hint={t('bridgeAddressHint')}>
                <Input value={bridgeUrl} onChange={(_, data) => setBridgeUrl(data.value)} disabled={bridgeBusy} placeholder="http://127.0.0.1:8787" />
              </Field>
              <div className="bridge-actions">
                <Button appearance="primary" disabled={bridgeBusy || !bridgeUrl.trim()} onClick={() => void createBridgeChannel()}>
                  {bridgeBusy ? t('creatingHandoverChannel') : t('createHandoverChannel')}
                </Button>
                {bridgeChannels.length > 0 && <Button appearance="secondary" disabled={bridgeBusy} onClick={() => void syncBridgeNow()}>{t('syncAllHandoverChannels')}</Button>}
              </div>
              <p className="status">{t('handoverChannelDescription')}</p>
              {bridgeChannels.length === 0 ? <p className="status">{t('noHandoverChannels')}</p> : bridgeChannels.map((channel) => (
                <section className="bridge-channel" key={channel.channelId}>
                  <div className="bridge-channel-heading">
                    <div>
                      <strong>{t('handoverChannelLabel', { channelId: channel.channelId })}</strong>
                      <small>{t('handoverChannelExpiry', { url: channel.bridgeUrl, time: new Date(channel.enrollmentExpiresAt).toLocaleString() })}</small>
                    </div>
                    <Button size="small" appearance="secondary" disabled={bridgeBusy} onClick={() => void removeBridgeChannel(channel)}>{t('removeHandoverChannel')}</Button>
                  </div>
                  <Field label={t('handoverInvitation')} hint={t('handoverInvitationHint')}>
                    <Textarea className="bridge-invitation" readOnly value={channel.invitation} rows={4} />
                  </Field>
                  <div className="bridge-actions">
                    <Button appearance="secondary" disabled={bridgeBusy} onClick={() => void copyBridgeInvitation(channel)}>{t('copyHandoverInvitation')}</Button>
                    <Button appearance="secondary" disabled={bridgeBusy} onClick={() => void syncBridgeNow(channel.channelId)}>{t('syncHandoverNow')}</Button>
                    <Button appearance="secondary" disabled={bridgeBusy} onClick={() => void refreshBridgeEnrollment(channel.channelId)}>{t('refreshHandoverInvitation')}</Button>
                  </div>
                  <h3>{t('pendingHandoverDevices')}</h3>
                  <p className="status">{t('verifyHandoverFingerprint')}</p>
                  {channel.pendingRequests.length === 0 ? <p className="status">{t('noHandoverRequests')}</p> : channel.pendingRequests.map((request) => (
                    <div className="bridge-request" key={request.id}>
                      <span>{request.deviceName}<small>{t('deviceFingerprintLabel')}<code>{request.fingerprint}</code></small></span>
                      <Button size="small" appearance="primary" disabled={bridgeBusy} onClick={() => void approveBridgeRequest(channel.channelId, request)}>{t('approve')}</Button>
                      <Button size="small" appearance="secondary" disabled={bridgeBusy} onClick={() => void rejectBridgeRequest(channel.channelId, request.id)}>{t('reject')}</Button>
                    </div>
                  ))}
                  <p className="status">{t('approvedHandoverDevices', { count: channel.approvedDevices.length })}</p>
                </section>
              ))}
              {bridgeError && <p className="dialog-error">{bridgeError}</p>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setBridgeDialogOpen(false)}>{t('close')}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <ProjectSettingsDialog
        settings={projectSettings}
        config={config}
        installedSkills={installedSkills}
        knowledgeBases={knowledgeBases}
        flatModelConfigs={flatModelConfigs}
        effectiveModelConfig={effectiveModelConfig}
        interactionLocked={interactionLocked}
        saving={saving}
        settingsError={settingsError}
        openCommandRulesHelp={openCommandRulesHelp}
      />

      <ConversationSettingsDialogs
        settings={conversationSettings}
        config={config}
        installedSkills={installedSkills}
        knowledgeBases={knowledgeBases}
        flatModelConfigs={flatModelConfigs}
        effectiveModelConfig={effectiveModelConfig}
        interactionLocked={interactionLocked}
        saving={saving}
        settingsError={settingsError}
        openCommandRulesHelp={openCommandRulesHelp}
        projects={projects}
        activeProject={activeProject}
        activeConversation={activeConversation}
        skillBusy={skillBusy}
        skillError={skillError}
        knowledgeBaseBusy={knowledgeBaseBusy}
        knowledgeBaseError={knowledgeBaseError}
      />

      {toast && createPortal(
        <div className={`app-toast app-toast-${toast.tone}`} role="status">
          {toast.message}
        </div>,
        document.body,
      )}
    </FluentProvider>
  )
}
