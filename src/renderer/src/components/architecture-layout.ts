import type { ArchitectureGraph, ArchitectureNode } from '../../../shared/architecture'
import type { GraphEdge } from './GraphCanvas'

export const ARCHITECTURE_NODE_WIDTH = 180
export const ARCHITECTURE_NODE_HEIGHT = 88
const GAP_X = 160
const GAP_Y = 36
const PADDING = 24
export type ArchitectureLayout = {
  nodes: (ArchitectureNode & { x: number; y: number })[]
  edges: GraphEdge[]
  width: number
  height: number
}

/** Collapse strongly connected components before layering, keeping cycles and disconnected nodes. */
export function layoutArchitecture(graph: ArchitectureGraph): ArchitectureLayout {
  const adjacency = new Map(graph.nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of graph.edges) adjacency.get(edge.from)!.push(edge.to)
  const indices = new Map<string, number>(), low = new Map<string, number>()
  const stack: string[] = [], active = new Set<string>(), components: string[][] = []
  function visit(id: string): void {
    const index = indices.size
    indices.set(id, index); low.set(id, index); stack.push(id); active.add(id)
    for (const next of adjacency.get(id)!) {
      if (!indices.has(next)) { visit(next); low.set(id, Math.min(low.get(id)!, low.get(next)!)) }
      else if (active.has(next)) low.set(id, Math.min(low.get(id)!, indices.get(next)!))
    }
    if (indices.get(id) !== low.get(id)) return
    const component: string[] = []
    let member: string
    do { member = stack.pop()!; active.delete(member); component.push(member) } while (member !== id)
    components.push(component)
  }
  for (const node of graph.nodes) if (!indices.has(node.id)) visit(node.id)
  const owner = new Map(components.flatMap((component, index) => component.map((id) => [id, index] as const)))
  const incoming = components.map(() => new Set<number>())
  for (const edge of graph.edges) if (owner.get(edge.from) !== owner.get(edge.to)) incoming[owner.get(edge.to)!].add(owner.get(edge.from)!)
  const depths = new Map<number, number>()
  function depth(index: number): number {
    if (!depths.has(index)) depths.set(index, Math.max(0, ...[...incoming[index]].map((parent) => depth(parent) + 1)))
    return depths.get(index)!
  }
  const layers: ArchitectureNode[][] = []
  for (const node of graph.nodes) (layers[depth(owner.get(node.id)!)] ??= []).push(node)
  const sameLayer = graph.edges.filter((edge) => depth(owner.get(edge.from)!) === depth(owner.get(edge.to)!)).length
  const gap = Math.max(GAP_X, 60 + sameLayer * 14)
  const longEdges = graph.edges.filter((edge) => depth(owner.get(edge.to)!) - depth(owner.get(edge.from)!) > 1).length
  const top = PADDING + longEdges * 24
  const height = top + PADDING + Math.max(...layers.map((layer) => layer.length)) * (ARCHITECTURE_NODE_HEIGHT + GAP_Y) - GAP_Y
  const width = PADDING * 2 + layers.length * (ARCHITECTURE_NODE_WIDTH + gap)
  const nodes = layers.flatMap((layer, level) => layer.map((node, index) => ({
    ...node, x: PADDING + level * (ARCHITECTURE_NODE_WIDTH + gap),
    y: top + (height - top - PADDING - (layer.length * (ARCHITECTURE_NODE_HEIGHT + GAP_Y) - GAP_Y)) / 2 + index * (ARCHITECTURE_NODE_HEIGHT + GAP_Y),
  })))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let sideLane = 0, topLane = 0
  const edges = graph.edges.map((edge): GraphEdge => {
    const a = byId.get(edge.from)!, b = byId.get(edge.to)!
    const x1 = a.x + ARCHITECTURE_NODE_WIDTH, y1 = a.y + ARCHITECTURE_NODE_HEIGHT / 2
    const y2 = b.y + ARCHITECTURE_NODE_HEIGHT / 2
    if (a.x === b.x) {
      const lane = x1 + 30 + sideLane++ * 14
      const targetY = edge.from === edge.to ? y2 + 24 : y2
      return { ...edge, path: `M ${x1} ${y1} H ${lane} V ${targetY} H ${x1}`, labelX: lane, labelY: (y1 + targetY) / 2 - 6 }
    }
    if (b.x - a.x > ARCHITECTURE_NODE_WIDTH + gap) {
      const lane = PADDING + topLane++ * 24
      return { ...edge, path: `M ${x1} ${y1} H ${x1 + 16} V ${lane} H ${b.x - 16} V ${y2} H ${b.x}`, labelX: (x1 + b.x) / 2, labelY: lane - 5 }
    }
    const mid = (x1 + b.x) / 2
    return { ...edge, path: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${b.x} ${y2}`, labelX: mid, labelY: (y1 + y2) / 2 - 6 }
  })
  return { nodes, edges, width, height }
}
