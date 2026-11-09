import { isContextConfigValidForModel } from './context-validation'
import { resolveModelTarget, resolveModelTargets } from './model-targets'
import type { AppConfig, CommandReviewConfig, ContextManagementConfig, Project } from './types'

export type ModelDeletionTarget = { kind: 'model' | 'group' | 'provider' | 'definition'; id: string }
export type ModelReferenceReplacements = Record<string, string | null>

export type InvalidModelReference = {
  key: string
  kind: 'default' | 'model' | 'audit'
  id: string
  projectName?: string
  conversationTitle?: string
}

export function modelReferenceKey(kind: 'default' | 'model' | 'audit', projectId?: string, conversationId?: string): string {
  return `ref:${JSON.stringify([kind, projectId ?? null, conversationId ?? null])}`
}

/** Includes archived configurations; null selections are intentional and need no repair. */
export function invalidModelReferences(config: AppConfig, projects: Project[]): InvalidModelReference[] {
  const refs: InvalidModelReference[] = []
  const add = (kind: InvalidModelReference['kind'], id: string | null | undefined, project?: Project, conversation?: Project['conversations'][number]) => {
    if (id && !resolveModelTarget(config, id)) refs.push({
      key: modelReferenceKey(kind, project?.id, conversation?.id), kind, id,
      projectName: project?.name, conversationTitle: conversation?.title,
    })
  }
  add('default', config.activeModelConfigId)
  add('audit', config.commandReviewGlobal.reviewers.auditModelConfigId)
  for (const project of projects) {
    add('model', project.defaultModelConfigId, project)
    add('audit', project.commandExecutionDefault?.review?.reviewers.auditModelConfigId, project)
    for (const conversation of project.conversations) {
      add('model', conversation.modelConfigId, project, conversation)
      add('audit', conversation.commandExecution?.review?.reviewers.auditModelConfigId, project, conversation)
    }
  }
  return refs
}

export function deleteModelEntities(config: AppConfig, target: ModelDeletionTarget): AppConfig {
  const models = config.models.filter(model => !(
    (target.kind === 'model' && model.id === target.id) ||
    (target.kind === 'provider' && model.providerId === target.id) ||
    (target.kind === 'definition' && model.definitionId === target.id)
  ))
  const ids = new Set(models.map(model => model.id))
  return {
    ...config,
    providers: config.providers.filter(provider => target.kind !== 'provider' || provider.id !== target.id),
    modelDefinitions: config.modelDefinitions.filter(definition => target.kind !== 'definition' || definition.id !== target.id),
    models,
    modelGroups: config.modelGroups
      .filter(group => target.kind !== 'group' || group.id !== target.id)
      .map(group => ({ ...group, modelIds: group.modelIds.filter(id => ids.has(id)) }))
      .filter(group => group.modelIds.length > 0),
  }
}

export function modelDeletionImpact(before: AppConfig, after: AppConfig, projects: Project[]) {
  const removedModels = before.models.filter(model => !after.models.some(next => next.id === model.id))
  const removedGroups = before.modelGroups.filter(group => !after.modelGroups.some(next => next.id === group.id))
  const removedIds = new Set([...removedModels, ...removedGroups].map(item => item.id))
  const has = (id: string | null | undefined): boolean => Boolean(id && removedIds.has(id))
  const auditAffected = (review: CommandReviewConfig | null | undefined): boolean =>
    Boolean(review?.reviewers.auditModel && has(review.reviewers.auditModelConfigId))
  return {
    removedModels, removedGroups, removedIds: [...removedIds],
    changedGroups: after.modelGroups.filter(group => before.modelGroups.some(old => old.id === group.id && old.modelIds.length !== group.modelIds.length)),
    globalDefault: has(before.activeModelConfigId),
    globalAudit: auditAffected(before.commandReviewGlobal),
    projects: projects.filter(project => has(project.defaultModelConfigId)),
    conversations: projects.flatMap(project => project.conversations.filter(conversation => has(conversation.modelConfigId)).map(conversation => ({ project, conversation }))),
    projectAudits: projects.filter(project => auditAffected(project.commandExecutionDefault?.review)),
    conversationAudits: projects.flatMap(project => project.conversations.filter(conversation => auditAffected(conversation.commandExecution?.review)).map(conversation => ({ project, conversation }))),
  }
}

/** Compose repeated deletions (A -> B, then B -> C) without leaving dangling replacements. */
export function extendModelReplacements(previous: ModelReferenceReplacements, ids: string[], replacement: string | null): ModelReferenceReplacements {
  const removed = new Set(ids)
  return {
    ...Object.fromEntries(Object.entries(previous).map(([id, value]) => [id, value !== null && removed.has(value) ? replacement : value])),
    ...Object.fromEntries(ids.map(id => [id, replacement])),
  }
}

