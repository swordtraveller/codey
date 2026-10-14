import type { DagNode } from '../shared/dag'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isTaskRunEvent, type RunEventPayload, type TaskRunEvent } from '../shared/task-run'
import type { TodoItem } from '../shared/todo'
import { isTodoSnapshot } from '../shared/todo'

/** One ordered, append-only journal per conversation. Callers await writes before acknowledging mutations. */
export class TaskRunJournal {
  private events: TaskRunEvent[] = []
  private writeFailure: Error | undefined
  private needsNewline = false
  private queue: Promise<void> = Promise.resolve()
  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<TaskRunJournal> {
    const journal = new TaskRunJournal(path)
    let contents: string
    try { contents = await readFile(path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return journal
      throw error
    }
    const lines = contents.split('\n').filter(Boolean)
    for (const line of lines) {
      let event: unknown
      try { event = JSON.parse(line) }
      catch { throw new Error('Invalid TaskRun journal; refusing to overwrite it') }
      if (!isTaskRunEvent(event) || event.sequence !== journal.events.length + 1) {
        throw new Error('Invalid TaskRun journal; refusing to overwrite it')
      }
      journal.events.push(event)
    }
    journal.needsNewline = contents.length > 0 && !contents.endsWith('\n')
    return journal
  }

  all(): readonly TaskRunEvent[] { return this.events }

  findRunByUserMessage(messageId: string): TaskRunEvent | undefined {
    return [...this.events].reverse().find((event) => event.type === 'run-started' && event.userMessageId === messageId)
  }

  latestTodoItems(taskId: string): TodoItem[] {
    const event = [...this.events].reverse().find((entry) => entry.type === 'todo-snapshot' && entry.taskId === taskId)
    return event?.type === 'todo-snapshot' && isTodoSnapshot(event.snapshot)
      ? structuredClone(event.snapshot.items) : []
  }

  latestDagNodes(taskId: string): DagNode[] {
    const event = [...this.events].reverse().find((entry) => entry.type === 'dag-snapshot' && entry.taskId === taskId)
    return event?.type === 'dag-snapshot' ? structuredClone(event.snapshot.nodes) : []
  }

  async append(runId: string, payload: RunEventPayload): Promise<TaskRunEvent> {
    const write = this.queue.then(async () => {
      if (this.writeFailure) throw this.writeFailure
      const event: TaskRunEvent = {
        ...payload, version: 1, id: randomUUID(), runId,
        sequence: this.events.length + 1, at: new Date().toISOString(),
      }
      try {
        await mkdir(dirname(this.path), { recursive: true })
        await appendFile(this.path, `${this.needsNewline ? '\n' : ''}${JSON.stringify(event)}\n`, 'utf8')
        this.needsNewline = false
      } catch (error) {
        // A failed append may have written a partial record. Never append behind it.
        this.writeFailure = new Error('TaskRun journal write failed; execution stopped to preserve history', { cause: error })
        throw this.writeFailure
      }
      this.events.push(event)
      return event
    })
    this.queue = write.then(() => undefined, () => undefined)
    return write
  }
}
