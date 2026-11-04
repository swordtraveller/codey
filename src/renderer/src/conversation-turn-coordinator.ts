/** Keeps a new turn behind both the previous IPC and its renderer cleanup. */
export class ConversationTurnCoordinator {
  private turns = new Map<string, Promise<boolean>>()
  private interruptions = new Map<string, symbol>()

  constructor(private readonly onSettled: () => void) {}

  hasTurn(key: string): boolean {
    return this.turns.has(key)
  }

  isBusy(key: string): boolean {
    return this.hasTurn(key) || this.interruptions.has(key)
  }

  isInterrupting(key: string): boolean {
    return this.interruptions.has(key)
  }

  run(key: string, action: () => Promise<boolean>): Promise<boolean> {
    if (this.isBusy(key)) return Promise.resolve(false)
    let resolve!: (sent: boolean) => void
    let reject!: (error: unknown) => void
    const turn = new Promise<boolean>((yes, no) => { resolve = yes; reject = no })
    // Reserve synchronously, before action can publish an idle/running update.
    this.turns.set(key, turn)
    void (async () => {
      try {
        resolve(await action())
      } catch (error) {
        reject(error)
      } finally {
        this.turns.delete(key)
        this.onSettled()
      }
    })()
    return turn
  }

  async runNow(key: string, stop: () => Promise<void>, dispatch: () => Promise<boolean>): Promise<boolean> {
    if (this.interruptions.has(key)) return false
    const token = Symbol()
    this.interruptions.set(key, token)
    const previous = this.turns.get(key)
    const release = (): void => {
      if (this.interruptions.get(key) === token) this.interruptions.delete(key)
    }
    try {
      await stop()
      // Stop acceptance is not completion. A failed previous turn still releases the queue.
      await previous?.catch(() => undefined)
      release()
      // No await between releasing the reservation and starting the chosen turn.
      return await dispatch()
    } finally {
      release()
      this.onSettled()
    }
  }
}
