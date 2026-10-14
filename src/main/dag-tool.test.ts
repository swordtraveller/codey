import { describe, expect, it } from 'vitest'
import { applyDagAction } from './dag-tool'
import type { DagNode } from '../shared/dag'

const node = (id: string, dependsOn: string[] = [], status: DagNode['status'] = 'pending'): DagNode => ({ id, name: id, dependsOn, status })

describe('DAG reducer', () => {
  it('creates a fork and merge graph and reports ready nodes', () => {
    const result = applyDagAction([], { action: 'set', nodes: [
      { id: 'inspect', name: 'Inspect', dependsOn: [] },
      { id: 'backend', name: 'Backend', dependsOn: ['inspect'] },
      { id: 'frontend', name: 'Frontend', dependsOn: ['inspect'] },
      { id: 'verify', name: 'Verify', dependsOn: ['backend', 'frontend'] },
    ] })
    expect(result.readyNodeIds).toEqual(['inspect'])
    expect(result.nodes.map(({ id, status }) => [id, status])).toEqual([['inspect', 'pending'], ['backend', 'pending'], ['frontend', 'pending'], ['verify', 'pending']])
    expect(() => applyDagAction(result.nodes, { action: 'update', updates: [{ id: 'verify', status: 'in_progress' }] })).toThrow('dependencies')
    const progressed = applyDagAction(result.nodes, { action: 'update', updates: [{ id: 'inspect', status: 'finished' }, { id: 'backend', status: 'in_progress' }] })
    expect(progressed.readyNodeIds).toEqual(['frontend'])
  })
  it('rejects cycles and missing dependencies atomically', () => {
    expect(() => applyDagAction([], { action: 'set', nodes: [{ id: 'a', name: 'A', dependsOn: ['b'] }, { id: 'b', name: 'B', dependsOn: ['a'] }] })).toThrow('cycle')
    expect(() => applyDagAction([], { action: 'set', nodes: [{ id: 'a', name: 'A', dependsOn: ['missing'] }] })).toThrow('Missing')
  })
  it('retains node state when structure is replaced', () => {
    const current = [node('a', [], 'finished'), node('b', ['a'], 'pending')]
    const result = applyDagAction(current, { action: 'set', nodes: [{ id: 'a', name: 'Renamed', dependsOn: [] }, { id: 'b', name: 'B', dependsOn: ['a'] }] })
    expect(result.nodes[0]).toMatchObject({ id: 'a', name: 'Renamed', status: 'finished' })
  })
})
