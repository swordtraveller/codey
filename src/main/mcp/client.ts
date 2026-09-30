import { Client } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { McpStdioServerConfig } from '../../shared/types'

const STDERR_LIMIT = 8 * 1024
const RESULT_LIMIT = 64 * 1024
const CONNECT_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 60_000

function bounded(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `[truncated ${value.length - limit} characters]\n${value.slice(-limit)}`
}

function serializeContent(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : []
  const text = content
    .map((item) => {
      if (!item || typeof item !== 'object') return JSON.stringify(item)
      const record = item as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') return record.text
      return JSON.stringify(record)
    })
    .filter(Boolean)
    .join('\n')
  const payload = {
    success: result.isError !== true,
    content: text || undefined,
    structuredContent: result.structuredContent,
  }
  return bounded(JSON.stringify(payload), RESULT_LIMIT)
}

export class McpStdioClient {
  private client?: Client
  private transport?: StdioClientTransport
  private stderrBuffer = ''

  get stderr(): string {
    return this.stderrBuffer
  }

  async connect(config: McpStdioServerConfig, cwd: string | undefined, signal?: AbortSignal): Promise<void> {
    if (this.client) throw new Error('MCP client is already connected')
    const customEnv = Object.keys(config.env).length > 0
      ? { ...getDefaultEnvironment(), ...config.env }
      : undefined
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd,
      env: customEnv,
      stderr: 'pipe',
    })
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrBuffer = bounded(this.stderrBuffer + chunk.toString(), STDERR_LIMIT)
    })
    const client = new Client(
      { name: 'codey', version: '0.6.0' },
      { versionNegotiation: { mode: 'legacy' } },
    )
    this.transport = transport
    this.client = client
    try {
      await client.connect(transport, { signal, timeout: CONNECT_TIMEOUT_MS })
    } catch (error) {
      await this.close()
      throw error
    }
  }

  getServerVersion(): { name: string; version: string } | undefined {
    const version = this.client?.getServerVersion()
    return version ? { name: version.name, version: version.version } : undefined
  }

  async listTools(signal?: AbortSignal): Promise<Array<{
    name: string
    description?: string
    inputSchema: Record<string, unknown>
  }>> {
    if (!this.client) throw new Error('MCP client is not connected')
    const result = await this.client.listTools(undefined, { signal, timeout: CONNECT_TIMEOUT_MS })
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }))
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (!this.client) throw new Error('MCP client is not connected')
    const result = await this.client.callTool(
      { name, arguments: args },
      { signal, timeout: CALL_TIMEOUT_MS },
    )
    return serializeContent(result as Record<string, unknown>)
  }

  async close(): Promise<void> {
    const client = this.client
    const transport = this.transport
    this.client = undefined
    this.transport = undefined
    if (client) {
      try {
        await client.close()
        return
      } catch {
        // Fall through to transport cleanup when the protocol close fails.
      }
    }
    if (transport) await transport.close().catch(() => undefined)
  }
}