/** Pure, shared by draft previews and authoritative main-process persistence. Never touches history. */
export function reconcileModelReferences(config: AppConfig, projects: Project[], replacements: ModelReferenceReplacements = {}, strict = true, previousConfig?: AppConfig) {
  const valid = (id: string | null | undefined): boolean => Boolean(id && resolveModelTarget(config, id))
  const replacementFor = (id: string | null | undefined, key: string, inherit = false): string | null => {
    if (!id) return null
    if (valid(id)) return id
    const hasScoped = Object.hasOwn(replacements, key)
    // Project/conversation choices inherit by default; only explicit scoped choices replace them.
    const hasReplacement = hasScoped || (!inherit && Boolean(id && Object.hasOwn(replacements, id)))
    if (hasReplacement) {
      const replacement = hasScoped ? replacements[key] : replacements[id!]
      if (replacement === null || valid(replacement)) return replacement
      if (strict) throw new Error(`MODEL_REPLACEMENT_REQUIRED: ${key}`)
    }
    if (!strict) return id
    if (inherit) return null
    throw new Error(`MODEL_REPLACEMENT_REQUIRED: ${key}`)
  }
  const repairReview = (review: CommandReviewConfig | null | undefined, key: string): typeof review => {
    if (!review) return review
    const id = review.reviewers.auditModelConfigId
    const nextId = !review.reviewers.auditModel && id && !valid(id) && !Object.hasOwn(replacements, key)
      ? null : replacementFor(id, key)
    return nextId === id ? review : { ...review, reviewers: { ...review.reviewers, auditModelConfigId: nextId } }
  }
  const nextConfig: AppConfig = {
    ...config,
    activeModelConfigId: replacementFor(config.activeModelConfigId, modelReferenceKey('default')),
    commandReviewGlobal: repairReview(config.commandReviewGlobal, modelReferenceKey('audit'))!,
  }
  const repairContext = (context: ContextManagementConfig | null | undefined, max: number | undefined) =>
    context && max && !isContextConfigValidForModel(context, max) ? { ...context, maxInputTokens: 0 } : context
  const targetChanged = (before: ReturnType<typeof resolveModelTarget>, after: ReturnType<typeof resolveModelTarget>): boolean =>
    before?.id !== after?.id || before?.modelMaxContext !== after?.modelMaxContext
  const globalChanged = previousConfig && targetChanged(resolveModelTarget(previousConfig, previousConfig.activeModelConfigId), resolveModelTarget(nextConfig, nextConfig.activeModelConfigId))
  if (globalChanged) {
    const model = resolveModelTarget(nextConfig, nextConfig.activeModelConfigId)
    nextConfig.contextManagement = repairContext(config.contextManagement, model?.modelMaxContext)!
  }
  const nextProjects = projects.map(project => {
    const nextProject: Project = {
      ...project,
      defaultModelConfigId: replacementFor(project.defaultModelConfigId, modelReferenceKey('model', project.id), true),
      commandExecutionDefault: project.commandExecutionDefault
        ? { ...project.commandExecutionDefault, review: repairReview(project.commandExecutionDefault.review, modelReferenceKey('audit', project.id)) ?? null }
        : project.commandExecutionDefault,
    }
    const projectModel = resolveModelTargets(nextConfig, nextProject, {})
    if (project.defaultModelConfigId !== nextProject.defaultModelConfigId || (previousConfig && targetChanged(resolveModelTargets(previousConfig, project, {}), projectModel))) {
      nextProject.contextConfigOverride = repairContext(project.contextConfigOverride, projectModel?.modelMaxContext) ?? null
    }
    nextProject.conversations = project.conversations.map(conversation => {
      const next = {
        ...conversation,
        modelConfigId: replacementFor(conversation.modelConfigId, modelReferenceKey('model', project.id, conversation.id), true),
        lastUsedModelId: config.models.some(model => model.id === conversation.lastUsedModelId) ? conversation.lastUsedModelId : undefined,
        perModelContextConfigs: conversation.perModelContextConfigs
          ? Object.fromEntries(Object.entries(conversation.perModelContextConfigs).filter(([id]) => valid(id)))
          : undefined,
        commandExecution: conversation.commandExecution
          ? { ...conversation.commandExecution, review: repairReview(conversation.commandExecution.review, modelReferenceKey('audit', project.id, conversation.id)) ?? null }
          : conversation.commandExecution,
      }
      const model = resolveModelTargets(nextConfig, nextProject, next)
      if (next.modelConfigId !== conversation.modelConfigId || (previousConfig && targetChanged(resolveModelTargets(previousConfig, project, conversation), model))) {
        next.contextConfigOverride = repairContext(conversation.contextConfigOverride, model?.modelMaxContext) ?? null
      }
      return next
    })
    return nextProject
  })
  return { config: nextConfig, projects: nextProjects }
}
