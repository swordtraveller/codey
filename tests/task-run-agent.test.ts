import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultContextManagementConfig, defaultModelConfig, type Project } from '../src/shared/types'
import type { RunEventPayload } from '../src/shared/task-run'

vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '.' } }))
vi.mock('../src/main/project-detection', () => ({
  detectProjectFolders: vi.fn(async () => []), formatProjectDetections: vi.fn(() => []),
}))

import { develop, requestCompletion } from '../src/main/agent'

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


afterEach(() => vi.unstubAllGlobals())

describe('TaskRun agent event integration', () => {
  it('records each actual retry and fallback with its own call ID and model', async () => {
    const events: RunEventPayload[] = []
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(response({ content: 'Done' }))
    vi.stubGlobal('fetch', fetchMock)
    await requestCompletion({ ...model, chain: [model.chain[0], { ...model.chain[0], modelName: 'backup', label: 'backup' }] },
      history, [], undefined, undefined, { requestIndex: 2, onRunEvent: async (event) => { events.push(event) } })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const calls = events.filter((event) => event.type === 'model-call')
    expect(calls.map(({ model, phase, attempt, requestIndex }) => [model, phase, attempt, requestIndex])).toEqual([
      ['model', 'started', 1, 2], ['model', 'failed', 1, 2],
      ['model', 'started', 2, 2], ['model', 'failed', 2, 2],
      ['backup', 'started', 1, 2], ['backup', 'finished', 1, 2],
    ])
    expect(new Set(calls.map((event) => event.callId)).size).toBe(3)
    for (let i = 0; i < calls.length; i += 2) expect(calls[i].callId).toBe(calls[i + 1].callId)
  })

  it('does not retry a successful model request when recording its end fails', async () => {
    const fetchMock = vi.fn(async () => response({ content: 'Done' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestCompletion(model, history, [], undefined, undefined, {
      onRunEvent: async (event) => {
        if (event.type === 'model-call' && event.phase === 'finished') throw new Error('journal unavailable')
      },
    })).rejects.toThrow('journal unavailable')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('closes an interrupted tool call and retains its stopped result', async () => {
    const controller = new AbortController()
    const events: RunEventPayload[] = []
    vi.stubGlobal('fetch', vi.fn(async () => response({ tool_calls: [{
      index: 0, id: 'todo-call', type: 'function', function: { name: 'todo', arguments: '{"action":"get"}' },
    }] })))
    const result = await develop(project, model, contextConfig,
      { modelRequestsPerRound: 3, toolCallsPerRequest: 4 }, history, undefined, undefined, {
        conversationId: 'conversation', signal: controller.signal, latestUserMessageId: 'user',
        onRunEvent: async (event) => { events.push(event) },
        todoProvider: { tools: [], execute: async () => { controller.abort(); throw new Error('stopped') } },
      })
    expect(result.stopped).toBe(true)
    expect(events.filter((event) => event.type === 'tool-call')).toEqual([
      { type: 'tool-call', toolCallId: 'todo-call', name: 'todo', phase: 'started' },
      { type: 'tool-call', toolCallId: 'todo-call', name: 'todo', phase: 'finished', failed: true, cancelled: true },
    ])
    expect(result.agentMessages).toContainEqual(expect.objectContaining({ role: 'tool', content: 'Stopped by user before completion' }))
  })
})
