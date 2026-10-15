import type { ResourceSelectionOverride } from '../../shared/types'

export type ResourceSelectionMode = 'inherit' | 'enabled' | 'disabled'

export function resourceSelectionMode(
  selection: ResourceSelectionOverride,
  id: string,
): ResourceSelectionMode {
  if (selection.enabledIds.includes(id)) return 'enabled'
  if (selection.disabledIds.includes(id)) return 'disabled'
  return 'inherit'
}

export function updateResourceSelection(
  selection: ResourceSelectionOverride,
  id: string,
  mode: ResourceSelectionMode,
): ResourceSelectionOverride {
  const enabledIds = selection.enabledIds.filter((entry) => entry !== id)
  const disabledIds = selection.disabledIds.filter((entry) => entry !== id)
  if (mode === 'enabled') enabledIds.push(id)
  if (mode === 'disabled') disabledIds.push(id)
  return { enabledIds, disabledIds }
}

export function resolveEffectiveResourceIds(
  globalIds: string[],
  projectSelection?: ResourceSelectionOverride,
  conversationSelection?: ResourceSelectionOverride,
): string[] {
  const ids = new Set(globalIds)
  for (const id of projectSelection?.enabledIds ?? []) ids.add(id)
  for (const id of projectSelection?.disabledIds ?? []) ids.delete(id)
  for (const id of conversationSelection?.enabledIds ?? []) ids.add(id)
  for (const id of conversationSelection?.disabledIds ?? []) ids.delete(id)
  return [...ids]
}

