import { Button, Field, Input, Select } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import { defaultLocalEmbeddingModelId, type KnowledgeBase, type KnowledgeBaseMode } from '../../../shared/types'
import { formatBytes } from '../utils/format-bytes'

export type KnowledgeBaseSettingsPanelProps = {
  knowledgeBases: KnowledgeBase[]
  knowledgeBaseDirectory: string
  knowledgeBaseName: string
  knowledgeBaseMode: KnowledgeBaseMode
  knowledgeBaseBusy: boolean
  knowledgeBaseError: string
  interactionLocked: boolean
  onDirectoryChange: (directory: string) => void
  onNameChange: (name: string) => void
  onModeChange: (mode: KnowledgeBaseMode) => void
  onChooseDirectory: () => void
  onCreate: () => void
  onRename: (knowledgeBase: KnowledgeBase) => void
  onRefresh: (knowledgeBase: KnowledgeBase) => void
  onRemove: (knowledgeBase: KnowledgeBase) => void
  onChangeMode: (knowledgeBase: KnowledgeBase, mode: KnowledgeBaseMode) => void
}

export function KnowledgeBaseSettingsPanel({
  knowledgeBases,
  knowledgeBaseDirectory,
  knowledgeBaseName,
  knowledgeBaseMode,
  knowledgeBaseBusy,
  knowledgeBaseError,
  interactionLocked,
  onDirectoryChange,
  onNameChange,
  onModeChange,
  onChooseDirectory,
  onCreate,
  onRename,
  onRefresh,
  onRemove,
  onChangeMode,
}: KnowledgeBaseSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <section className="settings-group skill-management">
      <h2>{t('knowledgeBaseManagement')}</h2>
      <p className="settings-description">{t('knowledgeBaseManagementDescription')}</p>
      <p className="settings-description">{t('knowledgeBaseSupportedFormats')}</p>
      <p className="settings-description">{t('knowledgeBaseFutureFormats')}</p>
      <Field label={t('knowledgeBaseDirectory')}>
        <div className="skill-import-actions">
          <Input
            value={knowledgeBaseDirectory}
            disabled={knowledgeBaseBusy || interactionLocked}
            placeholder={t('knowledgeBaseDirectoryPlaceholder')}
            onChange={(_, data) => onDirectoryChange(data.value)}
          />
          <Button disabled={knowledgeBaseBusy || interactionLocked} onClick={() => void onChooseDirectory()}>
            {t('chooseDirectory')}
          </Button>
        </div>
      </Field>
      <Field label={t('knowledgeBaseName')} hint={t('knowledgeBaseNameHint')}>
        <Input
          value={knowledgeBaseName}
          disabled={knowledgeBaseBusy || interactionLocked}
          placeholder={t('knowledgeBaseNamePlaceholder')}
          onChange={(_, data) => onNameChange(data.value)}
        />
      </Field>
      <Field label={t('knowledgeBaseMode')}>
        <Select
          value={knowledgeBaseMode}
          disabled={knowledgeBaseBusy || interactionLocked}
          onChange={(_, data) => onModeChange(data.value as KnowledgeBaseMode)}
        >
          <option value="rg">{t('knowledgeBaseModeRg')}</option>
          <option value="rag">{t('knowledgeBaseModeRag')}</option>
        </Select>
      </Field>
      {knowledgeBaseMode === 'rag' && (
        <div className="skill-preview">
          <Field label={t('embeddingProvider')}>
            <Select
              value="local"
              disabled={knowledgeBaseBusy || interactionLocked}
            >
              <option value="local">{t('localEmbeddingProvider')}</option>
            </Select>
          </Field>
          <Field label={t('embeddingModel')}>
            <Select
              value={defaultLocalEmbeddingModelId}
              disabled={knowledgeBaseBusy || interactionLocked}
            >
              <option value={defaultLocalEmbeddingModelId}>{defaultLocalEmbeddingModelId}</option>
            </Select>
          </Field>
          <p className="settings-description">{t('ragModelDownloadNotice')}</p>
        </div>
      )}
      <Button
        appearance="primary"
        disabled={!knowledgeBaseDirectory.trim() || knowledgeBaseBusy || interactionLocked}
        onClick={() => void onCreate()}
      >
        {knowledgeBaseBusy ? t('loading') : t('createKnowledgeBase')}
      </Button>
      <div className="skill-list">
        <h2>{t('knowledgeBases')}</h2>
        {knowledgeBases.length === 0 ? (
          <p className="settings-description">{t('noKnowledgeBases')}</p>
        ) : knowledgeBases.map((knowledgeBase) => (
          <article className="skill-card" key={knowledgeBase.id}>
            <div className="skill-card-header">
              <div>
                <h3>{knowledgeBase.name}</h3>
                <small className={knowledgeBase.status === 'ready' ? 'resource-effective' : 'resource-unavailable'}>
                  {t(`knowledgeBaseStatus_${knowledgeBase.status.replace('-', '_')}`)}
                </small>
              </div>
              <div className="skill-import-actions">
                <Button size="small" disabled={knowledgeBaseBusy || interactionLocked} onClick={() => void onRename(knowledgeBase)}>
                  {t('renameKnowledgeBase')}
                </Button>
                <Button size="small" disabled={knowledgeBaseBusy || interactionLocked} onClick={() => void onRefresh(knowledgeBase)}>
                  {t('refreshKnowledgeBase')}
                </Button>
                <Button size="small" disabled={knowledgeBaseBusy || interactionLocked} onClick={() => void onRemove(knowledgeBase)}>
                  {t('removeKnowledgeBase')}
                </Button>
              </div>
            </div>
            <Field label={t('knowledgeBaseMode')}>
              <Select
                value={knowledgeBase.mode}
                disabled={knowledgeBaseBusy || interactionLocked}
                onChange={(_, data) => void onChangeMode(knowledgeBase, data.value as KnowledgeBaseMode)}
              >
                <option value="rg">{t('knowledgeBaseModeRg')}</option>
                <option value="rag">{t('knowledgeBaseModeRag')}</option>
              </Select>
            </Field>
            {knowledgeBase.mode === 'rag' && (
              <p className="settings-description">
                {t('embeddingProvider')}: {t('localEmbeddingProvider')} · {knowledgeBase.embeddingProvider?.modelId}
              </p>
            )}
            <dl className="skill-metadata">
              <dt>{t('knowledgeBasePath')}</dt><dd>{knowledgeBase.source.path}</dd>
              <dt>{t('knowledgeBaseFiles')}</dt><dd>{knowledgeBase.fileCount}</dd>
              <dt>{t('knowledgeBaseSize')}</dt><dd>{formatBytes(knowledgeBase.totalBytes)}</dd>
              <dt>{t('knowledgeBaseIndexedAt')}</dt><dd>{knowledgeBase.indexedAt ? new Date(knowledgeBase.indexedAt).toLocaleString() : t('notAvailable')}</dd>
            </dl>
            {knowledgeBase.error && <p className="dialog-error">{knowledgeBase.error}</p>}
          </article>
        ))}
      </div>
      {knowledgeBaseError && <p className="dialog-error">{knowledgeBaseError}</p>}
    </section>
  )
}
