import { dagStatuses, isRecord, readyDagNodeIds, validateDagState, type DagNode, type DagSnapshot, type DagStatus } from '../shared/dag'
import type { AgentToolProvider } from './agent-tool-provider'
import type { TaskRunJournal } from './task-run-journal'

const actions = ['get', 'set', 'update'] as const
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Unexpected DAG parameter; expected ' + allowed.join(', '))
}
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 2000) throw new Error(field + ' must be a string of at most 2000 characters')
  return value
}
function nodeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error('Node IDs must be 1–64 letters, digits, underscores or hyphens')
  return value
}

export function applyDagAction(current: readonly DagNode[], args: unknown): DagSnapshot {
  if (!isRecord(args) || !actions.includes(args.action as DagSnapshot['action'])) throw new Error('action must be get, set, or update')
  const action = args.action as DagSnapshot['action']
  let nodes: DagNode[] = structuredClone([...current])
  let reason: string | undefined
  if (action === 'get') keys(args, ['action'])
  else {
    reason = optionalText(args.reason, 'reason')
    if (action === 'set') {
      keys(args, ['action', 'nodes', 'reason'])
      if (!Array.isArray(args.nodes) || args.nodes.length < 1 || args.nodes.length > 100) throw new Error('nodes must contain 1–100 tasks')
      const previous = new Map(nodes.map((node) => [node.id, node]))
      nodes = args.nodes.map((value): DagNode => {
        if (!isRecord(value)) throw new Error('Invalid DAG node')
        keys(value, ['id', 'name', 'description', 'dependsOn'])
        const id = nodeId(value.id)
        if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 160) throw new Error('name must be 1–160 characters')
        if (!Array.isArray(value.dependsOn) || value.dependsOn.length > 100) throw new Error('dependsOn must be an array of node IDs')
        const old = previous.get(id)
        return { id, name: value.name.trim(), description: optionalText(value.description, 'description'),
          dependsOn: value.dependsOn.map(nodeId), status: old?.status ?? 'pending', note: old?.note }
      })
    } else {
      keys(args, ['action', 'updates', 'reason'])
      if (!Array.isArray(args.updates) || args.updates.length < 1 || args.updates.length > 100) throw new Error('updates must contain 1–100 node updates')
      const seen = new Set<string>()
      for (const update of args.updates) {
        if (!isRecord(update)) throw new Error('Invalid DAG update')
        keys(update, ['id', 'status', 'note'])
        const id = nodeId(update.id)
        if (seen.has(id)) throw new Error('Duplicate update for ' + id)
        seen.add(id)
        const node = nodes.find((item) => item.id === id)
        if (!node) throw new Error('DAG node not found: ' + id)
        if (!dagStatuses.includes(update.status as DagStatus)) throw new Error('Invalid DAG status for ' + id)
        node.status = update.status as DagStatus
        if (update.note !== undefined) node.note = optionalText(update.note, 'note')
      }
    }
  }
  // Validate the final batch, so finishing a prerequisite and starting its successor is atomic.
  validateDagState(nodes)
  return { kind: 'dag-snapshot', version: 1, success: true, action, nodes, readyNodeIds: readyDagNodeIds(nodes), ...(reason === undefined ? {} : { reason }) }
}

export const dagToolDefinition = {
  type: 'function',
  function: {
    name: 'dag',
    description: 'Maintain a task dependency plan when work branches and merges; use todo for flat plans, or neither for simple work. get returns the current graph and readyNodeIds. set atomically replaces the entire structure (1–100 tasks); omitted IDs are removed, retained IDs keep status/notes, new IDs start pending. System start/end nodes are implicit; do not include them. Every dependency is an AND prerequisite; cycles are rejected. update atomically changes statuses/notes. Only start/finish nodes whose prerequisites are finished; at most one node may be in_progress (sequential execution). To reopen a prerequisite, reset affected successors in the same update. blocked requires explicit recovery to pending/in_progress. A continuation retains the same graph; new tasks start empty. Completion is plan progress, not proof of validation. Every call returns an immutable snapshot.',
    parameters: {
      type: 'object', properties: {
        action: { type: 'string', enum: actions },
        nodes: { type: 'array', minItems: 1, maxItems: 100, description: 'For set: complete task graph, excluding implicit start/end.', items: {
          type: 'object', properties: {
            id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' },
            name: { type: 'string', minLength: 1, maxLength: 160 },
            description: { type: 'string', maxLength: 2000 },
            dependsOn: { type: 'array', items: { type: 'string' }, maxItems: 100, uniqueItems: true },
          }, required: ['id', 'name', 'dependsOn'], additionalProperties: false,
        } },
        updates: { type: 'array', minItems: 1, maxItems: 100, description: 'For update: status changes by stable node ID.', items: {
          type: 'object', properties: {
            id: { type: 'string' }, status: { type: 'string', enum: dagStatuses }, note: { type: 'string', maxLength: 2000 },
          }, required: ['id', 'status'], additionalProperties: false,
        } },
        reason: { type: 'string', maxLength: 2000, description: 'Optional explanation for set/update.' },
      }, required: ['action'], additionalProperties: false,
    },
  },
}

export function createDagToolProvider(journal: TaskRunJournal, runId: string, taskId: string): AgentToolProvider {
  // Serialize mutations, including concurrent tool calls, before reading their starting state.
  let queue: Promise<unknown> = Promise.resolve()
  return {
    tools: [],
    async execute(toolCall, signal) {
      if (toolCall.function.name !== 'dag') return undefined
      const execute = async (): Promise<string> => {
        if (signal?.aborted) throw new Error('Operation stopped')
        const nodes = journal.latestDagNodes(taskId)
        let args: unknown
        try { args = JSON.parse(toolCall.function.arguments) } catch { args = null }
        let snapshot: DagSnapshot
        try { snapshot = applyDagAction(nodes, args) }
        catch (error) {
          const action = isRecord(args) && actions.includes(args.action as DagSnapshot['action']) ? args.action as DagSnapshot['action'] : 'get'
          snapshot = { kind: 'dag-snapshot', version: 1, success: false, action, nodes, readyNodeIds: readyDagNodeIds(nodes),
            error: error instanceof Error ? error.message : 'Invalid DAG request' }
        }
        await journal.append(runId, { type: 'dag-snapshot', toolCallId: toolCall.id, taskId, snapshot })
        return JSON.stringify(snapshot)
      }
      const result = queue.then(execute)
      queue = result.catch(() => undefined)
      return result
    },
  }
}
