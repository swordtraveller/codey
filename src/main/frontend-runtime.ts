import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import {
  startPackageScript,
  type PackageManager,
  type RunningNodePackageScript,
} from './node-sandbox'
import { truncateOutput } from './sandbox'

export type FrontendServerStatus = 'starting' | 'running' | 'stopped' | 'failed'

export type FrontendServerSnapshot = {
  serverId: string
  projectId: string
  conversationId: string
  packageRoot: string
  packageManager: PackageManager
  script: string
  status: FrontendServerStatus
  pid: number | null
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  stdout: string
  stderr: string
  previewUrl: string | null
}

type ServerRecord = FrontendServerSnapshot & {
  process: RunningNodePackageScript
  stopRequested: boolean
  previewCandidateUrl: string | null
  previewProbeRunning: boolean
}

const servers = new Map<string, ServerRecord>()
const activeByConversation = new Map<string, string>()
const endedListeners = new Set<(serverId: string) => void>()
const previewUrlPattern = /https?:\/\/[^\s'"`<>]+/gi

function ownerKey(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`
}

function snapshot(record: ServerRecord): FrontendServerSnapshot {
  const {
    process: _process,
    stopRequested: _stopRequested,
    previewCandidateUrl: _previewCandidateUrl,
    previewProbeRunning: _previewProbeRunning,
    ...value
  } = record
  return { ...value, stdout: truncateOutput(value.stdout), stderr: truncateOutput(value.stderr) }
}

function getOwnedServer(
  projectId: string,
  conversationId: string,
  serverId: string,
): ServerRecord {
  const record = servers.get(serverId)
  if (!record || record.projectId !== projectId || record.conversationId !== conversationId) {
    throw new Error('Development server was not found for this conversation')
  }
  return record
}

export function isAllowedPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

export function extractLocalPreviewUrl(output: string): string | null {
  const plainOutput = output.replace(/\u001b\[[0-9;]*m/g, '')
  for (const line of plainOutput.split(/\r?\n/)) {
    if (/waiting for .*server.*start/i.test(line)) continue
    for (const candidate of line.match(previewUrlPattern) ?? []) {
      const cleaned = candidate.replace(/[),.;]+$/, '')
      if (isAllowedPreviewUrl(cleaned)) return new URL(cleaned).toString()
    }
  }
  return null
}

export function onFrontendServerEnded(listener: (serverId: string) => void): () => void {
  endedListeners.add(listener)
  return () => endedListeners.delete(listener)
}

function notifyServerEnded(serverId: string): void {
  for (const listener of endedListeners) listener(serverId)
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (connected: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(connected)
    }
    socket.setTimeout(500, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function isPreviewReachable(value: string): Promise<boolean> {
  const url = new URL(value)
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  const hosts = url.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [url.hostname]
  for (const host of hosts) {
    if (await canConnect(host, port)) return true
  }
  return false
}

async function probePreview(record: ServerRecord): Promise<void> {
  if (record.previewProbeRunning) return
  record.previewProbeRunning = true
  try {
    while (record.status === 'starting' && record.previewCandidateUrl) {
      const candidate = record.previewCandidateUrl
      if (await isPreviewReachable(candidate)) {
        if (record.status === 'starting') {
          record.previewUrl = candidate
          record.status = 'running'
        }
        return
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250))
    }
  } finally {
    record.previewProbeRunning = false
  }
}

function appendOutput(record: ServerRecord, stream: 'stdout' | 'stderr', chunk: string): void {
  record.previewCandidateUrl ??= extractLocalPreviewUrl(chunk)
  if (record[stream].endsWith('[output truncated]')) return
  record[stream] = truncateOutput(`${record[stream]}${chunk}`)
  record.previewCandidateUrl ??= extractLocalPreviewUrl(`${record.stdout}\n${record.stderr}`)
  if (record.previewCandidateUrl) void probePreview(record)
}

export async function startFrontendServer(
  projectId: string,
  conversationId: string,
  packageRoot: string,
  packageManager: PackageManager,
  script: string,
  argv: string[] = [],
): Promise<FrontendServerSnapshot> {
  const key = ownerKey(projectId, conversationId)
  const existingId = activeByConversation.get(key)
  if (existingId) {
    const existing = servers.get(existingId)
    if (existing && (existing.status === 'starting' || existing.status === 'running')) {
      throw new Error('A development server is already running for this conversation')
    }
    activeByConversation.delete(key)
  }

  const startedAt = Date.now()
  const serverId = randomUUID()
  const pendingOutput: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = []
  const process = await startPackageScript(
    packageRoot,
    packageManager,
    script,
    argv,
    (stream, chunk) => {
      const record = servers.get(serverId)
      if (record) appendOutput(record, stream, chunk)
      else pendingOutput.push({ stream, chunk })
    },
  )
  const record: ServerRecord = {
    serverId,
    projectId,
    conversationId,
    packageRoot,
    packageManager,
    script,
    status: 'starting',
    pid: process.pid,
    startedAt,
    endedAt: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    previewUrl: null,
    process,
    stopRequested: false,
    previewCandidateUrl: null,
    previewProbeRunning: false,
  }
  servers.set(serverId, record)
  for (const output of pendingOutput) appendOutput(record, output.stream, output.chunk)
  activeByConversation.set(key, serverId)
  void process.done.then((result) => {
    const current = servers.get(serverId)
    if (!current) return
    current.status = current.stopRequested ? 'stopped' : result.success ? 'stopped' : 'failed'
    current.endedAt = Date.now()
    current.exitCode = result.exit_code
    if (result.stdout) current.stdout = truncateOutput(result.stdout)
    if (result.stderr) current.stderr = truncateOutput(result.stderr)
    if (activeByConversation.get(key) === serverId) activeByConversation.delete(key)
    notifyServerEnded(serverId)
  }).catch((error: unknown) => {
    const current = servers.get(serverId)
    if (!current) return
    current.status = 'failed'
    current.endedAt = Date.now()
    current.exitCode = -1
    current.stderr = truncateOutput(`${current.stderr}\n${error instanceof Error ? error.message : 'Development server failed'}`)
    if (activeByConversation.get(key) === serverId) activeByConversation.delete(key)
    notifyServerEnded(serverId)
  })
  return snapshot(record)
}

export function getFrontendServer(
  projectId: string,
  conversationId: string,
  serverId: string,
): FrontendServerSnapshot {
  return snapshot(getOwnedServer(projectId, conversationId, serverId))
}

export function getFrontendServerLogs(
  projectId: string,
  conversationId: string,
  serverId: string,
): Pick<FrontendServerSnapshot, 'serverId' | 'status' | 'stdout' | 'stderr' | 'previewUrl'> {
  const record = getOwnedServer(projectId, conversationId, serverId)
  return {
    serverId: record.serverId,
    status: record.status,
    stdout: truncateOutput(record.stdout),
    stderr: truncateOutput(record.stderr),
    previewUrl: record.previewUrl,
  }
}

export async function stopFrontendServer(
  projectId: string,
  conversationId: string,
  serverId: string,
): Promise<FrontendServerSnapshot> {
  const record = getOwnedServer(projectId, conversationId, serverId)
  if (record.status === 'starting' || record.status === 'running') {
    record.stopRequested = true
    await record.process.stop()
  }
  return snapshot(record)
}

export async function stopAllFrontendServers(): Promise<void> {
  const activeServers = [...servers.values()].filter((record) => record.status === 'starting' || record.status === 'running')
  activeByConversation.clear()
  await Promise.all(activeServers.map(async (record) => {
    record.stopRequested = true
    await record.process.stop()
  }))
}
