import { orderDagNodes, type DagNode, type DagStatus } from '../../../shared/dag'

export const DAG_NODE_WIDTH = 156
export const DAG_NODE_HEIGHT = 76
const GAP_X = 64
const GAP_Y = 28
const PADDING = 16
export type DagLayoutNode = {
  id: string; kind: 'start' | 'task' | 'end'; status: DagStatus
  x: number; y: number; task?: DagNode
}
export type DagLayout = {
  nodes: DagLayoutNode[]
  edges: { from: string; to: string; path: string }[]
  width: number
  height: number
}

/** Arrange prerequisite layers from left to right; nodes in one layer are vertically stacked. */
export function layoutDag(tasks: readonly DagNode[]): DagLayout {
  const ordered = orderDagNodes(tasks)
  const depth = new Map<string, number>()
  for (const task of ordered) depth.set(task.id, 1 + Math.max(0, ...task.dependsOn.map((id) => depth.get(id)!)))
  const maxTaskDepth = depth.size ? Math.max(...depth.values()) : 0
  const endDepth = maxTaskDepth + 1
  const layers: DagLayoutNode[][] = Array.from({ length: endDepth + 1 }, () => [])
  layers[0].push({ id: '$start', kind: 'start', status: tasks.length ? 'finished' : 'pending', x: 0, y: 0 })
  for (const task of tasks) layers[depth.get(task.id)!].push({ id: task.id, kind: 'task', status: task.status, task, x: 0, y: 0 })
  layers[endDepth].push({ id: '$end', kind: 'end', status: tasks.length && tasks.every((node) => node.status === 'finished') ? 'finished' : 'pending', x: 0, y: 0 })
  const widest = Math.max(...layers.map((layer) => layer.length))
  const width = PADDING * 2 + layers.length * DAG_NODE_WIDTH + (layers.length - 1) * GAP_X
  const height = PADDING * 2 + widest * DAG_NODE_HEIGHT + (widest - 1) * GAP_Y
  layers.forEach((layer, level) => {
    const layerHeight = layer.length * DAG_NODE_HEIGHT + (layer.length - 1) * GAP_Y
    layer.forEach((node, index) => {
      node.x = PADDING + level * (DAG_NODE_WIDTH + GAP_X)
      node.y = (height - layerHeight) / 2 + index * (DAG_NODE_HEIGHT + GAP_Y)
    })
  })
  const nodes = layers.flat()
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const outgoing = new Set(tasks.flatMap((node) => node.dependsOn))
  const pairs = tasks.flatMap((node) => (node.dependsOn.length ? node.dependsOn : ['$start']).map((id) => ({ from: id, to: node.id })))
  for (const task of tasks) if (!outgoing.has(task.id)) pairs.push({ from: task.id, to: '$end' })
  if (!tasks.length) pairs.push({ from: '$start', to: '$end' })
  const edges = pairs.map(({ from, to }) => {
    const a = byId.get(from)!, b = byId.get(to)!
    const x1 = a.x + DAG_NODE_WIDTH, y1 = a.y + DAG_NODE_HEIGHT / 2
    const x2 = b.x, y2 = b.y + DAG_NODE_HEIGHT / 2
    const bend = Math.max(20, (x2 - x1) / 2)
    const path = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2
    return { from, to, path }
  })
  return { nodes, edges, width, height }
}
