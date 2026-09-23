import type { McpServerTestResult, McpStdioServerConfig } from '../../shared/types'
import type { AgentToolProvider } from '../agent-tool-provider'
import { McpStdioClient } from './client'

type ConnectedServer = {
  config: McpStdioServerConfig
  client: McpStdioClient
}

type McpOperation = {
  server: ConnectedServer
  serverId: string
  serverName: string
  originalName: string
  description: string
  parameters: Record<string, unknown>
  category: McpFacadeCategory
}

export type McpFacadeCategory =
  | 'workspace'
  | 'diagnostics'
  | 'symbols'
  | 'navigation'
  | 'analysis'
  | 'edit'
  | 'other'

export type McpToolDefinition = {
  name: string
  category: McpFacadeCategory | 'catalog'
  description: string
  parameters: Record<string, unknown>
  operations: Array<{
    serverId: string
    serverName: string
    name: string
    description: string
    parameters: Record<string, unknown>
  }>
}

type DiscoveredMcpTools = {
  connected: ConnectedServer[]
  operations: McpOperation[]
}

type McpToolResult = {
  success?: boolean
  content?: string
  [key: string]: unknown
}

const MCP_BASE_INSTRUCTIONS = [
  'Only the mcp_* facade names are top-level model tools; operation names returned by mcp_catalog are downstream MCP operations, not additional tool calls.',
  'Use mcp_catalog list for a compact capability overview, search or a category-filtered list to discover a few relevant operations, and describe to retrieve one operation input schema before calling its category facade with server, operation, and arguments.',
  'Treat an MCP result with success:false as a failed operation.',
  'Do not claim that a prerequisite, installation, or capability was verified unless a successful tool result explicitly confirms it.',
  'Do not retry a failed operation by changing unrelated arguments such as path separators.',
  'Follow recovery guidance returned by the tool and do not call operations that depend on a failed initialization.',
]

const AGENT_LSP_INSTRUCTIONS = [
  'For code symbols, definitions, references, diagnostics, call relationships, impact analysis, or semantic edits, prefer the agent-lsp MCP operations over text-only inspection when available.',
  'Typical workflows are: mcp_workspace with operation=start_lsp before initialized-client operations; mcp_diagnostics/get_diagnostics for type errors; mcp_symbols/list_symbols plus mcp_navigation/find_references for code understanding; mcp_analysis/blast_radius before edit operations; and mcp_diagnostics/get_diagnostics after edits.',
]

const FACADE_CATEGORIES: McpFacadeCategory[] = [
  'workspace', 'diagnostics', 'symbols', 'navigation', 'analysis', 'edit', 'other',
]

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

function classifyOperation(name: string): McpFacadeCategory {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const padded = `_${normalized}_`
  const matches = (patterns: string[]) => patterns.some((pattern) => padded.includes(`_${pattern}_`))
  if (matches(['rename', 'format', 'apply_edit', 'execute_command', 'replace', 'insert', 'delete', 'edit_session', 'simulation', 'simulate'])) return 'edit'
  if (matches(['reference', 'references', 'definition', 'definitions', 'declaration', 'declarations', 'implementation', 'implementations', 'caller', 'callers', 'call_hierarchy', 'type_hierarchy', 'document_highlight', 'document_highlights', 'go_to_symbol'])) return 'navigation'
  if (matches(['diagnostic', 'diagnostics', 'completion', 'completions', 'signature_help', 'code_action', 'code_actions', 'inlay', 'inlay_hint', 'inlay_hints', 'semantic_token', 'semantic_tokens', 'editing_context'])) return 'diagnostics'
  if (matches(['symbol', 'symbols', 'hover', 'documentation', 'document_symbol', 'document_symbols'])) return 'symbols'
  if (matches(['blast_radius', 'explore', 'detect_change', 'detect_changes', 'build', 'test', 'tests'])) return 'analysis'
  if (matches(['workspace', 'start_lsp', 'restart_lsp', 'detect_lsp', 'server_capabilities', 'capabilities', 'cache', 'cached', 'log', 'logs', 'watched_file', 'watched_files', 'open_document', 'close_document', 'skill', 'skills'])) return 'workspace'
  return 'other'
}

function facadeName(category: McpFacadeCategory | 'catalog'): string {
  return category === 'catalog' ? 'mcp_catalog' : `mcp_${category}`
}

function facadeDescription(category: McpFacadeCategory | 'catalog'): string {
  if (category === 'catalog') {
    return 'Discover downstream MCP capabilities progressively. Use list for an overview or category page, search for relevant operations, and describe for one operation input schema.'
  }
  return `Route a downstream MCP ${category} operation. Discover the operation with mcp_catalog and provide its server, operation, and arguments.`
}

