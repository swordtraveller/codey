import { describe, expect, it } from 'vitest'
import { conversationActivityAt, normalizeListSort, normalizeSidebarSort, projectActivityAt, sortConversations, sortProjects } from '../src/shared/list-sorting'
import { inferConversationDates, recordConversationActivity } from '../src/shared/activity-metadata'
import type { Conversation, ListSortPreference, Project } from '../src/shared/types'

const day = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString()
const conversation = (id: string, dates: Partial<Conversation> = {}): Conversation => ({
  id, title: id, archived: false, modelConfigId: null, contextConfigOverride: null,
  agentLimits: null, commandExecution: null, skillSelection: { enabledIds: [], disabledIds: [] },
  knowledgeBaseSelection: { enabledIds: [], disabledIds: [] }, messages: [], agentMessages: [], ...dates,
})
const project = (id: string, dates: Partial<Project> = {}): Project => ({
  id, name: id, archived: false, defaultModelConfigId: null, contextConfigOverride: null,
  commandExecutionDefault: null, agentLimitsDefault: null,
  skillSelection: { enabledIds: [], disabledIds: [] }, knowledgeBaseSelection: { enabledIds: [], disabledIds: [] },
  folders: [], pythonEnvironmentFolderId: null, conversations: [], ...dates,
})
const ids = (items: { id: string }[]) => items.map(item => item.id)
const by = (field: ListSortPreference['by'], direction: ListSortPreference['direction'] = 'desc'): ListSortPreference => ({ by: field, direction })

describe('sidebar sorting', () => {
  it('uses independent activity/newest defaults and normalizes invalid preferences', () => {
    expect(normalizeSidebarSort(undefined)).toEqual({ projects: by('activity'), conversations: by('activity') })
    expect(normalizeSidebarSort({ projects: { by: 'name' }, conversations: { by: 'invalid', direction: 'bad' } }))
      .toEqual({ projects: by('name', 'asc'), conversations: by('activity') })
    expect(normalizeListSort({ by: 'created', direction: 'asc' })).toEqual(by('created', 'asc'))
  })
  it('sorts names naturally in both directions without mutating source order', () => {
    const source = ['Item 10', 'Item 2', 'Item 1'].map(id => conversation(id))
    expect(ids(sortConversations(source, by('name', 'asc'), 'en'))).toEqual(['Item 1', 'Item 2', 'Item 10'])
    expect(ids(sortConversations(source, by('name'), 'en'))).toEqual(['Item 10', 'Item 2', 'Item 1'])
    expect(ids(source)).toEqual(['Item 10', 'Item 2', 'Item 1'])
    expect(sortConversations(source, by('name'))[0]).toBe(source[0])
  })
  it('uses the selected locale and keeps equivalent names stable', () => {
    const source = [conversation('b', { title: '同名' }), conversation('a', { title: '同名' })]
    expect(ids(sortConversations(source, by('name', 'asc'), 'zh-CN'))).toEqual(['b', 'a'])
    expect(ids(sortConversations(source, by('name'), 'zh-CN'))).toEqual(['b', 'a'])
    expect(ids(sortProjects([project('Project 20'), project('Project 3')], by('name', 'asc'), 'en')))
      .toEqual(['Project 3', 'Project 20'])
  })
  it('distinguishes creation from activity and falls back to creation when activity is absent', () => {
    const source = [conversation('old', { createdAt: day(1), lastActivityAt: day(8) }), conversation('new', { createdAt: day(5) })]
    expect(ids(sortConversations(source, by('activity')))).toEqual(['old', 'new'])
    expect(ids(sortConversations(source, by('activity', 'asc')))).toEqual(['new', 'old'])
    expect(ids(sortConversations(source, by('created')))).toEqual(['new', 'old'])
    expect(ids(sortConversations(source, by('created', 'asc')))).toEqual(['old', 'new'])
    expect(conversationActivityAt(conversation('invalid', { createdAt: day(1), lastActivityAt: 'invalid' }))).toBe(day(1))
  })
  it.each(['asc', 'desc'] as const)('puts missing/invalid dates last with stable ties (%s)', direction => {
    const source = [conversation('missing'), conversation('equal-1', { createdAt: day(1) }),
      conversation('invalid', { createdAt: 'bad' }), conversation('equal-2', { createdAt: day(1) }), conversation('unknown', { createdAt: null })]
    expect(ids(sortConversations(source, by('created', direction)))).toEqual(['equal-1', 'equal-2', 'missing', 'invalid', 'unknown'])
  })
  it('uses only non-archived conversations for project activity without changing their stored order', () => {
    const source = project('first', { createdAt: day(1), conversations: [
      conversation('archived', { archived: true, lastActivityAt: day(25) }), conversation('visible', { lastActivityAt: day(5) }),
    ] })
    expect(projectActivityAt(source)).toBe(day(5))
    expect(projectActivityAt(project('empty', { createdAt: day(1) }))).toBe(day(1))
    expect(projectActivityAt(project('unknown'))).toBeUndefined()
    expect(projectActivityAt(project('imported', { createdAt: day(10), conversations: [conversation('older', { lastActivityAt: day(2) })] }))).toBe(day(2))
    expect(ids(sortProjects([source, project('second', { createdAt: day(10) })], by('activity')))).toEqual(['second', 'first'])
    expect(ids(source.conversations)).toEqual(['archived', 'visible'])
  })
})

describe('activity date evidence', () => {
  it('derives legacy dates from message and turn timestamps, not upgrade time', () => {
    expect(inferConversationDates({}, [{ role: 'user', createdAt: day(2) },
      { role: 'assistant', createdAt: day(3), turn: { result: 'normal', startedAt: Date.parse(day(1)), endedAt: Date.parse(day(4)) } }]))
      .toEqual({ createdAt: day(1), lastActivityAt: day(4) })
    expect(inferConversationDates({}, [])).toEqual({ createdAt: null, lastActivityAt: null })
  })
  it('ignores compression, model request diagnostics and non-reply index entries', () => {
    expect(inferConversationDates({}, [
      { role: 'assistant', createdAt: day(20), compression: {} },
      { role: 'assistant', createdAt: day(21), modelRequest: {} },
      { role: 'assistant', replyContent: false, turn: { result: 'normal', startedAt: Date.parse(day(22)) } },
      { role: 'user', createdAt: 'invalid' }, { role: 'user', createdAt: day(1) },
    ])).toEqual({ createdAt: day(1), lastActivityAt: day(1) })
  })
  it('preserves explicit unknown dates and previously stored dates', () => {
    const messages = [{ role: 'user' as const, createdAt: day(10) }]
    expect(inferConversationDates({ createdAt: null, lastActivityAt: null }, messages)).toEqual({ createdAt: null, lastActivityAt: null })
    expect(inferConversationDates({ createdAt: day(1), lastActivityAt: day(5) }, messages)).toEqual({ createdAt: day(1), lastActivityAt: day(5) })
  })
  it('advances activity monotonically without inventing an unknown creation date', () => {
    const item = conversation('legacy', { createdAt: null, lastActivityAt: day(5) })
    recordConversationActivity(item, day(4))
    expect(item.lastActivityAt).toBe(day(5))
    recordConversationActivity(item, day(6))
    expect(item).toMatchObject({ createdAt: null, lastActivityAt: day(6) })
  })
})
