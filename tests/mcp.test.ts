import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { McpStdioClient } from '../src/main/mcp/client'
import {
  createMcpToolProvider,
  listMcpToolDefinitions,
  resolveMcpCwd,
  testMcpStdioServer,
} from '../src/main/mcp/tool-provider'
import type { ToolCall } from '../src/main/tools'
import type { McpStdioServerConfig } from '../src/shared/types'

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.mjs')
const temporaryDirectories: string[] = []

function server(overrides: Partial<McpStdioServerConfig> = {}): McpStdioServerConfig {
  return {
    id: 'fake-server',
    name: 'fake server',
    enabled: true,
    command: process.execPath,
    args: [fixturePath],
    env: {},
    cwdMode: 'project-root',
    ...overrides,
  }
}

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    id: 'call-1',
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

function parseToolResult(value: string | undefined): {
  success: boolean
  content?: string
  server?: string
  tool?: string
  retryableWithoutChange?: boolean
  guidance?: string[]
} {
  expect(value).toBeTypeOf('string')
  return JSON.parse(value as string) as {
    success: boolean
    content?: string
    server?: string
    tool?: string
    retryableWithoutChange?: boolean
    guidance?: string[]
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'codey-mcp-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('MCP stdio client', () => {
  it('connects, lists tools, calls tools, captures errors and closes', async () => {
    const client = new McpStdioClient()
    await client.connect(server(), undefined)

    try {
      expect(client.getServerVersion()).toEqual({ name: 'fake-mcp', version: '1.2.3' })
      await expect(client.listTools()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'echo' }),
        expect.objectContaining({ name: 'fail' }),
      ]))
      expect(parseToolResult(await client.callTool('echo', { text: 'hello' }))).toEqual({
        success: true,
        content: 'hello',
      })
      expect(parseToolResult(await client.callTool('fail', {}))).toEqual({
        success: false,
        content: 'expected failure',
      })
      expect(client.stderr).toContain('fake-mcp ready')
    } finally {
      await client.close()
    }
    await expect(client.listTools()).rejects.toThrow('MCP client is not connected')
  })
})

