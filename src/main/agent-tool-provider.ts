import type { ToolCall } from './tools'

export type AgentToolProvider = {
  tools: object[]
  execute(toolCall: ToolCall, signal?: AbortSignal): Promise<string | undefined>
  close?(): Promise<void>
  instructions?: string
}

export async function executeAgentToolProviders(
  providers: AgentToolProvider[],
  toolCall: ToolCall,
  signal?: AbortSignal,
): Promise<string | undefined> {
  for (const provider of providers) {
    const result = await provider.execute(toolCall, signal)
    if (result !== undefined) return result
  }
  return undefined
}
