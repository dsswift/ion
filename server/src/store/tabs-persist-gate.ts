/**
 * Change gate for the tab manifest save and the `studio:tabs-sync` publish.
 *
 * The persistence subscriber runs on any change to the state it watches. A
 * streaming conversation replaces its conversation pane many times a second
 * while nothing the manifest records moves: the manifest keeps a message
 * count, never the streamed text. Each of those ticks used to rewrite
 * tabs.json and push the whole tab list to every Studio client. A gate
 * compares what a tick would write or send with what it last let through,
 * and passes only a real difference.
 *
 * Settled history is compared by array identity and never serialized for
 * the comparison. It is most of the manifest, and the store replaces the
 * array whenever its contents change.
 */
export interface GateResult {
  /** The candidate differs from the last one let through. */
  changed: boolean
  /** The settled history array is not the one last let through. */
  settledChanged: boolean
  /** Unchanged candidates held back since the last one let through. */
  skipped: number
}

export class TabsChangeGate {
  private lastBody: string | null = null
  private lastSettled: unknown = undefined
  private held = 0

  /**
   * Offer one candidate: `body` is its serialized form without the settled
   * history, `settled` the store's settled history array. Records the
   * candidate as the new baseline when it differs.
   */
  offer(body: string, settled: unknown): GateResult {
    const settledChanged = settled !== this.lastSettled
    const changed = settledChanged || body !== this.lastBody
    if (!changed) {
      this.held++
      return { changed, settledChanged, skipped: this.held }
    }
    const skipped = this.held
    this.lastBody = body
    this.lastSettled = settled
    this.held = 0
    return { changed, settledChanged, skipped }
  }
}
