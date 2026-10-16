import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultContextManagementConfig, defaultModelConfig, type Project } from '../src/shared/types'
import type { AgentToolProvider } from '../src/main/agent-tool-provider'
import type { RunEventPayload } from '../src/shared/task-run'

vi.mock('electron', () => ({ app: { isPackaged: true, getPath: (name: string) => name === 'logs' ? '.agent_tmp/test-logs/task-run-agent' : '.' } }))
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

function toolDelta(...ids: string[]): object {
  return { tool_calls: ids.map((id, index) => ({
    index, id, type: 'function', function: { name: 'todo', arguments: '{"action":"get"}' },
  })) }
}

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

  it('closes an interrupted batch and pairs every call with a stopped result', async () => {
    const controller = new AbortController()
    const events: RunEventPayload[] = []
    vi.stubGlobal('fetch', vi.fn(async () => response(toolDelta('todo-call', 'pending-call'))))
    const execute = vi.fn(async () => { controller.abort(); throw new Error('stopped') })
    const result = await develop(project, model, contextConfig,
      { modelRequestsPerRound: 3, toolCallsPerRequest: 4 }, history, undefined, undefined, {
        conversationId: 'conversation', signal: controller.signal, latestUserMessageId: 'user',
        onRunEvent: async (event) => { events.push(event) },
        todoProvider: { tools: [], execute },
      })
    expect(result.stopped).toBe(true)
    expect(events.filter((event) => event.type === 'tool-call')).toEqual([
      { type: 'tool-call', toolCallId: 'todo-call', name: 'todo', phase: 'started' },
      { type: 'tool-call', toolCallId: 'todo-call', name: 'todo', phase: 'finished', failed: true, cancelled: true },
    ])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.agentMessages?.filter((message) => message.role === 'tool').map((message) => [message.toolCallId, message.content])).toEqual([
      ['todo-call', 'Stopped by user before completion'], ['pending-call', 'Stopped by user before completion'],
    ])
  })
  it('rejects an overflowing batch without side effects and accepts a corrected request', async () => {
    const events: RunEventPayload[] = []
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(toolDelta('rejected-1', 'rejected-2')))
      .mockResolvedValueOnce(response(toolDelta('accepted')))
      .mockResolvedValueOnce(response({ content: 'Done' }))
    vi.stubGlobal('fetch', fetchMock)
    const execute = vi.fn<AgentToolProvider['execute']>(async () => 'Current todo list')
    const result = await develop(project, model, contextConfig,
      { modelRequestsPerRound: 3, toolCallsPerRequest: 1 }, history, undefined, undefined, {
        conversationId: 'conversation', latestUserMessageId: 'user',
        onRunEvent: async (event) => { events.push(event) }, todoProvider: { tools: [], execute },
      })
    expect(result.error).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ id: 'accepted' })
    const correctionRequest = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(correctionRequest.messages.filter((message: { role: string }) => message.role === 'tool')).toEqual([
      expect.objectContaining({ tool_call_id: 'rejected-1', content: expect.stringContaining('None of them were executed') }),
      expect.objectContaining({ tool_call_id: 'rejected-2', content: expect.stringContaining('None of them were executed') }),
    ])
    expect(events.filter((event) => event.type === 'tool-call').map((event) => [event.toolCallId, event.phase])).toEqual([
      ['accepted', 'started'], ['accepted', 'finished'],
    ])
  })

  it('rejects tools on the last request and can continue with intact call/result history', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(toolDelta('budget-rejected')))
      .mockResolvedValueOnce(response({ content: 'Resumed successfully' }))
    vi.stubGlobal('fetch', fetchMock)
    const execute = vi.fn(async () => 'Must not execute')
    const runtime = { conversationId: 'conversation', latestUserMessageId: 'user', todoProvider: { tools: [], execute } }
    const limits = { modelRequestsPerRound: 1, toolCallsPerRequest: 4 }
    const exhausted = await develop(project, model, contextConfig, limits, history, undefined, undefined, runtime)
    expect(exhausted.error).toContain('model-request limit')
    expect(exhausted.agentMessages).toContainEqual(expect.objectContaining({
      role: 'tool', toolCallId: 'budget-rejected', content: expect.stringContaining('not allowed on the final model request'),
    }))
    const resumed = await develop(project, model, contextConfig, limits, exhausted.agentMessages!, undefined, undefined, runtime)
    expect(resumed.error).toBeUndefined()
    expect(resumed.agentMessages?.at(-1)).toMatchObject({ role: 'assistant', content: 'Resumed successfully' })
    expect(execute).not.toHaveBeenCalled()
    const resumedRequest = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(resumedRequest.messages).toContainEqual(expect.objectContaining({
      role: 'assistant', tool_calls: [expect.objectContaining({ id: 'budget-rejected' })],
    }))
    expect(resumedRequest.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'budget-rejected' }))
  })

  it('records a failed tool result and lets the model recover without replaying the tool', async () => {
    const events: RunEventPayload[] = []
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(toolDelta('failed-call')))
      .mockResolvedValueOnce(response({ content: 'Explained the failure' }))
    vi.stubGlobal('fetch', fetchMock)
    const execute = vi.fn(async () => { throw new Error('resource unavailable') })
    const result = await develop(project, model, contextConfig,
      { modelRequestsPerRound: 3, toolCallsPerRequest: 4 }, history, undefined, undefined, {
        conversationId: 'conversation', latestUserMessageId: 'user',
        onRunEvent: async (event) => { events.push(event) }, todoProvider: { tools: [], execute },
      })
    expect(result.error).toBeUndefined()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(events.filter((event) => event.type === 'tool-call')).toEqual([
      { type: 'tool-call', toolCallId: 'failed-call', name: 'todo', phase: 'started' },
      { type: 'tool-call', toolCallId: 'failed-call', name: 'todo', phase: 'finished', failed: true },
    ])
    const recoveryRequest = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(recoveryRequest.messages).toContainEqual(expect.objectContaining({
      role: 'tool', tool_call_id: 'failed-call', content: 'Error: resource unavailable',
    }))
    expect(result.agentMessages?.at(-1)).toMatchObject({ role: 'assistant', content: 'Explained the failure' })
  })
})
