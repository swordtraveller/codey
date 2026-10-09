import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultContextManagementConfig, defaultModelConfig, layeredStrategyPrompt, type Project } from '../src/shared/types'

vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '.' } }))
vi.mock('../src/main/project-detection', () => ({
  detectProjectFolders: vi.fn(async () => []),
  formatProjectDetections: vi.fn(() => []),
}))

import { buildAgentContext, develop } from '../src/main/agent'
import { HOT_LONG_TERM_TOOL } from '../src/main/hot-long-term'

const project: Project = {
  id: 'project', name: 'Project', archived: false, defaultModelConfigId: null,
  contextConfigOverride: null, commandExecutionDefault: null, agentLimitsDefault: null,
  skillSelection: { enabledIds: [], disabledIds: [] },
  knowledgeBaseSelection: { enabledIds: [], disabledIds: [] },
  folders: [{ id: 'folder', path: 'D:/project' }], pythonEnvironmentFolderId: null, conversations: [],
}
const model = {
  ...defaultModelConfig, id: 'model', baseUrl: 'https://model.example/v1', apiKey: 'key', modelName: 'model',
  chain: [{
    modelId: 'model', label: 'model', baseUrl: 'https://model.example/v1', apiKey: 'key', modelName: 'model',
  }], retriesPerModel: 1,
}
const contextConfig = { ...defaultContextManagementConfig, layeredEnabled: true, hotTokenBudget: 64_000 }
const history = [{ id: 'user', role: 'user' as const, content: 'Remember my confirmed preference.' }]

function response(delta: object): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

type Request = { messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> }

afterEach(() => vi.unstubAllGlobals())

describe('Long-term agent integration', () => {
  it.each([
    { label: 'replacement', replacement: 'Updated confirmed preference', fails: false, expected: 'Updated confirmed preference' },
    { label: 'clear', replacement: '', fails: false, expected: '' },
    { label: 'persistence failure', replacement: 'Not saved', fails: true, expected: 'Original confirmed preference' },
  ])('uses the correct Long-term prompt in the next same-turn request after $label', async ({ replacement, fails, expected }) => {
    const requests: Request[] = []
    let persistenceFinished = false
    const persist = vi.fn(async () => {
      await Promise.resolve()
      persistenceFinished = true
      if (fails) throw new Error('disk unavailable')
    })
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)))
      if (requests.length === 1) return response({ tool_calls: [{
        index: 0, id: 'update-1', type: 'function',
        function: { name: HOT_LONG_TERM_TOOL, arguments: JSON.stringify({ content: replacement }) },
      }] })
      expect(persistenceFinished).toBe(true)
      return response({ content: 'Done.' })
    }))

    const result = await develop(project, model, contextConfig,
      { modelRequestsPerRound: 3, toolCallsPerRequest: 4 }, history, undefined, undefined, {
        conversationId: 'conversation', latestUserMessageId: 'user',
        hotLongTermContent: 'Original confirmed preference', onHotLongTermUpdated: persist,
      })

    expect(result.error).toBeUndefined()
    expect(requests).toHaveLength(2)
    expect(persist).toHaveBeenCalledExactlyOnceWith(replacement)
    expect(requests[0].tools.some((tool) => tool.function.name === HOT_LONG_TERM_TOOL)).toBe(true)
    expect(requests[0].messages.filter((message) => message.content?.startsWith('[Long-term context]')))
      .toEqual([expect.objectContaining({ content: '[Long-term context]\nOriginal confirmed preference' })])
    const nextLongTerm = requests[1].messages.filter((message) => message.content?.startsWith('[Long-term context]'))
    expect(nextLongTerm).toEqual(expected ? [expect.objectContaining({ content: `[Long-term context]\n${expected}` })] : [])
    const toolResult = requests[1].messages.find((message) => message.role === 'tool')!
    expect(JSON.parse(toolResult.content).ok).toBe(!fails)
    expect(result.agentMessages.map((message) => message.role)).not.toContain('system')
  })

  it.each([
    { layeredEnabled: false, customStrategyEnabled: false },
    { layeredEnabled: true, customStrategyEnabled: false },
    { layeredEnabled: true, customStrategyEnabled: true },
  ])('gates Long-term context with layered=$layeredEnabled and unauthorized custom=$customStrategyEnabled', async ({ layeredEnabled, customStrategyEnabled }) => {
    const requests: Request[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)))
      return response({ content: 'Done.' })
    }))
    const result = await develop(project, model, {
      ...contextConfig, layeredEnabled, customStrategyEnabled, customStrategyScript: 'script',
      customStrategyPrompt: 'Custom strategy policy',
    },
      { modelRequestsPerRound: 3, toolCallsPerRequest: 4 }, history, undefined, undefined, {
        conversationId: 'conversation', latestUserMessageId: 'user', hotLongTermContent: 'Durable fact',
      })
    expect(result.error).toBeUndefined()
    expect(requests[0].tools.some((tool) => tool.function.name === HOT_LONG_TERM_TOOL)).toBe(layeredEnabled)
    expect(requests[0].messages.some((message) => message.content?.startsWith('[Long-term context]'))).toBe(layeredEnabled)
    if (layeredEnabled) expect(requests[0].messages[0].content).toContain(layeredStrategyPrompt)
    expect(requests[0].messages[0].content).not.toContain('Custom strategy policy')
  })

  it('uses actual custom-strategy permission when deciding whether to inject Long-term context', () => {
    const customConfig = { ...contextConfig, customStrategyEnabled: true, customStrategyScript: 'script' }
    const built = buildAgentContext(project, model, customConfig, history, false, { allow: false }, [], [], 'Durable fact')
    expect(built.messages).toContainEqual(expect.objectContaining({ content: '[Long-term context]\nDurable fact' }))
    expect(built.messages[0].content).toContain(layeredStrategyPrompt)
    const singleLayer = buildAgentContext(project, model, { ...contextConfig, layeredEnabled: false }, history, false, undefined, [], [], 'Durable fact')
    expect(singleLayer.messages.some((message) => message.content?.startsWith('[Long-term context]'))).toBe(false)
  })
})
