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

type McpToolResult = {
  success?: boolean
  content?: string
  [key: string]: unknown
}

const MCP_FAILURE_INSTRUCTIONS = [
  'Treat an MCP result with success:false as a failed operation.',
  'Do not claim that a prerequisite, installation, or capability was verified unless a successful tool result explicitly confirms it.',
  'Do not retry a failed operation by changing unrelated arguments such as path separators.',
  'Follow recovery guidance returned by the tool and do not call operations that depend on a failed initialization.',
].join(' ')

function isAgentLspServer(config: McpStdioServerConfig): boolean {
  const identity = [config.id, config.name, config.command, ...config.args]
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  return identity.includes('agentlsp')
}

function augmentMcpToolResult(
  config: McpStdioServerConfig,
  toolName: string,
  serializedResult: string,
  repeatedFailureCount: number,
): string {
  let result: McpToolResult
  try {
    result = JSON.parse(serializedResult) as McpToolResult
  } catch {
    return serializedResult
  }
  if (result.success !== false) return serializedResult

  const content = typeof result.content === 'string' ? result.content : ''
  const guidance = [
    'Treat this operation as failed; do not report it as a successful verification.',
    'Only infer prerequisites or capabilities that a successful tool result explicitly confirmed.',
  ]
  const retryableWithoutChange = false

  if (/lsp client not initialized; call start_lsp first/i.test(content)) {
    guidance.push(
      'start_lsp must succeed before restart_lsp_server, get_server_capabilities, or other initialized-client operations.',
      'Do not retry this dependent operation until start_lsp succeeds.',
    )
  }

  if (isAgentLspServer(config) && /daemon:\s*broker did not start within\s+\d+(?:\.\d+)?s/i.test(content)) {
    guidance.push(
      'ready_timeout_seconds applies after the broker starts; changing it cannot fix this broker-startup timeout.',
      'Do not retry only by changing path separators or ready_timeout_seconds.',
      'Do not call restart_lsp_server, get_server_capabilities, or other client operations until start_lsp succeeds.',
      'Check the installed agent-lsp version and upgrade if needed; agent-lsp v0.12.0 fixed a known Windows broker-spawn path issue.',
      'Use detect_lsp_servers or a direct binary version check before claiming that the requested language server is installed.',
      'Inspect ~/.cache/agent-lsp/spawn-logs/<language>.log for the broker startup error.',
      'AGENT_LSP_BROKER_TIMEOUT_MS controls this startup wait, but increasing it may only hide a startup failure.',
    )
  }

  if (repeatedFailureCount > 1) {
    guidance.push(
      `The same tool returned the same failure ${repeatedFailureCount} times in this run; stop retrying until configuration or environment changes.`,
    )
  }

  return JSON.stringify({
    ...result,
    server: config.name,
    tool: toolName,
    retryableWithoutChange,
    guidance,
  })
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
  const failureCounts = new Map<string, number>()
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
      ? `Tools prefixed with mcp__ are provided by user-configured local MCP servers. Use them for semantic code intelligence when appropriate. ${MCP_FAILURE_INSTRUCTIONS}`
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
      const result = await route.server.client.callTool(route.originalName, args, callSignal)
      let failureCount = 0
      try {
        const parsed = JSON.parse(result) as McpToolResult
        if (parsed.success === false) {
          const signature = `${route.server.config.id}\0${route.originalName}\0${String(parsed.content ?? '')}`
          failureCount = (failureCounts.get(signature) ?? 0) + 1
          failureCounts.set(signature, failureCount)
        }
      } catch {
        // Preserve unexpected non-JSON MCP output without adding recovery metadata.
      }
      return augmentMcpToolResult(route.server.config, route.originalName, result, failureCount)
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
