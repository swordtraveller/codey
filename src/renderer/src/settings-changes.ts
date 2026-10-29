import type { AppConfig } from '../../shared/types'

// Configuration is JSON data. Object key order and optional undefined fields do
// not constitute edits; array order does (notably model failover order).
export function settingsEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => settingsEqual(value, right[index]))
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return false
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a).filter(key => a[key] !== undefined)
  return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length
    && keys.every(key => Object.hasOwn(b, key) && settingsEqual(a[key], b[key]))
}

export type SettingsChange = {
  section: string
  kind: 'added' | 'modified' | 'removed'
  name?: string
}

const modelSections = {
  providers: 'providersSection',
  modelDefinitions: 'definitionsSection',
  models: 'modelsSection',
  modelGroups: 'groupsSection',
} as const

const otherSections = {
  modelConfigs: 'modelsSection', activeModelConfigId: 'defaultModelTarget',
  contextManagement: 'settingsChangeContext', language: 'language', developerMode: 'developerMode',
  keepAwakeEnabled: 'powerSettings', keepAwakeOnlyWhileWorking: 'powerSettings',
  networkAccessEnabled: 'networkAccess', notificationSettings: 'notifications', sidebarSort: 'sidebarSort',
  performanceTracingEnabled: 'performanceDiagnostics', commandReviewGlobal: 'settingsChangeReview',
  commandExecutionGlobal: 'commandExecution', agentLimitsGlobal: 'agentLimits',
  defaultSkillIds: 'skills', defaultKnowledgeBaseIds: 'knowledgeBases', mcpServers: 'mcp',
} satisfies Record<Exclude<keyof AppConfig, keyof typeof modelSections>, string>

export function getSettingsChanges(saved: AppConfig, draft: AppConfig): SettingsChange[] {
  const changes: SettingsChange[] = []
  for (const key of Object.keys(modelSections) as (keyof typeof modelSections)[]) {
    const before = new Map(saved[key].map(item => [item.id, item]))
    const after = new Map(draft[key].map(item => [item.id, item]))
    for (const [id, item] of after) {
      if (settingsEqual(before.get(id), item)) continue
      // Only explicitly named entities are shown. Never include credentials,
      // URLs, raw configuration values, or server environment variables.
      const name = ('name' in item ? item.name : item.modelName) || undefined
      changes.push({ section: modelSections[key], kind: before.has(id) ? 'modified' : 'added', name })
    }
    for (const [id, item] of before) {
      if (!after.has(id)) changes.push({ section: modelSections[key], kind: 'removed', name: ('name' in item ? item.name : item.modelName) || undefined })
    }
    if (settingsEqual([...before.keys()].sort(), [...after.keys()].sort())
      && !settingsEqual([...before.keys()], [...after.keys()])) {
      changes.push({ section: modelSections[key], kind: 'modified' })
    }
  }
  const sections = new Set<string>()
  for (const key of Object.keys(otherSections) as (keyof typeof otherSections)[]) {
    if (!settingsEqual(saved[key], draft[key])) sections.add(otherSections[key])
  }
  for (const section of sections) changes.push({ section, kind: 'modified' })
  return changes
}
