import type { Conversation, ListSortPreference, Project, SidebarSortPreferences } from './types'

export function normalizeListSort(value: unknown): ListSortPreference {
  const raw = value && typeof value === 'object' ? value as Partial<ListSortPreference> : {}
  return {
    by: raw.by === 'name' || raw.by === 'created' ? raw.by : 'activity',
    direction: raw.direction === 'asc' || raw.direction === 'desc' ? raw.direction : raw.by === 'name' ? 'asc' : 'desc',
  }
}

export function normalizeSidebarSort(value: unknown): SidebarSortPreferences {
  const raw = value && typeof value === 'object' ? value as Partial<SidebarSortPreferences> : {}
  return { projects: normalizeListSort(raw.projects), conversations: normalizeListSort(raw.conversations) }
}

export function validTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined
}

export function conversationActivityAt(conversation: Conversation): string | undefined {
  return validTimestamp(conversation.lastActivityAt) ?? validTimestamp(conversation.createdAt)
}

export function projectActivityAt(project: Project): string | undefined {
  let latest: string | undefined
  for (const conversation of project.conversations) {
    if (conversation.archived) continue
    const candidate = conversationActivityAt(conversation)
    if (candidate && (!latest || Date.parse(candidate) > Date.parse(latest))) latest = candidate
  }
  return latest ?? validTimestamp(project.createdAt)
}

function sorted<T>(items: readonly T[], preference: ListSortPreference, name: (item: T) => string, timestamp: (item: T) => string | undefined, locale?: string): T[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
  const direction = preference.direction === 'asc' ? 1 : -1
  // Compute each date once; project activity can aggregate many conversations.
  return items.map((item, index) => ({ item, index, time: preference.by === 'name' ? NaN : Date.parse(timestamp(item) ?? '') })).sort((a, b) => {
    if (preference.by === 'name') return direction * collator.compare(name(a.item), name(b.item)) || a.index - b.index
    const left = Number.isFinite(a.time)
    const right = Number.isFinite(b.time)
    // Unknown dates stay at the end, in their existing order, in either direction.
    if (!left || !right) return left ? -1 : right ? 1 : a.index - b.index
    return direction * (a.time - b.time) || a.index - b.index
  }).map(({ item }) => item)
}

export function sortProjects(items: readonly Project[], preference: ListSortPreference, locale?: string): Project[] {
  return sorted(items, preference, item => item.name, item => preference.by === 'created' ? validTimestamp(item.createdAt) : projectActivityAt(item), locale)
}

export function sortConversations(items: readonly Conversation[], preference: ListSortPreference, locale?: string): Conversation[] {
  return sorted(items, preference, item => item.title, item => preference.by === 'created' ? validTimestamp(item.createdAt) : conversationActivityAt(item), locale)
}
