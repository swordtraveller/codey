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
  [key: string]: unknown
} {
  expect(value).toBeTypeOf('string')
  return JSON.parse(value as string) as {
    success: boolean
    content?: string
    server?: string
    tool?: string
    retryableWithoutChange?: boolean
    guidance?: string[]
    [key: string]: unknown
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
  it('exposes compact facade tools and routes MCP operations while ignoring non-MCP calls', async () => {
    const provider = await createMcpToolProvider([server()], undefined)
    try {
      const tools = provider.tools as Array<{ function: { name: string } }>
      const echo = tools.find((tool) => tool.function.name === 'mcp_other')
      expect(echo).toBeDefined()
      expect(tools.map((tool) => tool.function.name)).toEqual([
        'mcp_catalog',
        'mcp_workspace',
        'mcp_diagnostics',
        'mcp_symbols',
        'mcp_navigation',
        'mcp_analysis',
        'mcp_edit',
        'mcp_other',
      ])
      expect(tools).toHaveLength(8)
      expect(provider.instructions).toContain('mcp_catalog')
      expect(provider.instructions).toContain('success:false')
      expect(provider.instructions).toContain('failed initialization')
      expect(parseToolResult(await provider.execute(toolCall(echo!.function.name, { server: 'fake-server', operation: 'echo', arguments: { text: 'routed' } })))).toEqual({
        success: true,
        content: 'routed',
      })
      await expect(provider.execute(toolCall('read_file'))).resolves.toBeUndefined()
    } finally {
      await provider.close?.()
    }
  })

  it('discovers downstream operations progressively through the local catalog', async () => {
    const provider = await createMcpToolProvider([server()], undefined)
    try {
      const overview = JSON.parse((await provider.execute(toolCall('mcp_catalog', {
        action: 'list',
      }))) as string) as {
        success: boolean
        total_operations: number
        categories: Record<string, number>
        servers: Array<{ id: string; operation_count: number }>
        operations?: unknown[]
      }
      expect(overview).toMatchObject({
        success: true,
        total_operations: 9,
        categories: { navigation: 1 },
        servers: [expect.objectContaining({ id: 'fake-server', operation_count: 9 })],
      })
      expect(overview.operations).toBeUndefined()

      const listed = parseToolResult(await provider.execute(toolCall('mcp_catalog', {
        action: 'list',
        category: 'navigation',
      }))) as ReturnType<typeof parseToolResult> & { operations: Array<{ operation: string; category: string }> }
      expect(listed.success).toBe(true)
      expect(listed.operations).toEqual([
        expect.objectContaining({ operation: 'find_references', category: 'navigation', facade: 'mcp_navigation' }),
      ])

      const searched = JSON.parse((await provider.execute(toolCall('mcp_catalog', {
        action: 'search',
        query: 'symbol references',
        limit: 2,
      }))) as string) as { success: boolean; total: number; operations: Array<{ operation: string }>; has_more: boolean }
      expect(searched.success).toBe(true)
      expect(searched.operations).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: 'find_references' }),
      ]))
      expect(searched.operations.length).toBeLessThanOrEqual(2)

      const described = parseToolResult(await provider.execute(toolCall('mcp_catalog', {
        action: 'describe',
        server: 'fake-server',
        operation: 'echo',
      }))) as ReturnType<typeof parseToolResult> & { operation: string; parameters: Record<string, unknown> }
      expect(described).toMatchObject({ success: true, operation: 'echo', facade: 'mcp_other' })
      expect(described.parameters).toMatchObject({ type: 'object', required: ['text'] })
    } finally {
      await provider.close?.()
    }
  })

  it('rejects an operation routed through the wrong facade category', async () => {
    const provider = await createMcpToolProvider([server()], undefined)
    try {
      const routed = parseToolResult(await provider.execute(toolCall('mcp_navigation', {
        server: 'fake-server',
        operation: 'find_references',
        arguments: { file_path: 'src/main.ts' },
      })))
      expect(JSON.parse(routed.content ?? '{}')).toEqual({
        name: 'find_references',
        args: { file_path: 'src/main.ts' },
      })

      const result = parseToolResult(await provider.execute(toolCall('mcp_symbols', {
        server: 'fake-server',
        operation: 'find_references',
      })))
      expect(result).toMatchObject({
        success: false,
        error: 'wrong_category',
        content: 'find_references belongs to the navigation MCP category.',
        expected_tool: 'mcp_navigation',
      })
      expect(parseToolResult(await provider.execute(toolCall('mcp_navigation', {
        server: 'unknown',
        operation: 'find_references',
      })))).toMatchObject({ success: false })
      expect(parseToolResult(await provider.execute(toolCall('mcp_navigation', {
        server: 'fake-server',
        operation: 'find_references',
        arguments: [],
      })))).toMatchObject({ success: false, content: 'arguments must be a JSON object' })
    } finally {
      await provider.close?.()
    }
  })

  it('adds generic recovery metadata to failed MCP operations', async () => {
    const provider = await createMcpToolProvider([server()], undefined)
    try {
      const failName = (provider.tools as Array<{ function: { name: string } }>)
        .find((tool) => tool.function.name === 'mcp_other')!.function.name
      const result = parseToolResult(await provider.execute(toolCall(failName, {
        server: 'fake-server',
        operation: 'fail',
      })))

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
        .find((tool) => tool.function.name === 'mcp_other')!.function.name
      const message = 'daemon: broker did not start within 30s (override via AGENT_LSP_BROKER_TIMEOUT_MS)'

      const first = parseToolResult(await provider.execute(toolCall(failName, {
        server: 'fake-server',
        operation: 'fail',
        arguments: { message },
      })))
      expect(first).toMatchObject({
        success: false,
        content: message,
        retryableWithoutChange: false,
      })
      expect(first.guidance?.join(' ')).toContain('ready_timeout_seconds applies after the broker starts')
      expect(first.guidance?.join(' ')).toContain('v0.12.0')
      expect(first.guidance?.join(' ')).toContain('detect_lsp_servers')
      expect(first.guidance?.join(' ')).toContain('spawn-logs/<language>.log')

      const repeated = parseToolResult(await provider.execute(toolCall(failName, {
        server: 'fake-server',
        operation: 'fail',
        arguments: { message },
      })))
      expect(repeated.guidance?.join(' ')).toContain('same tool returned the same failure 2 times')
    } finally {
      await provider.close?.()
    }
  })

  it('blocks dependent agent-lsp operations after an uninitialized-client error', async () => {
    const provider = await createMcpToolProvider([server({ name: 'agent-lsp' })], undefined)
    try {
      const failName = (provider.tools as Array<{ function: { name: string } }>)
        .find((tool) => tool.function.name === 'mcp_other')!.function.name
      const result = parseToolResult(await provider.execute(toolCall(failName, {
        server: 'fake-server',
        operation: 'fail',
        arguments: { message: 'LSP client not initialized; call start_lsp first' },
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

    expect(definitions.map((definition) => definition.name)).toEqual([
      'mcp_catalog',
      'mcp_workspace',
      'mcp_diagnostics',
      'mcp_symbols',
      'mcp_navigation',
      'mcp_analysis',
      'mcp_edit',
      'mcp_other',
    ])
    expect(definitions.find((definition) => definition.name === 'mcp_catalog')?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        serverId: 'fake-server',
        serverName: 'fake server',
        name: 'echo',
        parameters: expect.objectContaining({ type: 'object' }),
      }),
    ]))
    const catalog = definitions.find((definition) => definition.name === 'mcp_catalog')
    const navigation = definitions.find((definition) => definition.name === 'mcp_navigation')
    expect(catalog?.description).not.toContain('find_references')
    expect(navigation?.description).not.toContain('find_references')
    expect((navigation?.parameters.properties as Record<string, { enum?: string[] }>).operation.enum).toBeUndefined()
  })

  it('suggests close operation names and the correct facade', async () => {
    const provider = await createMcpToolProvider([server()], undefined)
    try {
      const result = JSON.parse((await provider.execute(toolCall('mcp_navigation', {
        server: 'fake-server',
        operation: 'find_reference',
      }))) as string) as {
        success: boolean
        error: string
        suggestions: Array<{ operation: string; facade: string }>
      }
      expect(result).toMatchObject({ success: false, error: 'unknown_operation' })
      expect(result.suggestions[0]).toEqual({
        operation: 'find_references',
        category: 'navigation',
        facade: 'mcp_navigation',
      })
    } finally {
      await provider.close?.()
    }
  })

  it('omits empty categories for a generic MCP server', async () => {
    const provider = await createMcpToolProvider([server({ env: { FAKE_TOOLS: 'basic' } })], undefined)
    try {
      expect((provider.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name))
        .toEqual(['mcp_catalog', 'mcp_other'])
    } finally {
      await provider.close?.()
    }
  })

  it('keeps the model-visible catalog bounded when servers and operations collide', async () => {
    const provider = await createMcpToolProvider([
      server({ id: 'one', name: 'same', env: { FAKE_ENV: 'one' } }),
      server({ id: 'two', name: 'same', env: { FAKE_ENV: 'two' } }),
      server({ id: 'three', name: 'same' }),
    ], undefined)
    try {
      const names = (provider.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)
      expect(names).toEqual([
        'mcp_catalog',
        'mcp_workspace',
        'mcp_diagnostics',
        'mcp_symbols',
        'mcp_navigation',
        'mcp_analysis',
        'mcp_edit',
        'mcp_other',
      ])
      expect(names).toHaveLength(new Set(names).size)
      const result = parseToolResult(await provider.execute(toolCall('mcp_other', {
        server: 'two',
        operation: 'inspect',
      })))
      expect(JSON.parse(result.content ?? '{}')).toMatchObject({ env: 'two' })
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
      expect(provider.tools).toHaveLength(8)
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
        .find((tool) => tool.function.name === 'mcp_other')!.function.name
      const result = parseToolResult(await provider.execute(toolCall(inspectName, { server: 'fake-server', operation: 'inspect' })))
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
      toolNames: [
        'echo',
        'fail',
        'inspect',
        'start_lsp',
        'get_diagnostics',
        'list_symbols',
        'find_references',
        'blast_radius',
        'rename_symbol',
      ],
    })
    expect(result.stderr).toContain('fake-mcp ready')
  })
})