function facadeParameters(category: McpFacadeCategory | 'catalog', operations: McpOperation[]): Record<string, unknown> {
  if (category === 'catalog') {
    return {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'describe'], description: 'Use list for an overview or category page, search to find relevant operations, or describe for one input schema.' },
        server: { type: 'string', description: 'Configured MCP server id. Required for describe.' },
        operation: { type: 'string', description: 'Downstream operation name. Required for describe.' },
        category: { type: 'string', enum: FACADE_CATEGORIES, description: 'Optional facade category filter for list or search.' },
        query: { type: 'string', description: 'Task keywords for search. May also narrow a list.' },
        offset: { type: 'integer', minimum: 0, description: 'Zero-based operation offset for a filtered list or search.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum operations to return. Defaults to 10.' },
      },
      required: ['action'],
      additionalProperties: false,
    }
  }
  const serverIds = [...new Set(operations.map((operation) => operation.serverId))]
  return {
    type: 'object',
    properties: {
      server: { type: 'string', enum: serverIds, description: 'Configured MCP server id.' },
      operation: { type: 'string', description: 'Downstream operation name discovered through mcp_catalog.' },
      arguments: { type: 'object', description: 'Arguments for the downstream MCP operation.', additionalProperties: true },
    },
    required: ['server', 'operation'],
    additionalProperties: false,
  }
}

function buildFacadeDefinitions(operations: McpOperation[]): McpToolDefinition[] {
  const definitions: McpToolDefinition[] = []
  if (operations.length > 0) {
    definitions.push({
      name: facadeName('catalog'),
      category: 'catalog',
      description: facadeDescription('catalog'),
      parameters: facadeParameters('catalog', operations),
      operations: operations.map((operation) => ({
        serverId: operation.serverId,
        serverName: operation.serverName,
        name: operation.originalName,
        description: operation.description,
        parameters: operation.parameters,
      })),
    })
  }
  for (const category of FACADE_CATEGORIES) {
    const categoryOperations = operations.filter((operation) => operation.category === category)
    if (categoryOperations.length === 0) continue
    definitions.push({
      name: facadeName(category),
      category,
      description: facadeDescription(category),
      parameters: facadeParameters(category, categoryOperations),
      operations: categoryOperations.map((operation) => ({
        serverId: operation.serverId,
        serverName: operation.serverName,
        name: operation.originalName,
        description: operation.description,
        parameters: operation.parameters,
      })),
    })
  }
  return definitions
}

async function discoverMcpTools(
  configs: McpStdioServerConfig[],
  projectRoot: string | undefined,
  signal?: AbortSignal,
  onConnectionError?: (config: McpStdioServerConfig, error: unknown) => void,
): Promise<DiscoveredMcpTools> {
  const connected: ConnectedServer[] = []
  const operations: McpOperation[] = []

  for (const config of configs.filter((entry) => entry.enabled)) {
    const client = new McpStdioClient()
    try {
      await client.connect(config, resolveMcpCwd(config, projectRoot), signal)
      const server = { config, client }
      connected.push(server)
      for (const tool of await client.listTools(signal)) {
        operations.push({
          server,
          serverId: config.id,
          serverName: config.name,
          originalName: tool.name,
          description: tool.description ?? tool.name,
          parameters: tool.inputSchema,
          category: classifyOperation(tool.name),
        })
      }
    } catch (error) {
      await client.close()
      onConnectionError?.(config, error)
    }
  }

  return { connected, operations }
}

async function closeConnectedServers(connected: ConnectedServer[]): Promise<void> {
  await Promise.allSettled(connected.map(({ client }) => client.close()))
}

export function resolveMcpCwd(config: McpStdioServerConfig, projectRoot?: string): string | undefined {
  if (config.cwdMode === 'custom') return config.customCwd
  return projectRoot
}

function parseArguments(toolName: string, raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object')
    return parsed as Record<string, unknown>
  } catch {
    throw new Error(`Invalid arguments for MCP tool ${toolName}`)
  }
}

function categoryCounts(operations: McpOperation[]): Record<McpFacadeCategory, number> {
  const counts = Object.fromEntries(FACADE_CATEGORIES.map((category) => [category, 0])) as Record<McpFacadeCategory, number>
  for (const operation of operations) counts[operation.category] += 1
  return counts
}

function operationSummary(operation: McpOperation): Record<string, unknown> {
  return {
    server: { id: operation.serverId, name: operation.serverName },
    operation: operation.originalName,
    category: operation.category,
    description: operation.description,
    facade: facadeName(operation.category),
  }
}