describe('MCP Agent tool provider', () => {
  it('namespaces and routes MCP tools while ignoring non-MCP calls', async () => {
    const provider = await createMcpToolProvider([server()], undefined)
    try {
      const tools = provider.tools as Array<{ function: { name: string } }>
      const echo = tools.find((tool) => tool.function.name === 'mcp__fake_server__echo')
      expect(echo).toBeDefined()
      expect(provider.instructions).toContain('mcp__')
      expect(provider.instructions).toContain('success:false')
      expect(provider.instructions).toContain('failed initialization')
      expect(parseToolResult(await provider.execute(toolCall(echo!.function.name, { text: 'routed' })))).toEqual({
        success: true,
        content: 'routed',
      })
      await expect(provider.execute(toolCall('read_file'))).resolves.toBeUndefined()
    } finally {
      await provider.close?.()
    }
  })

  it('adds generic recovery metadata to failed MCP operations', async () => {
    const provider = await createMcpToolProvider([server()], undefined)
    try {
      const failName = (provider.tools as Array<{ function: { name: string } }>)
        .find((tool) => tool.function.name.endsWith('__fail'))!.function.name
      const result = parseToolResult(await provider.execute(toolCall(failName)))

      expect(result).toMatchObject({
        success: false,
        content: 'expected failure',
        server: 'fake server',
        tool: 'fail',
        retryableWithoutChange: false,
      })
      expect(result.guidance).toContain('Treat this operation as failed; do not report it as a successful verification.')
      expect(result.guidance?.join(' ')).not.toContain('ready_timeout_seconds')
    } finally {
      await provider.close?.()
    }
  })

  it('explains agent-lsp broker timeouts and suppresses unchanged retries', async () => {
    const provider = await createMcpToolProvider([server({ name: 'agent-lsp' })], undefined)
    try {
      const failName = (provider.tools as Array<{ function: { name: string } }>)
        .find((tool) => tool.function.name.endsWith('__fail'))!.function.name
      const message = 'daemon: broker did not start within 30s (override via AGENT_LSP_BROKER_TIMEOUT_MS)'

      const first = parseToolResult(await provider.execute(toolCall(failName, { message })))
      expect(first).toMatchObject({
        success: false,
        content: message,
        retryableWithoutChange: false,
      })
      expect(first.guidance?.join(' ')).toContain('ready_timeout_seconds applies after the broker starts')
      expect(first.guidance?.join(' ')).toContain('v0.12.0')
      expect(first.guidance?.join(' ')).toContain('detect_lsp_servers')
      expect(first.guidance?.join(' ')).toContain('spawn-logs/<language>.log')

      const repeated = parseToolResult(await provider.execute(toolCall(failName, { message })))
      expect(repeated.guidance?.join(' ')).toContain('same tool returned the same failure 2 times')
    } finally {
      await provider.close?.()
    }
  })

  it('blocks dependent agent-lsp operations after an uninitialized-client error', async () => {
    const provider = await createMcpToolProvider([server({ name: 'agent-lsp' })], undefined)
    try {
      const failName = (provider.tools as Array<{ function: { name: string } }>)
        .find((tool) => tool.function.name.endsWith('__fail'))!.function.name
      const result = parseToolResult(await provider.execute(toolCall(failName, {
        message: 'LSP client not initialized; call start_lsp first',
      })))

      expect(result.retryableWithoutChange).toBe(false)
      expect(result.guidance?.join(' ')).toContain('start_lsp must succeed before restart_lsp_server')
      expect(result.guidance?.join(' ')).toContain('Do not retry this dependent operation')
    } finally {
      await provider.close?.()
    }
  })

  it('lists model-visible MCP definitions for the Help catalog', async () => {
    const definitions = await listMcpToolDefinitions([server()], undefined)

    expect(definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'mcp__fake_server__echo',
        serverId: 'fake-server',
        serverName: 'fake server',
        originalName: 'echo',
        description: expect.stringContaining('[MCP: fake server]'),
        parameters: expect.objectContaining({ type: 'object' }),
      }),
    ]))
  })

  it('creates stable unique names for colliding servers and tools', async () => {
    const provider = await createMcpToolProvider([
      server({ id: 'one', name: 'same' }),
      server({ id: 'two', name: 'same' }),
      server({ id: 'three', name: 'same' }),
    ], undefined)
    try {
      const names = (provider.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)
      expect(names).toHaveLength(new Set(names).size)
      expect(names.filter((name) => name.startsWith('mcp__same__echo'))).toHaveLength(3)
      expect(names.every((name) => name.length <= 64)).toBe(true)
    } finally {
      await provider.close?.()
    }
  })

  it('does not start disabled servers', async () => {
    const errors: unknown[] = []
    const provider = await createMcpToolProvider([
      server({ enabled: false, command: 'command-that-does-not-exist' }),
    ], undefined, undefined, (_config, error) => errors.push(error))
    try {
      expect(provider.tools).toEqual([])
      expect(provider.instructions).toBeUndefined()
      expect(errors).toEqual([])
    } finally {
      await provider.close?.()
    }
  })

  it('continues when one enabled server cannot connect', async () => {
    const errors: unknown[] = []
    const provider = await createMcpToolProvider([
      server({ id: 'missing', command: 'command-that-does-not-exist' }),
      server({ id: 'working' }),
    ], undefined, undefined, (_config, error) => errors.push(error))
    try {
      expect(errors).toHaveLength(1)
      expect(provider.tools).toHaveLength(3)
    } finally {
      await provider.close?.()
    }
  })
})

describe('MCP configuration and connection testing', () => {
  it('resolves project and custom working directories', () => {
    expect(resolveMcpCwd(server(), 'D:\\workspace')).toBe('D:\\workspace')
    expect(resolveMcpCwd(server({ cwdMode: 'custom', customCwd: 'D:\\custom' }), 'D:\\workspace')).toBe('D:\\custom')
  })

  it('passes the working directory and environment to the server', async () => {
    const cwd = await temporaryDirectory()
    const provider = await createMcpToolProvider([
      server({ env: { FAKE_ENV: 'visible' }, cwdMode: 'custom', customCwd: cwd }),
    ], 'unused-project-root')
    try {
      const inspectName = (provider.tools as Array<{ function: { name: string } }>)
        .find((tool) => tool.function.name.endsWith('__inspect'))!.function.name
      const result = parseToolResult(await provider.execute(toolCall(inspectName)))
      expect(JSON.parse(result.content ?? '{}')).toMatchObject({ cwd, env: 'visible' })
    } finally {
      await provider.close?.()
    }
  })

  it('reports server identity, tools, and stderr when testing a connection', async () => {
    const result = await testMcpStdioServer(server())
    expect(result).toMatchObject({
      status: 'ok',
      serverName: 'fake-mcp',
      serverVersion: '1.2.3',
      toolNames: ['echo', 'fail', 'inspect'],
    })
    expect(result.stderr).toContain('fake-mcp ready')
  })
})
