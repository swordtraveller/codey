import type { PerformanceAnalytics, PerformanceAnalyticsQuery } from '../shared/analytics'
import { aggregateModelCallEvents } from '../shared/analytics'
import type { TaskRunEvent } from '../shared/task-run'
import { TaskRunJournal } from './task-run-journal'
import { log } from './logger'
import { getProjectsForRenderer, taskRunJournalPath } from './workspace'

/** Read existing TaskRun journals and derive the performance view on demand. */
export async function getPerformanceAnalytics(query?: PerformanceAnalyticsQuery): Promise<PerformanceAnalytics> {
  // Validate the IPC query before accessing any history.
  aggregateModelCallEvents([], query)
  const projects = await getProjectsForRenderer()
  const events: TaskRunEvent[] = []
  let skippedJournals = 0
  for (const project of projects) {
    for (const conversation of project.conversations) {
      const path = taskRunJournalPath(project.id, conversation.id)
      try {
        const journal = await TaskRunJournal.open(path)
        for (const event of journal.all()) {
          if (event.type === 'model-call') events.push(event)
        }
      } catch (error) {
        skippedJournals += 1
        // A damaged conversation journal must not make the aggregate panel unusable.
        log.warn('analytics.task-run-journal.skipped', {
          path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return { ...aggregateModelCallEvents(events, query), skippedJournals }
}
