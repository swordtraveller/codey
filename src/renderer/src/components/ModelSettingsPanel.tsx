import { Button, Field, Input, Select, Switch } from '@fluentui/react-components'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { flattenModelLink } from '../../../shared/model-targets'
import type {
  AppConfig,
  ModelDefinition,
  ModelGroupConfig,
  ModelLink,
  ProviderConfig,
} from '../../../shared/types'

export type ModelComboOption = {
  key: string
  providerId: string
  definitionId: string
  providerName: string
  modelName: string
  name: string
  selected: boolean
}

type DraftEditor<T> = {
  selected?: T
  onSelect: (id: string) => void
  onAdd: () => void
  onDelete: () => void
  onChange: (patch: Partial<T>) => void
}

export type ModelSettingsPanelProps = {
  configDraft: AppConfig
  settingsDirty: boolean
  connectivityBusy: boolean
  connectivityStatus: { tone: 'ok' | 'error'; text: string } | null
  providers: DraftEditor<ProviderConfig> & {
    duplicateNames: boolean
    onTestConnectivity: () => void
  }
  definitions: DraftEditor<ModelDefinition> & {
    duplicateNames: boolean
    capabilitiesBusy: boolean
    onFetchCapabilities: () => void
  }
  models: DraftEditor<ModelLink> & {
    combos: ModelComboOption[] | null
    comboBusy: boolean
    onTestConnectivity: () => void
    onQueryCombos: () => void
    onComboSelectionChange: (key: string, selected: boolean) => void
    onComboNameChange: (key: string, name: string) => void
    onApplyCombos: () => void
    onDismissCombos: () => void
  }
  groups: DraftEditor<ModelGroupConfig> & {
    providerFilter: string
    modelFilter: string
    selectedMemberIds: string[]
    onProviderFilterChange: (value: string) => void
    onModelFilterChange: (value: string) => void
    onMemberSelectionChange: (id: string, selected: boolean) => void
    onMoveMember: (groupId: string, modelId: string, targetIndex: number) => void
    onRemoveMember: (groupId: string, modelId: string) => void
    onAddSelectedMembers: (groupId: string) => void
  }
}

