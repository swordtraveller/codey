import { useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { flattenModelLink } from '../../../shared/model-targets'
import {
  defaultModelDefinition,
  defaultModelLink,
  defaultProviderConfig,
  modelGroupDefaultRetries,
  type AppConfig,
  type ModelConfig,
  type ModelDefinition,
  type ModelGroupConfig,
  type ModelLink,
  type ProviderConfig,
} from '../../../shared/types'
import type { ModelComboOption, ModelSettingsPanelProps } from '../components/ModelSettingsPanel'

type UseModelSettingsOptions = {
  config: AppConfig
  configDraft: AppConfig
  setConfigDraft: Dispatch<SetStateAction<AppConfig>>
  showToast: (message: string, tone: 'info' | 'error') => void
}

export function useModelSettings({
  config,
  configDraft,
  setConfigDraft,
  showToast,
}: UseModelSettingsOptions) {
  const { t } = useTranslation()
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [selectedDefinitionId, setSelectedDefinitionId] = useState('')
  const [selectedLinkId, setSelectedLinkId] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [groupMemberProviderFilter, setGroupMemberProviderFilter] = useState('')
  const [groupMemberModelFilter, setGroupMemberModelFilter] = useState('')
  const [selectedGroupMemberIds, setSelectedGroupMemberIds] = useState<string[]>([])
  const [modelCombos, setModelCombos] = useState<ModelComboOption[] | null>(null)
  const [comboBusy, setComboBusy] = useState(false)
  const [capabilitiesBusy, setCapabilitiesBusy] = useState(false)
  const [connectivityBusy, setConnectivityBusy] = useState(false)
  const [connectivityStatus, setConnectivityStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const duplicateProviderNames = new Set(configDraft.providers.map((provider) => provider.name.trim().toLowerCase())).size !== configDraft.providers.length
  const duplicateDefinitionModelNames = new Set(configDraft.modelDefinitions.map((definition) => definition.modelName.trim().toLowerCase())).size !== configDraft.modelDefinitions.length
  const selectedProviderDraft = configDraft.providers.find((provider) => provider.id === selectedProviderId) ?? configDraft.providers[0]
  const selectedDefinitionDraft = configDraft.modelDefinitions.find((definition) => definition.id === selectedDefinitionId) ?? configDraft.modelDefinitions[0]
  const selectedModelLinkDraft = configDraft.models.find((model) => model.id === selectedLinkId) ?? configDraft.models[0]
  const selectedGroupDraft = configDraft.modelGroups.find((group) => group.id === selectedGroupId) ?? configDraft.modelGroups[0]
  const invalidModelConfig = (() => {
    if (configDraft.providers.length === 0 || configDraft.models.length === 0) return true
    if (configDraft.providers.some((provider) => !provider.name.trim() || !provider.baseUrl.trim() || !provider.apiKey.trim())) return true
    if (duplicateProviderNames || duplicateDefinitionModelNames) return true
    if (configDraft.modelDefinitions.some((definition) =>
      !definition.modelName.trim() ||
      definition.modelMaxContext < 1_000 ||
      (definition.modelMaxOutputTokens !== undefined &&
        (!Number.isInteger(definition.modelMaxOutputTokens) || definition.modelMaxOutputTokens < 1)))) return true
    const providerIds = new Set(configDraft.providers.map((provider) => provider.id))
    const definitionIds = new Set(configDraft.modelDefinitions.map((definition) => definition.id))
    const modelIds = new Set(configDraft.models.map((model) => model.id))
    if (configDraft.models.some((model) => !model.name.trim() || !providerIds.has(model.providerId) || !definitionIds.has(model.definitionId))) return true
    if (configDraft.modelGroups.some((group) =>
      !group.name.trim() ||
      group.modelIds.length === 0 ||
      group.modelIds.some((id) => !modelIds.has(id)))) return true
    const active = configDraft.activeModelConfigId
    if (active && !modelIds.has(active) && !configDraft.modelGroups.some((group) => group.id === active)) return true
    return false
  })()
  const flatDraftModelConfigs = configDraft.models
    .map((model) => flattenModelLink(configDraft, model))
    .filter((model): model is ModelConfig => model !== undefined)
  const sortedConfigDraftModelGroups = [...configDraft.modelGroups].sort((a, b) => (a.name || t('unnamedModelGroup')).localeCompare(b.name || t('unnamedModelGroup')))
  const sortedConfigDraftModels = [...configDraft.models].sort((a, b) => (a.name || t('unnamedModel')).localeCompare(b.name || t('unnamedModel')))

  function createSettingsDraft(): AppConfig {
    if (config.providers.length > 0 && config.modelDefinitions.length > 0 && config.models.length > 0) {
      return config
    }
    if (config.providers.length > 0 || config.modelDefinitions.length > 0 || config.models.length > 0) {
      return config
    }
    // Seed one empty provider → definition → model chain on first run.
    const provider = { ...defaultProviderConfig, id: crypto.randomUUID() }
    const definition = { ...defaultModelDefinition, id: crypto.randomUUID() }
    const link: ModelLink = {
      ...defaultModelLink,
      id: crypto.randomUUID(),
      providerId: provider.id,
      definitionId: definition.id,
    }
    return {
      ...config,
      providers: [provider],
      modelDefinitions: [definition],
      models: [link],
      activeModelConfigId: link.id,
    }
  }

  // ---- Model settings: four-layer CRUD (providers / definitions / links / groups) ----

  function updateSelectedProvider(patch: Partial<ProviderConfig>): void {
    const selectedId = selectedProviderDraft?.id
    if (!selectedId) return
    setConfigDraft((current) => ({
      ...current,
      providers: current.providers.map((provider) => provider.id === selectedId ? { ...provider, ...patch } : provider),
    }))
  }

  function addProviderDraft(): void {
    const provider = { ...defaultProviderConfig, id: crypto.randomUUID() }
    setConfigDraft((current) => ({ ...current, providers: [...current.providers, provider] }))
    setSelectedProviderId(provider.id)
  }

  function deleteSelectedProviderDraft(): void {
    const provider = selectedProviderDraft
    if (!provider) return
    if (configDraft.models.some((model) => model.providerId === provider.id)) {
      showToast(t('providerInUse'), 'error')
      return
    }
    if (!window.confirm(t('deleteProviderConfirm', { name: provider.name || provider.baseUrl }))) return
    setConfigDraft((current) => ({
      ...current,
      providers: current.providers.filter((entry) => entry.id !== provider.id),
    }))
  }

  function updateSelectedDefinition(patch: Partial<ModelDefinition>): void {
    const selectedId = selectedDefinitionDraft?.id
    if (!selectedId) return
    setConfigDraft((current) => ({
      ...current,
      modelDefinitions: current.modelDefinitions.map((definition) => definition.id === selectedId ? { ...definition, ...patch } : definition),
    }))
  }

  function addDefinitionDraft(): void {
    const definition = { ...defaultModelDefinition, id: crypto.randomUUID() }
    setConfigDraft((current) => ({ ...current, modelDefinitions: [...current.modelDefinitions, definition] }))
    setSelectedDefinitionId(definition.id)
  }

  function deleteSelectedDefinitionDraft(): void {
    const definition = selectedDefinitionDraft
    if (!definition) return
    if (configDraft.models.some((model) => model.definitionId === definition.id)) {
      showToast(t('definitionInUse'), 'error')
      return
    }
    if (!window.confirm(t('deleteDefinitionConfirm', { name: definition.modelName }))) return
    setConfigDraft((current) => ({
      ...current,
      modelDefinitions: current.modelDefinitions.filter((entry) => entry.id !== definition.id),
    }))
  }

  function updateSelectedLink(patch: Partial<ModelLink>): void {
    const selectedId = selectedModelLinkDraft?.id
    if (!selectedId) return
    setConfigDraft((current) => ({
      ...current,
      models: current.models.map((model) => model.id === selectedId ? { ...model, ...patch } : model),
    }))
  }

  /** Queries every provider's model list and crosses it with the user's
   *  model definitions to offer all available combinations. */
  async function queryModelCombos(): Promise<void> {
    if (comboBusy) return
    setComboBusy(true)
    try {
      const results = await Promise.all(configDraft.providers.map(async (provider) => {
        try {
          const result = await window.codey.listProviderModels({ baseUrl: provider.baseUrl, apiKey: provider.apiKey })
          return { provider, models: result.status === 'ok' ? result.models : [] as string[] }
        } catch {
          return { provider, models: [] as string[] }
        }
      }))
      const existing = new Set(configDraft.models.map((model) => `${model.providerId}:${model.definitionId}`))
      const combos: ModelComboOption[] = []
      for (const definition of configDraft.modelDefinitions) {
        for (const { provider, models } of results) {
          if (!models.some((id) => id.toLowerCase() === definition.modelName.trim().toLowerCase())) continue
          if (existing.has(`${provider.id}:${definition.id}`)) continue
          combos.push({
            key: `${provider.id}:${definition.id}`,
            providerId: provider.id,
            definitionId: definition.id,
            providerName: provider.name || provider.baseUrl,
            modelName: definition.modelName,
            name: `${provider.name || provider.baseUrl}-${definition.modelName}`,
            selected: true,
          })
        }
      }
      setModelCombos(combos)
    } finally {
      setComboBusy(false)
    }
  }

  function toggleModelCombo(key: string, selected: boolean): void {
    setModelCombos((current) => current?.map((combo) => combo.key === key ? { ...combo, selected } : combo) ?? null)
  }

  function renameModelCombo(key: string, name: string): void {
    setModelCombos((current) => current?.map((combo) => combo.key === key ? { ...combo, name } : combo) ?? null)
  }

  function applyModelCombos(): void {
    const combos = modelCombos?.filter((combo) => combo.selected) ?? []
    if (combos.length === 0) {
      setModelCombos(null)
      return
    }
    setConfigDraft((current) => ({
      ...current,
      models: [
        ...current.models,
        ...combos.map((combo) => ({
          id: crypto.randomUUID(),
          name: combo.name.trim() || `${combo.providerName}-${combo.modelName}`,
          providerId: combo.providerId,
          definitionId: combo.definitionId,
        })),
      ],
    }))
    setModelCombos(null)
  }

  function addModelLinkDraft(): void {
    if (configDraft.providers.length === 0 || configDraft.modelDefinitions.length === 0) {
      showToast(t('modelLinkNeedsProviderAndDefinition'), 'error')
      return
    }
    const link: ModelLink = {
      ...defaultModelLink,
      id: crypto.randomUUID(),
      providerId: configDraft.providers[0]!.id,
      definitionId: configDraft.modelDefinitions[0]!.id,
      name: configDraft.modelDefinitions[0]!.modelName,
    }
    setConfigDraft((current) => ({
      ...current,
      models: [...current.models, link],
      activeModelConfigId: current.activeModelConfigId ?? link.id,
    }))
    setSelectedLinkId(link.id)
  }

  function deleteSelectedModelLinkDraft(): void {
    const link = selectedModelLinkDraft
    if (!link) return
    if (!window.confirm(t('deleteModelConfigConfirm', { name: link.name }))) return
    setConfigDraft((current) => ({
      ...current,
      models: current.models.filter((entry) => entry.id !== link.id),
      // Strip the link from every group and drop groups left empty.
      modelGroups: current.modelGroups
        .map((group) => ({ ...group, modelIds: group.modelIds.filter((id) => id !== link.id) }))
        .filter((group) => group.modelIds.length > 0),
      activeModelConfigId: current.activeModelConfigId === link.id
        ? (current.models.find((entry) => entry.id !== link.id)?.id ?? null)
        : current.activeModelConfigId,
    }))
  }

  function updateSelectedGroup(patch: Partial<ModelGroupConfig>): void {
    const selectedId = selectedGroupDraft?.id
    if (!selectedId) return
    setConfigDraft((current) => ({
      ...current,
      modelGroups: current.modelGroups.map((group) => group.id === selectedId ? { ...group, ...patch } : group),
    }))
  }

  function addGroupDraft(): void {
    if (configDraft.models.length === 0) {
      showToast(t('groupNeedsModel'), 'error')
      return
    }
    const group: ModelGroupConfig = {
      id: crypto.randomUUID(),
      name: '',
      modelIds: [configDraft.models[0]!.id],
      retriesPerModel: modelGroupDefaultRetries,
    }
    setConfigDraft((current) => ({ ...current, modelGroups: [...current.modelGroups, group] }))
    setSelectedGroupId(group.id)
  }

  function deleteSelectedGroupDraft(): void {
    const group = selectedGroupDraft
    if (!group) return
    if (!window.confirm(t('deleteGroupConfirm', { name: group.name }))) return
    setConfigDraft((current) => ({
      ...current,
      modelGroups: current.modelGroups.filter((entry) => entry.id !== group.id),
      activeModelConfigId: current.activeModelConfigId === group.id
        ? (current.models[0]?.id ?? null)
        : current.activeModelConfigId,
    }))
  }

  function moveGroupMember(groupId: string, modelId: string, direction: -1 | 1): void {
    setConfigDraft((current) => ({
      ...current,
      modelGroups: current.modelGroups.map((group) => {
        if (group.id !== groupId) return group
        const index = group.modelIds.indexOf(modelId)
        const target = index + direction
        if (index < 0 || target < 0 || target >= group.modelIds.length) return group
        const modelIds = [...group.modelIds]
        modelIds.splice(target, 0, modelIds.splice(index, 1)[0]!)
        return { ...group, modelIds }
      }),
    }))
  }

  function removeGroupMember(groupId: string, modelId: string): void {
    setConfigDraft((current) => ({
      ...current,
      modelGroups: current.modelGroups.map((group) =>
        group.id === groupId ? { ...group, modelIds: group.modelIds.filter((id) => id !== modelId) } : group,
      ),
    }))
  }

  function addSelectedGroupMembers(groupId: string): void {
    if (selectedGroupMemberIds.length === 0) return
    setConfigDraft((current) => ({
      ...current,
      modelGroups: current.modelGroups.map((group) => group.id === groupId
        ? { ...group, modelIds: [...group.modelIds, ...selectedGroupMemberIds.filter((id) => !group.modelIds.includes(id))] }
        : group,
      ),
    }))
    setSelectedGroupMemberIds([])
  }

  async function testSelectedProviderConnectivity(): Promise<void> {
    const provider = selectedProviderDraft
    if (!provider || connectivityBusy || !provider.baseUrl.trim() || !provider.apiKey.trim()) return
    setConnectivityBusy(true)
    setConnectivityStatus(null)
    try {
      const result = await window.codey.testProviderConnectivity({ baseUrl: provider.baseUrl, apiKey: provider.apiKey })
      if (result.status === 'ok') {
        setConnectivityStatus({ tone: 'ok', text: t('connectivityOk', { count: result.models }) })
        return
      }
      if (result.status === 'network-error') {
        setConnectivityStatus({ tone: 'error', text: t('connectivityNetworkError') })
        return
      }
      if (result.status === 'auth-error') {
        setConnectivityStatus({ tone: 'error', text: t('connectivityAuthError') })
        return
      }
      if (result.status === 'endpoint-error') {
        setConnectivityStatus({ tone: 'error', text: t('connectivityEndpointError', { detail: result.detail }) })
        return
      }
      setConnectivityStatus({ tone: 'error', text: t('connectivityNetworkError') })
    } catch {
      setConnectivityStatus({ tone: 'error', text: t('connectivityNetworkError') })
    } finally {
      setConnectivityBusy(false)
    }
  }

  async function testSelectedModelConnectivity(): Promise<void> {
    const link = selectedModelLinkDraft
    const flat = link ? flattenModelLink(configDraft, link) : undefined
    if (!flat || connectivityBusy || !flat.baseUrl.trim() || !flat.modelName.trim()) return
    setConnectivityBusy(true)
    setConnectivityStatus(null)
    try {
      const result = await window.codey.testModelConnectivity(flat)
      if (result.status === 'ok') {
        setConnectivityStatus({ tone: 'ok', text: t('connectivityOk', { count: result.models }) })
        return
      }
      if (result.status === 'network-error') {
        setConnectivityStatus({ tone: 'error', text: t('connectivityNetworkError') })
        return
      }
      if (result.status === 'auth-error') {
        setConnectivityStatus({ tone: 'error', text: t('connectivityAuthError') })
        return
      }
      if (result.status === 'model-not-found') {
        setConnectivityStatus({ tone: 'error', text: t('connectivityModelNotFound', { model: flat.modelName, available: result.available.slice(0, 5).join(', ') }) })
        return
      }
      setConnectivityStatus({ tone: 'error', text: t('connectivityEndpointError', { detail: result.detail }) })
    } catch {
      setConnectivityStatus({ tone: 'error', text: t('connectivityNetworkError') })
    } finally {
      setConnectivityBusy(false)
    }
  }

  async function fetchModelCapabilitiesForSelected(): Promise<void> {
    const modelName = selectedDefinitionDraft?.modelName.trim() ?? ''
    if (!modelName || capabilitiesBusy) {
      return
    }
    setCapabilitiesBusy(true)
    try {
      const result = await window.codey.fetchModelCapabilities(modelName)
      if (result.status === 'ok') {
        updateSelectedDefinition({
          ...(result.maxContextTokens !== undefined ? { modelMaxContext: result.maxContextTokens } : {}),
          ...(result.maxOutputTokens !== undefined ? { modelMaxOutputTokens: result.maxOutputTokens } : {}),
          supportsImageInput: result.image,
          supportsPdfInput: result.pdf,
          supportsVideoInput: result.video,
          supportsAudioInput: result.audio,
        })
        showToast(t('modelCapabilitiesFetched'), 'info')
        return
      }
      if (result.status === 'not-found') {
        showToast(t('modelCapabilitiesNotFound', { model: modelName }), 'error')
        return
      }
      showToast(t('modelCapabilitiesNetworkError'), 'error')
    } catch {
      showToast(t('modelCapabilitiesNetworkError'), 'error')
    } finally {
      setCapabilitiesBusy(false)
    }
  }

  const panelProps: ModelSettingsPanelProps = {
    configDraft,
    settingsDirty: configDraft !== config,
    connectivityBusy,
    connectivityStatus,
    providers: {
      selected: selectedProviderDraft,
      duplicateNames: duplicateProviderNames,
      onSelect: setSelectedProviderId,
      onAdd: addProviderDraft,
      onDelete: deleteSelectedProviderDraft,
      onChange: updateSelectedProvider,
      onTestConnectivity: testSelectedProviderConnectivity,
    },
    definitions: {
      selected: selectedDefinitionDraft,
      duplicateNames: duplicateDefinitionModelNames,
      capabilitiesBusy,
      onSelect: setSelectedDefinitionId,
      onAdd: addDefinitionDraft,
      onDelete: deleteSelectedDefinitionDraft,
      onChange: updateSelectedDefinition,
      onFetchCapabilities: fetchModelCapabilitiesForSelected,
    },
    models: {
      selected: selectedModelLinkDraft,
      combos: modelCombos,
      comboBusy,
      onSelect: setSelectedLinkId,
      onAdd: addModelLinkDraft,
      onDelete: deleteSelectedModelLinkDraft,
      onChange: updateSelectedLink,
      onTestConnectivity: testSelectedModelConnectivity,
      onQueryCombos: queryModelCombos,
      onComboSelectionChange: toggleModelCombo,
      onComboNameChange: renameModelCombo,
      onApplyCombos: applyModelCombos,
      onDismissCombos: () => setModelCombos(null),
    },
    groups: {
      selected: selectedGroupDraft,
      providerFilter: groupMemberProviderFilter,
      modelFilter: groupMemberModelFilter,
      selectedMemberIds: selectedGroupMemberIds,
      onSelect: (id) => {
        setSelectedGroupId(id)
        setSelectedGroupMemberIds([])
      },
      onAdd: addGroupDraft,
      onDelete: deleteSelectedGroupDraft,
      onChange: updateSelectedGroup,
      onProviderFilterChange: setGroupMemberProviderFilter,
      onModelFilterChange: setGroupMemberModelFilter,
      onMemberSelectionChange: (id, selected) => setSelectedGroupMemberIds((current) =>
        selected ? [...current, id] : current.filter((memberId) => memberId !== id)),
      onMoveMember: moveGroupMember,
      onRemoveMember: removeGroupMember,
      onAddSelectedMembers: addSelectedGroupMembers,
    },
  }

  return {
    panelProps,
    createSettingsDraft,
    invalidModelConfig,
    flatDraftModelConfigs,
    sortedConfigDraftModelGroups,
    sortedConfigDraftModels,
  }
}
