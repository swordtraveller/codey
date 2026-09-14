import {
  modelGroupDefaultRetries,
  type ModelChainMember,
  type ModelConfig,
  type ModelDefinition,
  type ModelGroupConfig,
  type ModelLink,
  type ProviderConfig,
  type RuntimeModelConfig,
} from './types'

export type ModelTargetSource = {
  providers: ProviderConfig[]
  modelDefinitions: ModelDefinition[]
  models: ModelLink[]
  modelGroups: ModelGroupConfig[]
}

/** Flattens a model link into the legacy ModelConfig shape. */
export function flattenModelLink(
  source: ModelTargetSource,
  link: ModelLink,
): ModelConfig | undefined {
  const provider = source.providers.find((entry) => entry.id === link.providerId)
  const definition = source.modelDefinitions.find((entry) => entry.id === link.definitionId)
  if (!provider || !definition) return undefined
  return {
    id: link.id,
    name: link.name || definition.name || definition.modelName,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    modelName: definition.modelName,
    modelMaxContext: definition.modelMaxContext,
    modelMaxOutputTokens: definition.modelMaxOutputTokens,
    supportsImageInput: definition.supportsImageInput,
    supportsPdfInput: definition.supportsPdfInput,
    supportsVideoInput: definition.supportsVideoInput,
    supportsAudioInput: definition.supportsAudioInput,
  }
}

/** Weakest-member envelope: min context, min defined output (undefined =
 *  unconstrained, so it never lowers the envelope), modality intersection.
 *  The envelope is safe for every chain member by construction. */
export function groupEnvelope(definitions: ModelDefinition[]): Pick<ModelDefinition,
  'modelMaxContext' | 'modelMaxOutputTokens' | 'supportsImageInput' | 'supportsPdfInput' | 'supportsVideoInput' | 'supportsAudioInput'
> {
  const contexts = definitions.map((definition) => definition.modelMaxContext)
  const outputs = definitions
    .map((definition) => definition.modelMaxOutputTokens)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return {
    modelMaxContext: Math.min(...contexts),
    modelMaxOutputTokens: outputs.length === definitions.length && outputs.length > 0
      ? Math.min(...outputs)
      : undefined,
    supportsImageInput: definitions.every((definition) => definition.supportsImageInput === true),
    supportsPdfInput: definitions.every((definition) => definition.supportsPdfInput === true),
    supportsVideoInput: definitions.every((definition) => definition.supportsVideoInput === true),
    supportsAudioInput: definitions.every((definition) => definition.supportsAudioInput === true),
  }
}

function chainMember(source: ModelTargetSource, link: ModelLink): ModelChainMember | undefined {
  const provider = source.providers.find((entry) => entry.id === link.providerId)
  const definition = source.modelDefinitions.find((entry) => entry.id === link.definitionId)
  if (!provider || !definition) return undefined
  return {
    modelId: link.id,
    label: link.name || definition.name || definition.modelName,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    modelName: definition.modelName,
  }
}

/** Resolves a target id (model id or model group id) into the flattened
 *  runtime config with its failover chain. Models win id collisions over
 *  groups (ids are uuids, so collisions do not occur in practice). */
export function resolveModelTarget(
  source: ModelTargetSource,
  targetId: string | null | undefined,
): RuntimeModelConfig | undefined {
  if (!targetId) return undefined
  const link = source.models.find((entry) => entry.id === targetId)
  if (link) {
    const flat = flattenModelLink(source, link)
    const member = chainMember(source, link)
    if (!flat || !member) return undefined
    return { ...flat, chain: [member], retriesPerModel: modelGroupDefaultRetries }
  }
  const group = source.modelGroups.find((entry) => entry.id === targetId)
  if (!group) return undefined
  const members: ModelChainMember[] = []
  const definitions: ModelDefinition[] = []
  for (const modelId of group.modelIds) {
    const groupLink = source.models.find((entry) => entry.id === modelId)
    if (!groupLink) continue
    const member = chainMember(source, groupLink)
    const definition = source.modelDefinitions.find((entry) => entry.id === groupLink.definitionId)
    if (!member || !definition) continue
    members.push(member)
    definitions.push(definition)
  }
  if (members.length === 0) return undefined
  const envelope = groupEnvelope(definitions)
  return {
    id: group.id,
    name: group.name,
    baseUrl: members[0]!.baseUrl,
    apiKey: members[0]!.apiKey,
    modelName: members[0]!.modelName,
    modelMaxContext: envelope.modelMaxContext,
    modelMaxOutputTokens: envelope.modelMaxOutputTokens,
    supportsImageInput: envelope.supportsImageInput,
    supportsPdfInput: envelope.supportsPdfInput,
    supportsVideoInput: envelope.supportsVideoInput,
    supportsAudioInput: envelope.supportsAudioInput,
    chain: members,
    retriesPerModel: group.retriesPerModel,
  }
}

/** Three-level inheritance: conversation ?? project ?? global default. */
export function resolveModelTargets(
  appConfig: ModelTargetSource & { activeModelConfigId: string | null },
  project: { defaultModelConfigId?: string | null },
  conversation: { modelConfigId?: string | null },
): RuntimeModelConfig | undefined {
  const targetId = conversation.modelConfigId ?? project.defaultModelConfigId ?? appConfig.activeModelConfigId
  return resolveModelTarget(appConfig, targetId)
}
