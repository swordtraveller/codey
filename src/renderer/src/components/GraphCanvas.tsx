import { useId, type ReactNode } from 'react'

export type GraphEdge = { from: string; to: string; path: string; label?: string; labelX?: number; labelY?: number }

/** Shared native scrolling canvas for execution plans and code architecture. */
export function GraphCanvas({ width, height, edges, label, children }: {
  width: number; height: number; edges: GraphEdge[]; label: string; children: ReactNode
}): React.JSX.Element {
  const markerId = 'graph-arrow-' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  return <div className="dag-viewport" tabIndex={0} role="region" aria-label={label}>
    <div className="dag-canvas" style={{ width, height }}>
      <svg className="dag-edges" width={width} height={height} aria-hidden="true">
        <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker></defs>
        {edges.map((edge) => <g key={edge.from + ':' + edge.to}>
          <path d={edge.path} fill="none" stroke="currentColor" strokeWidth="1.5" markerEnd={'url(#' + markerId + ')'} />
          {edge.label && <text className="graph-edge-label" x={edge.labelX} y={edge.labelY} textAnchor="middle">
            {edge.label.length > 16 ? edge.label.slice(0, 15) + '…' : edge.label}
          </text>}
        </g>)}
      </svg>
      {children}
    </div>
  </div>
}