function normalizedSearchText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function expandedSearchText(value: string): string {
  const normalized = normalizedSearchText(value)
  const aliases: Array<[string, string]> = [
    ['诊断', 'diagnostic error'],
    ['错误', 'diagnostic error'],
    ['引用', 'reference'],
    ['定义', 'definition'],
    ['声明', 'declaration'],
    ['实现', 'implementation'],
    ['符号', 'symbol'],
    ['重命名', 'rename'],
    ['调用', 'caller call'],
    ['影响', 'blast radius'],
    ['测试', 'test'],
    ['构建', 'build'],
    ['补全', 'completion'],
    ['格式化', 'format'],
    ['文档', 'documentation'],
    ['工作区', 'workspace'],
    ['启动', 'start lsp'],
    ['编辑', 'edit'],
  ]
  return [normalized, ...aliases.filter(([term]) => normalized.includes(term)).map(([, expansion]) => expansion)]
    .filter(Boolean)
    .join(' ')
}

function searchScore(operation: McpOperation, rawQuery: string): number {
  const query = expandedSearchText(rawQuery)
  if (!query) return 0
  const name = normalizedSearchText(operation.originalName)
  const description = normalizedSearchText(operation.description)
  const category = normalizedSearchText(operation.category)
  const server = normalizedSearchText(operation.serverName)
  let score = name === query ? 100 : name.includes(query) ? 60 : description.includes(query) ? 30 : 0
  for (const token of query.split(/\s+/).filter(Boolean)) {
    if (name.split(' ').includes(token)) score += 16
    else if (name.includes(token)) score += 10
    if (description.includes(token)) score += 4
    if (category.includes(token) || server.includes(token)) score += 2
  }
  return score
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length]
}

function operationSuggestions(operations: McpOperation[], serverId: string, operationName: string): Array<Record<string, unknown>> {
  const normalizedName = normalizedSearchText(operationName)
  return operations
    .filter((operation) => !serverId || operation.serverId === serverId)
    .map((operation) => ({
      operation,
      score: searchScore(operation, operationName),
      distance: levenshteinDistance(normalizedSearchText(operation.originalName), normalizedName),
    }))
    .filter(({ score, distance }) => score > 0 || distance <= Math.max(2, Math.floor(normalizedName.length * 0.3)))
    .sort((left, right) => right.score - left.score || left.distance - right.distance || left.operation.originalName.localeCompare(right.operation.originalName))
    .slice(0, 3)
    .map(({ operation }) => ({
      operation: operation.originalName,
      category: operation.category,
      facade: facadeName(operation.category),
    }))
}

function catalogResult(operations: McpOperation[], args: Record<string, unknown>): string {
  const action = args.action
  if (action !== 'list' && action !== 'search' && action !== 'describe') {
    return JSON.stringify({ success: false, content: 'action must be list, search, or describe' })
  }
  if (action === 'describe') {
    const serverId = typeof args.server === 'string' ? args.server : ''
    const operationName = typeof args.operation === 'string' ? args.operation : ''
    const operation = operations.find((item) => item.serverId === serverId && item.originalName === operationName)
    if (!operation) {
      return JSON.stringify({
        success: false,
        error: 'unknown_operation',
        content: `Unknown MCP operation ${serverId}/${operationName}`,
        suggestions: operationSuggestions(operations, serverId, operationName),
        next_action: 'Use mcp_catalog search to discover the operation, then describe it.',
      })
    }
    return JSON.stringify({
      success: true,
      server: { id: operation.serverId, name: operation.serverName },
      operation: operation.originalName,
      category: operation.category,
      facade: facadeName(operation.category),
      description: operation.description,
      parameters: operation.parameters,
    })
  }
  const serverId = typeof args.server === 'string' ? args.server : undefined
  const category = typeof args.category === 'string' ? args.category : undefined
  if (serverId && !operations.some((operation) => operation.serverId === serverId)) {
    return JSON.stringify({ success: false, content: `Unknown MCP server ${serverId}` })
  }
  if (category && !FACADE_CATEGORIES.includes(category as McpFacadeCategory)) {
    return JSON.stringify({ success: false, content: `Unknown MCP category ${category}` })
  }
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (action === 'search' && !query) {
    return JSON.stringify({ success: false, content: 'query is required for search' })
  }
  const pagedRequest = args.offset !== undefined || args.limit !== undefined
  if (action === 'list' && !serverId && !category && !query && !pagedRequest) {
    const serverMap = new Map<string, { id: string; name: string; operation_count: number; categories: Record<McpFacadeCategory, number> }>()
    for (const operation of operations) {
      const entry = serverMap.get(operation.serverId) ?? {
        id: operation.serverId,
        name: operation.serverName,
        operation_count: 0,
        categories: categoryCounts([]),
      }
      entry.operation_count += 1
      entry.categories[operation.category] += 1
      serverMap.set(operation.serverId, entry)
    }
    return JSON.stringify({
      success: true,
      total_operations: operations.length,
      categories: categoryCounts(operations),
      servers: [...serverMap.values()],
      next_action: 'Use action=search with task keywords or action=list with a category, then action=describe for the selected operation schema.',
    })
  }

  const offset = Number.isInteger(args.offset) && Number(args.offset) >= 0 ? Number(args.offset) : 0
  const limit = Number.isInteger(args.limit) ? Math.min(20, Math.max(1, Number(args.limit))) : 10
  const filtered = operations
    .filter((operation) => !serverId || operation.serverId === serverId)
    .filter((operation) => !category || operation.category === category)
    .map((operation) => ({ operation, score: query ? searchScore(operation, query) : 0 }))
    .filter(({ score }) => !query || score > 0)
    .sort((left, right) => right.score - left.score
      || left.operation.serverName.localeCompare(right.operation.serverName)
      || left.operation.originalName.localeCompare(right.operation.originalName))
  const page = filtered.slice(offset, offset + limit).map(({ operation }) => operationSummary(operation))
  const nextOffset = offset + page.length
  return JSON.stringify({
    success: true,
    total: filtered.length,
    offset,
    limit,
    has_more: nextOffset < filtered.length,
    next_offset: nextOffset < filtered.length ? nextOffset : null,
    operations: page,
    next_action: page.length > 0
      ? 'Use action=describe for the selected operation before calling its facade.'
      : 'Broaden the search query or list a category from the overview.',
  })
}

