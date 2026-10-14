/** Immutable task plan snapshots. Dependencies are AND gates, not conditional branches. */
export const dagStatuses = ['pending', 'in_progress', 'blocked', 'finished'] as const
export type DagStatus = typeof dagStatuses[number]
export type DagNode = {
  id: string
  name: string
  description?: string
  dependsOn: string[]
  status: DagStatus
  note?: string
}
export type DagSnapshot = {
  kind: 'dag-snapshot'
  version: 1
  success: boolean
  action: 'get' | 'set' | 'update'
  nodes: DagNode[]
  readyNodeIds: string[]
  reason?: string
  error?: string
}
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Returns a topological order, rejecting missing dependencies, duplicate IDs and cycles. */
export function orderDagNodes(nodes: readonly DagNode[]): DagNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  if (byId.size !== nodes.length) throw new Error('Duplicate DAG node ID')
  const visited = new Set<string>()
  const active = new Set<string>()
  const ordered: DagNode[] = []
  const visit = (node: DagNode): void => {
    if (active.has(node.id)) throw new Error('DAG contains a cycle at ' + node.id)
    if (visited.has(node.id)) return
    active.add(node.id)
    if (new Set(node.dependsOn).size !== node.dependsOn.length) throw new Error('Duplicate dependency for ' + node.id)
    for (const id of node.dependsOn) {
      const dependency = byId.get(id)
      if (!dependency) throw new Error('Missing DAG dependency: ' + id)
      visit(dependency)
    }
    active.delete(node.id)
    visited.add(node.id)
    ordered.push(node)
  }
  for (const node of nodes) visit(node)
  return ordered
}

export function validateDagState(nodes: readonly DagNode[]): void {
  orderDagNodes(nodes)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    if ((node.status === 'in_progress' || node.status === 'finished')
      && node.dependsOn.some((id) => byId.get(id)?.status !== 'finished')) {
      throw new Error('All dependencies must be finished before starting or finishing ' + node.id)
    }
  }
  if (nodes.filter((node) => node.status === 'in_progress').length > 1) {
    throw new Error('Only one DAG node can be in_progress in sequential execution')
  }
}

export function readyDagNodeIds(nodes: readonly DagNode[]): string[] {
  const completed = new Set(nodes.filter((node) => node.status === 'finished').map((node) => node.id))
  return nodes.filter((node) => node.status === 'pending' && node.dependsOn.every((id) => completed.has(id))).map((node) => node.id)
}

export function isDagSnapshot(value: unknown): value is DagSnapshot {
  if (!isRecord(value) || value.kind !== 'dag-snapshot' || value.version !== 1
    || typeof value.success !== 'boolean' || !['get', 'set', 'update'].includes(String(value.action))
    || !Array.isArray(value.nodes) || value.nodes.length > 100
    || !Array.isArray(value.readyNodeIds) || !value.readyNodeIds.every((id) => typeof id === 'string')
    || (value.reason !== undefined && typeof value.reason !== 'string')
    || (value.error !== undefined && typeof value.error !== 'string')) return false
  if (!value.nodes.every((node) => isRecord(node) && typeof node.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(node.id)
    && typeof node.name === 'string' && node.name.trim().length > 0 && node.name.length <= 160
    && (node.description === undefined || typeof node.description === 'string')
    && (node.note === undefined || typeof node.note === 'string')
    && dagStatuses.includes(node.status as DagStatus) && Array.isArray(node.dependsOn)
    && node.dependsOn.every((id) => typeof id === 'string'))) return false
  try {
    const nodes = value.nodes as DagNode[]
    validateDagState(nodes)
    return JSON.stringify(value.readyNodeIds) === JSON.stringify(readyDagNodeIds(nodes))
  } catch { return false }
}

export function parseDagSnapshot(result?: string): DagSnapshot | null {
  if (!result) return null
  try { const value: unknown = JSON.parse(result); return isDagSnapshot(value) ? value : null }
  catch { return null }
}
