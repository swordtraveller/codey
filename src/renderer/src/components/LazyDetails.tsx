import { createContext, useContext, useState, type ReactNode } from 'react'

/** A row keeps expansion preferences when virtualization unmounts its DOM. */
export const DetailsStateContext = createContext<Map<string, boolean> | null>(null)

export function LazyDetails({ summary, children, className, stateKey = 'tool' }: {
  summary: ReactNode
  children: () => ReactNode
  className?: string
  stateKey?: string
}): React.JSX.Element {
  const states = useContext(DetailsStateContext)
  const [open, setOpen] = useState(() => states?.get(stateKey) ?? false)
  return (
    <details className={className} open={open} onToggle={(event) => {
      const next = event.currentTarget.open
      states?.set(stateKey, next)
      setOpen(next)
    }}>
      <summary>{summary}</summary>
      {open && children()}
    </details>
  )
}