export async function createMcpToolProvider(
  configs: McpStdioServerConfig[],
  projectRoot: string | undefined,
  signal?: AbortSignal,
  onConnectionError?: (config: McpStdioServerConfig, error: unknown) => void,
): Promise<AgentToolProvider> {
  const { connected, operations } = await discoverMcpTools(configs, projectRoot, signal, onConnectionError)
  const definitions = buildFacadeDefinitions(operations)
  const operationRoutes = new Map(operations.map((operation) => [`${operation.serverId}\0${operation.originalName}`, operation]))
  const failureCounts = new Map<string, number>()
  const tools = definitions.map((definition) => ({
    type: 'function',
    function: { name: definition.name, description: definition.description, parameters: definition.parameters },
  }))
  const instructions = [
    ...MCP_BASE_INSTRUCTIONS,
    ...(connected.some(({ config }) => isAgentLspServer(config)) ? AGENT_LSP_INSTRUCTIONS : []),
  ].join(' ')

  return {
    tools,
    instructions: tools.length > 0 ? instructions : undefined,
    async execute(toolCall, callSignal) {
      const definition = definitions.find((item) => item.name === toolCall.function.name)
      if (!definition) return undefined
      const args = parseArguments(toolCall.function.name, toolCall.function.arguments)
      if (definition.category === 'catalog') return catalogResult(operations, args)

      const serverId = typeof args.server === 'string' ? args.server : ''
      const operationName = typeof args.operation === 'string' ? args.operation : ''
      if (!serverId || !operationName) {
        return JSON.stringify({ success: false, content: 'server and operation are required' })
      }
      const route = operationRoutes.get(`${serverId}\0${operationName}`)
      if (!route) {
        const serverExists = operations.some((operation) => operation.serverId === serverId)
        return JSON.stringify({
          success: false,
          error: serverExists ? 'unknown_operation' : 'unknown_server',
          content: serverExists ? `Unknown MCP operation ${serverId}/${operationName}` : `Unknown MCP server ${serverId}`,
          suggestions: serverExists ? operationSuggestions(operations, serverId, operationName) : [],
          next_action: serverExists
            ? 'Use mcp_catalog search to discover the operation, then describe it.'
            : 'Use mcp_catalog list to discover configured server ids.',
        })
      }
      if (route.category !== definition.category) {
        return JSON.stringify({
          success: false,
          error: 'wrong_category',
          content: `${operationName} belongs to the ${route.category} MCP category.`,
          operation: operationName,
          expected_tool: facadeName(route.category),
          next_action: `Call ${facadeName(route.category)} with the same server, operation, and arguments.`,
        })
      }
      const downstreamArgs = args.arguments
      if (downstreamArgs !== undefined && (!downstreamArgs || typeof downstreamArgs !== 'object' || Array.isArray(downstreamArgs))) {
        return JSON.stringify({ success: false, content: 'arguments must be a JSON object' })
      }
      const result = await route.server.client.callTool(route.originalName, (downstreamArgs ?? {}) as Record<string, unknown>, callSignal)
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

/** Lists the same model-visible MCP facade tools used by an Agent run, then
 * closes the temporary server connections. Used by read-only UI such as Help. */
export async function listMcpToolDefinitions(
  configs: McpStdioServerConfig[],
  projectRoot: string | undefined,
  signal?: AbortSignal,
  onConnectionError?: (config: McpStdioServerConfig, error: unknown) => void,
): Promise<McpToolDefinition[]> {
  const { connected, operations } = await discoverMcpTools(configs, projectRoot, signal, onConnectionError)
  try {
    return buildFacadeDefinitions(operations)
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
