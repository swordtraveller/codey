import type { ChatMessage, ConversationMessagePage } from '../../shared/types'

export type ConversationPageState = {
  messages: ChatMessage[]
  before: string | null
  loaded: boolean
  loading: boolean
  loadingOlder: boolean
  error: string | null
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** One active conversation owns this cache. Responses cannot leak into another conversation. */
export class ConversationPageLoader {
  private state: ConversationPageState = { messages: [], before: null, loaded: false, loading: false, loadingOlder: false, error: null }
  private listeners = new Set<() => void>()
  private failedOperation: 'latest' | 'older' = 'latest'
  private refreshVersion = 0
  private olderRequest: Promise<void> | undefined
  private optimistic: { message: ChatMessage; previousUserId?: string } | undefined
  constructor(private readonly read: (before: string | null) => Promise<ConversationMessagePage>) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = (): ConversationPageState => this.state
  private update(patch: Partial<ConversationPageState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  addOptimistic(message: ChatMessage): void {
    this.optimistic = { message, previousUserId: [...this.state.messages].reverse().find((item) => item.role === 'user')?.id }
    this.update({ messages: [...this.state.messages, message] })
  }
  ensureMessage = async (id: string, cancelled: () => boolean = () => false): Promise<void> => {
    if (!this.state.loaded) await this.refresh()
    while (!cancelled() && !this.state.messages.some((message) => message.id === id)) {
      const before = this.state.before
      if (!before) throw new Error('Conversation message no longer exists')
      await this.loadOlder()
      if (this.state.error) throw new Error(this.state.error)
      if (this.state.before === before) throw new Error('Conversation pagination made no progress')
    }
  }
  retry = (): Promise<void> => this.failedOperation === 'older' ? this.loadOlder() : this.refresh()
  refresh = async (): Promise<void> => {
    const version = ++this.refreshVersion
    this.update({ loading: !this.state.loaded, error: null })
    try {
      let page = await this.read(null)
      let fetched = page.messages
      // If many turns arrived while fetching, fill the gap before joining cached history.
      const cachedIds = new Set(this.state.messages.map((message) => message.id))
      while (this.state.loaded && cachedIds.size && page.before && !fetched.some((message) => cachedIds.has(message.id))) {
        if (version !== this.refreshVersion) return
        const older = await this.read(page.before)
        if (older.before === page.before) throw new Error('Conversation pagination made no progress')
        fetched = [...older.messages, ...fetched]
        page = older
      }
      if (version !== this.refreshVersion) return
      const first = fetched[0]?.id
      const overlap = this.state.messages.findIndex((message) => message.id === first)
      let messages = overlap >= 0 ? [...this.state.messages.slice(0, overlap), ...fetched] : fetched
      const lastUser = [...fetched].reverse().find((message) => message.role === 'user')
      if (this.optimistic && lastUser?.id === this.optimistic.previousUserId) messages = [...messages, this.optimistic.message]
      else this.optimistic = undefined
      this.update({ messages, before: overlap >= 0 ? this.state.before : page.before, loaded: true, loading: false, error: null })
    } catch (error) {
      if (version === this.refreshVersion) { this.failedOperation = 'latest'; this.update({ loading: false, error: errorText(error) }) }
    }
  }
  loadOlder = (): Promise<void> => {
    if (this.olderRequest) return this.olderRequest
    const before = this.state.before
    if (!this.state.loaded || !before) return Promise.resolve()
    this.update({ loadingOlder: true, error: null })
    const request = (async () => {
      try {
        const page = await this.read(before)
        if (this.state.before !== before) return
        if (page.before === before) throw new Error('Conversation pagination made no progress')
        const existing = new Set(this.state.messages.map((message) => message.id))
        this.update({ messages: [...page.messages.filter((message) => !existing.has(message.id)), ...this.state.messages], before: page.before })
      } catch (error) {
        this.failedOperation = 'older'
        this.update({ error: errorText(error) })
      } finally {
        this.update({ loadingOlder: false })
      }
    })()
    this.olderRequest = request
    void request.finally(() => { if (this.olderRequest === request) this.olderRequest = undefined })
    return request
  }
}
