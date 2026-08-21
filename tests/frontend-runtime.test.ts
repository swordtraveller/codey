import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractLocalPreviewUrl,
  getFrontendServer,
  getFrontendServerLogs,
  isAllowedPreviewUrl,
  startFrontendServer,
  stopAllFrontendServers,
  stopFrontendServer,
} from '../src/main/frontend-runtime'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

const temporaryDirectories: string[] = []
const startedServers: Array<{ projectId: string; conversationId: string; serverId: string }> = []

afterEach(async () => {
  await stopAllFrontendServers()
  await Promise.all(startedServers.splice(0).map(async ({ projectId, conversationId, serverId }) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (getFrontendServer(projectId, conversationId, serverId).status === 'stopped' || getFrontendServer(projectId, conversationId, serverId).status === 'failed') return
      } catch {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }))
  await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await createTemporaryDirectory('codey-frontend-runtime-')
  temporaryDirectories.push(directory)
  return directory
}

async function waitForOutput(projectId: string, conversationId: string, serverId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getFrontendServerLogs(projectId, conversationId, serverId).stdout.includes('dev server ready')) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for development server output')
}

async function waitForRunning(projectId: string, conversationId: string, serverId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getFrontendServer(projectId, conversationId, serverId).status === 'running') return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for development server readiness')
}

describe('Frontend development server runtime', () => {
  it('starts, reports output, and stops an explicitly defined package script', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs' } }), 'utf8')
    await writeFile(
      join(root, 'server.cjs'),
      "require('node:http').createServer((_request, response) => response.end('ok')).listen(4173, '127.0.0.1', () => console.log('dev server ready at http://localhost:4173/'))\n",
      'utf8',
    )

    const server = await startFrontendServer('project', 'conversation', root, 'pnpm', 'dev')
    startedServers.push({ projectId: 'project', conversationId: 'conversation', serverId: server.serverId })

    expect(server.status).toBe('starting')
    expect(server.pid).toEqual(expect.any(Number))
    await waitForOutput('project', 'conversation', server.serverId)
    await waitForRunning('project', 'conversation', server.serverId)
    expect(getFrontendServerLogs('project', 'conversation', server.serverId)).toMatchObject({
      previewUrl: 'http://localhost:4173/',
      stdout: expect.stringContaining('dev server ready'),
    })

    await stopFrontendServer('project', 'conversation', server.serverId)
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (getFrontendServer('project', 'conversation', server.serverId).status === 'stopped') return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('Timed out waiting for development server to stop')
  })

  it('rejects undefined scripts and cross-conversation access', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs' } }), 'utf8')
    await writeFile(join(root, 'server.cjs'), "setInterval(() => {}, 1000)\n", 'utf8')

    await expect(startFrontendServer('project', 'conversation', root, 'pnpm', 'missing')).rejects.toThrow(
      "Script 'missing' is not defined in package.json",
    )

    const server = await startFrontendServer('project', 'conversation-2', root, 'pnpm', 'dev')
    startedServers.push({ projectId: 'project', conversationId: 'conversation-2', serverId: server.serverId })
    expect(() => getFrontendServer('project', 'other-conversation', server.serverId)).toThrow(
      'Development server was not found for this conversation',
    )
    await expect(startFrontendServer('project', 'conversation-2', root, 'pnpm', 'dev')).rejects.toThrow(
      'A development server is already running for this conversation',
    )
    await stopFrontendServer('project', 'conversation-2', server.serverId)
  })

  it('extracts only local HTTP preview URLs', () => {
    expect(extractLocalPreviewUrl('\u001b[32mLocal: http://localhost:5173/app\u001b[0m')).toBe(
      'http://localhost:5173/app',
    )
    expect(extractLocalPreviewUrl('Network: http://192.168.1.20:5173')).toBeNull()
    expect(extractLocalPreviewUrl('Fake: http://localhost.example.com:5173')).toBeNull()
    expect(extractLocalPreviewUrl('Waiting for your frontend dev server to start on http://localhost:1420/')).toBeNull()
    expect(isAllowedPreviewUrl('https://127.0.0.1:8443/')).toBe(true)
    expect(isAllowedPreviewUrl('https://example.com')).toBe(false)
  })

  it('does not mark a server ready from an unavailable URL in its output', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs' } }), 'utf8')
    await writeFile(join(root, 'server.cjs'), "console.log('Waiting for http://localhost:4174/')\nsetInterval(() => {}, 1000)\n", 'utf8')

    const server = await startFrontendServer('project', 'conversation-waiting', root, 'pnpm', 'dev')
    startedServers.push({ projectId: 'project', conversationId: 'conversation-waiting', serverId: server.serverId })
    await new Promise((resolve) => setTimeout(resolve, 750))

    expect(getFrontendServer('project', 'conversation-waiting', server.serverId)).toMatchObject({
      status: 'starting',
      previewUrl: null,
    })
    await stopFrontendServer('project', 'conversation-waiting', server.serverId)
  })

})
