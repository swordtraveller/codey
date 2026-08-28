import { app } from 'electron'
import { appendFile, copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PerformanceTraceEvent, PerformanceTraceStatus } from '../shared/types'

const maxFileBytes = 10 * 1024 * 1024
const maxRotatedFiles = 3

let enabled = false
let writeQueue: Promise<void> = Promise.resolve()

function tracePath(): string {
  return join(app.getPath('userData'), 'performance-traces.jsonl')
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation, operation)
  writeQueue = result.then(() => undefined, () => undefined)
  return result
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function rotateIfNeeded(incomingBytes: number): Promise<void> {
  const path = tracePath()
  if (await fileSize(path) + incomingBytes <= maxFileBytes) return
  for (let index = maxRotatedFiles - 1; index >= 1; index -= 1) {
    try {
      await unlink(`${path}.${index + 1}`)
    } catch {
      // The destination may not exist yet.
    }
    try {
      await rename(`${path}.${index}`, `${path}.${index + 1}`)
    } catch {
      // Missing rotated files are expected.
    }
  }
  try {
    await unlink(`${path}.1`)
  } catch {
    // The destination may not exist yet.
  }
  try {
    await rename(path, `${path}.1`)
  } catch {
    // The file may have been removed between stat and rotation.
  }
}

function sanitize(event: PerformanceTraceEvent): PerformanceTraceEvent {
  const data = event.data
    ? Object.fromEntries(Object.entries(event.data).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 500) : value]))
    : undefined
  return {
    traceId: event.traceId.slice(0, 100),
    scope: event.scope,
    phase: event.phase.slice(0, 120),
    ...(event.projectId ? { projectId: event.projectId.slice(0, 120) } : {}),
    ...(event.conversationId ? { conversationId: event.conversationId.slice(0, 120) } : {}),
    ...(typeof event.durationMs === 'number' ? { durationMs: Math.max(0, Math.round(event.durationMs * 100) / 100) } : {}),
    ...(data ? { data } : {}),
  }
}

export function setPerformanceTracingEnabled(value: boolean): void {
  enabled = value
}

export function isPerformanceTracingEnabled(): boolean {
  return enabled
}

export function getPerformanceTracePath(): string {
  return tracePath()
}

export async function getPerformanceTraceStatus(): Promise<PerformanceTraceStatus> {
  const path = tracePath()
  return { enabled, path, sizeBytes: await fileSize(path) }
}

export function recordPerformanceTrace(event: PerformanceTraceEvent): void {
  if (!enabled) return
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...sanitize(event) }) + '\n'
  void enqueue(async () => {
    try {
      await mkdir(dirname(tracePath()), { recursive: true })
      await rotateIfNeeded(Buffer.byteLength(line, 'utf8'))
      await appendFile(tracePath(), line, 'utf8')
    } catch (error) {
      console.warn('Unable to write performance trace', error)
    }
  })
}

export async function flushPerformanceTraces(): Promise<void> {
  await writeQueue
}

export async function exportPerformanceTraces(destination: string): Promise<void> {
  await flushPerformanceTraces()
  await copyFile(tracePath(), destination)
}
