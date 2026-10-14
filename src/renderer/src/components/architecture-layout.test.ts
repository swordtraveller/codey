import { describe, expect, it } from 'vitest'
import type { ArchitectureGraph } from '../../../shared/architecture'
import { layoutArchitecture, ARCHITECTURE_NODE_WIDTH, ARCHITECTURE_NODE_HEIGHT } from './architecture-layout'

describe('architecture layout', () => {
  it('keeps cycles, self references, disconnected modules and long edges within the canvas', () => {
    const value: ArchitectureGraph = {
      nodes: ['a', 'b', 'c', 'd', 'e', 'isolated'].map((id) => ({ id, label: id })),
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }, { from: 'd', to: 'e' }, { from: 'a', to: 'e' }, { from: 'd', to: 'd' }],
    }
    const result = layoutArchitecture(value)
    expect(result).toEqual(layoutArchitecture(value))
    expect(result.nodes).toHaveLength(6)
    expect(result.edges).toHaveLength(7)
    expect(result.nodes.map((node) => node.id).sort()).toEqual(value.nodes.map((node) => node.id).sort())
    for (const node of result.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.y).toBeGreaterThanOrEqual(0)
      expect(node.x + ARCHITECTURE_NODE_WIDTH).toBeLessThanOrEqual(result.width)
      expect(node.y + ARCHITECTURE_NODE_HEIGHT).toBeLessThanOrEqual(result.height)
      for (const other of result.nodes.filter((other) => other !== node)) {
        expect(node.x + ARCHITECTURE_NODE_WIDTH <= other.x || other.x + ARCHITECTURE_NODE_WIDTH <= node.x
          || node.y + ARCHITECTURE_NODE_HEIGHT <= other.y || other.y + ARCHITECTURE_NODE_HEIGHT <= node.y).toBe(true)
      }
    }
    expect(result.edges.every((edge) => !/NaN|undefined|Infinity/.test(edge.path))).toBe(true)
  })
})
