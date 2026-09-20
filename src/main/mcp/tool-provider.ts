import { createHash } from 'node:crypto'
import type { McpServerTestResult, McpStdioServerConfig } from '../../shared/types'
import type { AgentToolProvider } from '../agent-tool-provider'
import { McpStdioClient } from './client'

type ConnectedServer = {
  config: McpStdioServerConfig
  client: McpStdioClient
}

export type McpToolDefinition = {
  name: string
  serverId: string
  serverName: string
  originalName: string
  description: string
  parameters: Record<string, unknown>
}

type DiscoveredMcpTools = {
  connected: ConnectedServer[]
  definitions: Array<McpToolDefinition & { server: ConnectedServer }>
}

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
}

function modelToolName(server: McpStdioServerConfig, toolName: string, used: Set<string>): string {
  const base = `mcp__${safePart(server.name || server.id)}__${safePart(toolName)}`
  let candidate = base.slice(0, 64)
  if (!used.has(candidate)) return candidate
  const suffix = createHash('sha256').update(`${server.id}:${toolName}`).digest('hex').slice(0, 8)
  candidate = `${base.slice(0, 55)}_${suffix}`
  let counter = 2
  while (used.has(candidate)) {
    const counterSuffix = `_${counter}`
    candidate = `${base.slice(0, 64 - suffix.length - counterSuffix.length - 1)}_${suffix}${counterSuffix}`
    counter += 1
  }
  return candidate
}

async function discoverMcpTools(
  configs: McpStdioServerConfig[],
  projectRoot: string | undefined,
  signal?: AbortSignal,
  onConnectionError?: (config: McpStdioServerConfig, error: unknown) => void,
): Promise<DiscoveredMcpTools> {
  const connected: ConnectedServer[] = []
  const definitions: DiscoveredMcpTools['definitions'] = []
  const usedNames = new Set<string>()

  for (const config of configs.filter((entry) => entry.enabled)) {
    const client = new McpStdioClient()
    try {
      await client.connect(config, resolveMcpCwd(config, projectRoot), signal)
      const server = { config, client }
      connected.push(server)
      for (const tool of await client.listTools(signal)) {
        const name = modelToolName(config, tool.name, usedNames)
        usedNames.add(name)
        definitions.push({
          name,
          serverId: config.id,
          serverName: config.name,
          originalName: tool.name,
          description: `[MCP: ${config.name}] ${tool.description ?? tool.name}`,
          parameters: tool.inputSchema,
          server,
        })
      }
    } catch (error) {
      await client.close()
      onConnectionError?.(config, error)
    }
  }

  return { connected, definitions }
}

async function closeConnectedServers(connected: ConnectedServer[]): Promise<void> {
  await Promise.allSettled(connected.map(({ client }) => client.close()))
}

export function resolveMcpCwd(config: McpStdioServerConfig, projectRoot?: string): string | undefined {
  if (config.cwdMode === 'custom') return config.customCwd
  return projectRoot
}

export async function createMcpToolProvider(
  configs: McpStdioServerConfig[],
  projectRoot: string | undefined,
  signal?: AbortSignal,
  onConnectionError?: (config: McpStdioServerConfig, error: unknown) => void,
): Promise<AgentToolProvider> {
  const { connected, definitions } = await discoverMcpTools(
    configs,
    projectRoot,
    signal,
    onConnectionError,
  )
  const routes = new Map(definitions.map((definition) => [
    definition.name,
    { server: definition.server, originalName: definition.originalName },
  ]))
  const tools = definitions.map((definition) => ({
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    },
  }))

  return {
    tools,
    instructions: tools.length > 0
      ? 'Tools prefixed with mcp__ are provided by user-configured local MCP servers. Use them for semantic code intelligence when appropriate.'
      : undefined,
    async execute(toolCall, callSignal) {
      const route = routes.get(toolCall.function.name)
      if (!route) return undefined
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>
      } catch {
        throw new Error(`Invalid arguments for MCP tool ${toolCall.function.name}`)
      }
      return route.server.client.callTool(route.originalName, args, callSignal)
    },
    async close() {
      await closeConnectedServers(connected)
    },
  }
}

/** Lists the same model-visible MCP tools used by an Agent run, then closes
 *  the temporary server connections. Used by read-only UI such as Help. */
export async function listMcpToolDefinitions(
  configs: McpStdioServerConfig[],
  projectRoot: string | undefined,
  signal?: AbortSignal,
  onConnectionError?: (config: McpStdioServerConfig, error: unknown) => void,
): Promise<McpToolDefinition[]> {
  const { connected, definitions } = await discoverMcpTools(
    configs,
    projectRoot,
    signal,
    onConnectionError,
  )
  try {
    return definitions.map(({ server: _server, ...definition }) => definition)
  } finally {
    await closeConnectedServers(connected)
  }
}

export async function testMcpStdioServer(
  config: McpStdioServerConfig,
  projectRoot?: string,
  signal?: AbortSignal,
): Promise<McpServerTestResult> {
  const client = new McpStdioClient()
  try {
    await client.connect(config, resolveMcpCwd(config, projectRoot), signal)
    const tools = await client.listTools(signal)
    const version = client.getServerVersion()
    return {
      status: 'ok',
      serverName: version?.name,
      serverVersion: version?.version,
      toolNames: tools.map((tool) => tool.name),
      stderr: client.stderr || undefined,
    }
  } catch (error) {
    return {
      status: 'error',
      toolNames: [],
      stderr: client.stderr || undefined,
      error: error instanceof Error ? error.message : 'Unable to connect to MCP server',
    }
  } finally {
    await client.close()
  }
}


