import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

const PlanExpansionContext = createContext<{ openId: string | null; setOpenId: (id: string | null) => void } | null>(null)

/** One accordion for Todo/DAG snapshots, including virtualized and live cards. */
export function PlanCardsProvider({ latestId, children }: { latestId: string | null; children: ReactNode }): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(latestId)
  useEffect(() => { setOpenId(latestId) }, [latestId])
  const context = useMemo(() => ({ openId, setOpenId }), [openId])
  return <PlanExpansionContext.Provider value={context}>{children}</PlanExpansionContext.Provider>
}

export const usePlanCardExpansion = () => useContext(PlanExpansionContext)
