import { app } from 'electron'
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

type LogLevel = 'DEBUG' | 'WARN' | 'ERROR'
type LogValue = unknown

const debugEnabled = !app.isPackaged || process.env.CODEY_DEBUG === '1'
const maxLogBytes = 2 * 1024 * 1024
const retainedLogFiles = 3
const maxValueLength = 16 * 1024
let logQueue = Promise.resolve()

function formatValue(value: LogValue): string {
  let formatted: string
  if (typeof value === 'string') {
    formatted = value
  } else {
    try {
      formatted = JSON.stringify(value) ?? String(value)
    } catch {
      formatted = String(value)
    }
  }
  return formatted.length <= maxValueLength
    ? formatted
    : `${formatted.slice(0, maxValueLength)}… [truncated ${formatted.length - maxValueLength} chars]`
}

async function rotateLogs(logPath: string, incomingBytes: number): Promise<void> {
  try {
    const current = await stat(logPath)
    if (current.size + incomingBytes <= maxLogBytes) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  for (let index = retainedLogFiles; index >= 1; index -= 1) {
    const target = `${logPath}.${index}`
    if (index === retainedLogFiles) {
      await unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    } else {
      await rename(`${logPath}.${index}`, `${logPath}.${index + 1}`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  await rename(logPath, `${logPath}.1`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

function writeLog(line: string): void {
  const logPath = join(app.getPath('logs'), 'main.log')
  logQueue = logQueue
    .then(async () => {
      await mkdir(dirname(logPath), { recursive: true })
      const entry = `${line}\n`
      await rotateLogs(logPath, Buffer.byteLength(entry, 'utf8'))
      await appendFile(logPath, entry, 'utf8')
    })
    .catch((error) => {
      console.error('[Codey] Unable to write log', error)
    })
}

function emit(level: LogLevel, label: string, value: LogValue): void {
  const line = `[${new Date().toISOString()}] [${level}] ${label} ${formatValue(value)}`

  if (level === 'DEBUG') {
    if (!debugEnabled) return
    console.debug(line)
  } else if (level === 'WARN') {
    console.warn(line)
  } else {
    console.error(line)
  }

  writeLog(line)
}

export const log = Object.freeze({
  debug: (label: string, value: LogValue): void => emit('DEBUG', label, value),
  warn: (label: string, value: LogValue): void => emit('WARN', label, value),
  error: (label: string, value: LogValue): void => emit('ERROR', label, value),
  flush: (): Promise<void> => logQueue,
})