export function ModelSettingsPanel({
  configDraft,
  settingsDirty,
  connectivityBusy,
  connectivityStatus,
  providers,
  definitions,
  models,
  groups,
}: ModelSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const [draggedMemberId, setDraggedMemberId] = useState<string | null>(null)
  const [dragOverMemberId, setDragOverMemberId] = useState<string | null>(null)
  const selectedGroup = groups.selected
  const sortedProviderOptions = [...configDraft.providers].sort((a, b) => (a.name || a.baseUrl).localeCompare(b.name || b.baseUrl))
  const sortedDefinitionOptions = [...configDraft.modelDefinitions].sort((a, b) => a.modelName.localeCompare(b.modelName))
  const availableGroupMembers = selectedGroup
    ? configDraft.models.filter((model) => {
      if (selectedGroup.modelIds.includes(model.id)) return false
      const provider = configDraft.providers.find((entry) => entry.id === model.providerId)
      const definition = configDraft.modelDefinitions.find((entry) => entry.id === model.definitionId)
      const providerName = (provider?.name || provider?.baseUrl || '').toLowerCase()
      const modelName = (definition?.modelName || model.name || '').toLowerCase()
      return providerName.includes(groups.providerFilter.trim().toLowerCase())
        && modelName.includes(groups.modelFilter.trim().toLowerCase())
    })
    : []

  return (
    <section className="settings-group">
      <p className="model-config-status-line" role="status">
        <span className={`model-config-save-state${settingsDirty ? ' dirty' : ''}`}>
          {settingsDirty ? t('settingsUnsaved') : t('settingsSaved')}
        </span>
        {connectivityStatus && (
          <span className={`connectivity-status ${connectivityStatus.tone}`}> {connectivityStatus.text}</span>
        )}
      </p>

      <h4 className="settings-section-title">{t('providersSection')}</h4>
      <div className="layer-config-toolbar">
        <Select
          aria-label={t('providersSection')}
          value={providers.selected?.id ?? ''}
          onChange={(_, data) => providers.onSelect(data.value)}
        >
          {sortedProviderOptions.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name || provider.baseUrl || t('unnamedProvider')}
            </option>
          ))}
        </Select>
        <Button appearance="secondary" onClick={providers.onAdd}>{t('addProvider')}</Button>
        <Button appearance="secondary" disabled={!providers.selected} onClick={providers.onDelete}>
          {t('deleteProvider')}
        </Button>
        <Button
          appearance="secondary"
          disabled={!providers.selected?.baseUrl.trim() || !providers.selected?.apiKey.trim() || connectivityBusy}
          onClick={() => void providers.onTestConnectivity()}
        >
          {connectivityBusy ? t('testingConnectivity') : t('testConnectivity')}
        </Button>
      </div>
      <Field label={t('providerName')} required>
        <Input
          value={providers.selected?.name ?? ''}
          onChange={(_, data) => providers.onChange({ name: data.value })}
        />
      </Field>
      <Field label={t('baseUrl')} required>
        <Input
          value={providers.selected?.baseUrl ?? ''}
          onChange={(_, data) => providers.onChange({ baseUrl: data.value })}
          placeholder="https://api.example.com/v1"
        />
      </Field>
      <Field label={t('apiKey')} required>
        <Input
          type="password"
          value={providers.selected?.apiKey ?? ''}
          onChange={(_, data) => providers.onChange({ apiKey: data.value })}
        />
      </Field>

      {providers.duplicateNames && <p className="settings-warning" role="alert">{t('duplicateProviderName')}</p>}

      <h4 className="settings-section-title">{t('definitionsSection')}</h4>
      <div className="layer-config-toolbar">
        <Select
          aria-label={t('definitionsSection')}
          value={definitions.selected?.id ?? ''}
          onChange={(_, data) => definitions.onSelect(data.value)}
        >
          {sortedDefinitionOptions.map((definition) => (
            <option key={definition.id} value={definition.id}>
              {definition.modelName || t('unnamedModel')}
            </option>
          ))}
        </Select>
        <Button appearance="secondary" onClick={definitions.onAdd}>{t('addDefinition')}</Button>
        <Button appearance="secondary" disabled={!definitions.selected} onClick={definitions.onDelete}>
          {t('deleteDefinition')}
        </Button>
        <Button
          appearance="secondary"
          disabled={!definitions.selected?.modelName.trim() || definitions.capabilitiesBusy}
          onClick={() => void definitions.onFetchCapabilities()}
        >
          {definitions.capabilitiesBusy ? t('fetchingModelCapabilities') : t('fetchModelCapabilities')}
        </Button>
      </div>
      <Field label={t('modelName')} required>
        <Input
          value={definitions.selected?.modelName ?? ''}
          onChange={(_, data) => definitions.onChange({ modelName: data.value })}
          placeholder="model-name"
        />
      </Field>
      <Field label={t('maximumContextTokens')} required>
        <Input
          min={1000}
          step={1000}
          type="number"
          value={String(definitions.selected?.modelMaxContext ?? '')}
          onChange={(_, data) => definitions.onChange({ modelMaxContext: Number(data.value) })}
        />
      </Field>
      <Field label={t('maximumOutputTokens')} hint={t('maximumOutputTokensHint')}>
        <Input
          min={1}
          step={1000}
          type="number"
          value={definitions.selected?.modelMaxOutputTokens === undefined ? '' : String(definitions.selected.modelMaxOutputTokens)}
          onChange={(_, data) => definitions.onChange({
            modelMaxOutputTokens: data.value === '' || !Number.isFinite(Number(data.value))
              ? undefined
              : Number(data.value),
          })}
        />
      </Field>
      <div className="multimodal-group">
        <p className="section-label">{t('multimodalCapabilities')}</p>
        <div className="multimodal-switches">
          <Switch
            checked={definitions.selected?.supportsImageInput ?? false}
            label={t('modalityImage')}
            onChange={(_, data) => definitions.onChange({ supportsImageInput: data.checked })}
          />
          <Switch
            checked={definitions.selected?.supportsPdfInput ?? false}
            label={t('modalityPdf')}
            onChange={(_, data) => definitions.onChange({ supportsPdfInput: data.checked })}
          />
          <Switch
            checked={definitions.selected?.supportsVideoInput ?? false}
            label={t('modalityVideo')}
            onChange={(_, data) => definitions.onChange({ supportsVideoInput: data.checked })}
          />
          <Switch
            checked={definitions.selected?.supportsAudioInput ?? false}
            label={t('modalityAudio')}
            onChange={(_, data) => definitions.onChange({ supportsAudioInput: data.checked })}
          />
        </div>
      </div>

      {definitions.duplicateNames && <p className="settings-warning" role="alert">{t('duplicateDefinitionModelName')}</p>}

      <h4 className="settings-section-title">{t('modelsSection')}</h4>
      <div className="layer-config-toolbar">
        <Select
          aria-label={t('modelsSection')}
          value={models.selected?.id ?? ''}
          onChange={(_, data) => models.onSelect(data.value)}
        >
          {configDraft.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name || t('unnamedModel')}
            </option>
          ))}
        </Select>
        <Button
          appearance="secondary"
          disabled={models.comboBusy || configDraft.providers.length === 0 || configDraft.modelDefinitions.length === 0}
          onClick={() => void models.onQueryCombos()}
        >
          {models.comboBusy ? t('modelComboBusy') : t('modelComboButton')}
        </Button>
        <Button appearance="secondary" onClick={models.onAdd}>{t('addModelConfig')}</Button>
        <Button appearance="secondary" disabled={!models.selected} onClick={models.onDelete}>
          {t('deleteModelConfig')}
        </Button>
        <Button
          appearance="secondary"
          disabled={!models.selected || !flattenModelLink(configDraft, models.selected)?.modelName.trim() || connectivityBusy}
          onClick={() => void models.onTestConnectivity()}
        >
          {connectivityBusy ? t('testingConnectivity') : t('testConnectivity')}
        </Button>
      </div>
      {models.combos !== null && (
        <div className="model-combo-panel">
          <p className="section-label">{t('modelComboTitle')}</p>
          {models.combos.length === 0 && (
            <p className="settings-description">{t('modelComboEmpty')}</p>
          )}
          {models.combos.map((combo) => (
            <div className="model-combo-row" key={combo.key}>
              <input
                aria-label={t('modelComboSelect')}
                type="checkbox"
                checked={combo.selected}
                onChange={(event) => models.onComboSelectionChange(combo.key, event.target.checked)}
              />
              <span className="model-combo-provider">{combo.providerName}</span>
              <span className="model-combo-model">{combo.modelName}</span>
              <Input
                aria-label={t('modelComboName')}
                value={combo.name}
                onChange={(_, data) => models.onComboNameChange(combo.key, data.value)}
              />
            </div>
          ))}
          <div className="model-combo-actions">
            <Button appearance="secondary" onClick={() => models.onDismissCombos()}>{t('cancel')}</Button>
            <Button
              appearance="primary"
              disabled={models.combos.every((combo) => !combo.selected)}
              onClick={models.onApplyCombos}
            >
              {t('modelComboAdd')}
            </Button>
          </div>
        </div>
      )}
      <Field label={t('modelConfigName')} required>
        <Input
          value={models.selected?.name ?? ''}
          onChange={(_, data) => models.onChange({ name: data.value })}
        />
      </Field>
      <Field label={t('providerLabel')} required>
        <Select
          value={models.selected?.providerId ?? ''}
          onChange={(_, data) => models.onChange({ providerId: data.value })}
        >
          {sortedProviderOptions.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name || provider.baseUrl || t('unnamedProvider')}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('modelDefinitionLabel')} required>
        <Select
          value={models.selected?.definitionId ?? ''}
          onChange={(_, data) => models.onChange({ definitionId: data.value })}
        >
          {sortedDefinitionOptions.map((definition) => (
            <option key={definition.id} value={definition.id}>
              {definition.modelName || t('unnamedModel')}
            </option>
          ))}
        </Select>
      </Field>

      <h4 className="settings-section-title">{t('groupsSection')}</h4>
      <div className="layer-config-toolbar">
        <Select
          aria-label={t('groupsSection')}
          value={selectedGroup?.id ?? ''}
          onChange={(_, data) => groups.onSelect(data.value)}
        >
          {configDraft.modelGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name || t('unnamedModelGroup')}
            </option>
          ))}
        </Select>
        <Button appearance="secondary" onClick={groups.onAdd}>{t('addGroup')}</Button>
        <Button appearance="secondary" disabled={!selectedGroup} onClick={groups.onDelete}>
          {t('deleteGroup')}
        </Button>
      </div>
      {selectedGroup && (
        <>
          <Field label={t('groupName')} required>
            <Input
              value={selectedGroup.name}
              onChange={(_, data) => groups.onChange({ name: data.value })}
            />
          </Field>
          <Field label={t('retriesPerModel')} hint={t('retriesPerModelHint')}>
            <Input
              min={1}
              max={10}
              type="number"
              value={String(selectedGroup.retriesPerModel)}
              onChange={(_, data) => groups.onChange({
                retriesPerModel: Math.min(10, Math.max(1, Math.floor(Number(data.value) || 1))),
              })}
            />
          </Field>
          <p className="section-label">{t('groupMembers')}</p>
          <div className="group-member-list">
            {selectedGroup.modelIds.map((modelId, index) => {
              const member = configDraft.models.find((model) => model.id === modelId)
              return (
                <div
                  className={`group-member-row${draggedMemberId === modelId ? ' dragging' : ''}${dragOverMemberId === modelId ? ' drop-target' : ''}`}
                  key={modelId}
                  onDragOver={(event) => {
                    event.preventDefault()
                    if (draggedMemberId && draggedMemberId !== modelId) setDragOverMemberId(modelId)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    if (draggedMemberId && draggedMemberId !== modelId) {
                      groups.onMoveMember(selectedGroup.id, draggedMemberId, index)
                    }
                    setDraggedMemberId(null)
                    setDragOverMemberId(null)
                  }}
                >
                  <span className="group-member-index">{index + 1}</span>
                  <span className="group-member-name">{member?.name || t('unnamedModel')}</span>
                  <button
                    aria-label={t('reorderGroupMember', { name: member?.name || t('unnamedModel') })}
                    className="group-member-drag-handle"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', modelId)
                      setDraggedMemberId(modelId)
                    }}
                    onDragEnd={() => {
                      setDraggedMemberId(null)
                      setDragOverMemberId(null)
                    }}
                    onKeyDown={(event) => {
                      const targetIndex = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : index
                      if (targetIndex !== index && targetIndex >= 0 && targetIndex < selectedGroup.modelIds.length) {
                        event.preventDefault()
                        groups.onMoveMember(selectedGroup.id, modelId, targetIndex)
                      }
                    }}
                    title={t('reorderGroupMemberHint')}
                    type="button"
                  />
                  <Button appearance="subtle" size="small" onClick={() => groups.onRemoveMember(selectedGroup.id, modelId)}>{t('reviewRuleDelete')}</Button>
                </div>
              )
            })}
          </div>
          <Field label={t('addGroupMember')}>
            <div className="group-member-filters">
              <Input
                aria-label={t('groupMemberProviderFilter')}
                placeholder={t('groupMemberProviderFilter')}
                value={groups.providerFilter}
                onChange={(_, data) => groups.onProviderFilterChange(data.value)}
              />
              <Input
                aria-label={t('groupMemberModelFilter')}
                placeholder={t('groupMemberModelFilter')}
                value={groups.modelFilter}
                onChange={(_, data) => groups.onModelFilterChange(data.value)}
              />
            </div>
            <div className="group-member-picker" role="listbox" aria-label={t('addGroupMember')}>
              {availableGroupMembers.length === 0 && (
                <p className="settings-description">{t('groupMemberNoMatches')}</p>
              )}
              {availableGroupMembers.map((model) => {
                const provider = configDraft.providers.find((entry) => entry.id === model.providerId)
                const definition = configDraft.modelDefinitions.find((entry) => entry.id === model.definitionId)
                const checked = groups.selectedMemberIds.includes(model.id)
                return (
                  <label className="group-member-option" key={model.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => groups.onMemberSelectionChange(model.id, !checked)}
                    />
                    <span>{provider?.name || provider?.baseUrl || t('unnamedProvider')}</span>
                    <span>{definition?.modelName || model.name || t('unnamedModel')}</span>
                  </label>
                )
              })}
            </div>
            <Button
              appearance="secondary"
              disabled={groups.selectedMemberIds.length === 0}
              onClick={() => groups.onAddSelectedMembers(selectedGroup.id)}
            >
              {t('addSelectedGroupMembers')}
            </Button>
          </Field>
          <p className="settings-description">{t('groupEnvelopeNote')}</p>
        </>
      )}
    </section>
  )
}
