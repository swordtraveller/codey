import { app } from 'electron'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

type LogLevel = 'DEBUG' | 'WARN' | 'ERROR'
type LogValue = unknown

const debugEnabled = !app.isPackaged || process.env.CODEY_DEBUG === '1'
let logQueue = Promise.resolve()

function formatValue(value: LogValue): string {
  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function writeLog(line: string): void {
  const logPath = join(app.getPath('logs'), 'main.log')
  logQueue = logQueue
    .then(async () => {
      await mkdir(dirname(logPath), { recursive: true })
      await appendFile(logPath, `${line}\n`, 'utf8')
    })
    .catch((error) => {
      console.error('[Codey] Unable to write log', error)
    })
}

function emit(level: LogLevel, label: string, value: LogValue): void {
  const line = `[${new Date().toISOString()}] [${level}] ${label}\n${formatValue(value)}`

  if (level === 'DEBUG') {
    if (!debugEnabled) {
      return
    }
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
})
