/**
 * A browser Studio client's own log lines, forwarded to `POST /log`.
 *
 * A browser tab has no `desktop.jsonl` and no local socket, so this is its
 * only sink. Two things used to send lines nowhere at all: the route refuses
 * anything sent before sign-in (there is no subject to attribute it to yet),
 * and it refuses a caller that is over its budget -- and the client ignored
 * the status either way, so the lines that describe a failing sign-in were
 * exactly the ones discarded.
 *
 * Refused lines are therefore held and replayed once the route accepts again.
 * The buffer is bounded, and what it overflows is reported on replay rather
 * than passed over in silence.
 *
 * Sign-in is a full page load, which wipes memory, and it comes right after
 * the refused lines that explain it. So every line the server has not yet
 * accepted, whether refused or still in flight, is kept in `sessionStorage`
 * (per tab, survives a page load) and the next page's forwarder replays it.
 * Each line carries `fields.client_ts`, the page's own time, because a
 * replayed line reaches the server long after it happened, and
 * `fields.line_id`, because a line still in flight when the page left may
 * have been written already: the server skips an id it has seen.
 */

/** Lines held while the route is refusing. Small: this is a diagnostic tail, not a queue. */
const MAX_BUFFERED = 200

/** The `sessionStorage` key the unaccepted lines survive a page load under. */
export const PENDING_STORAGE_KEY = 'ion.browserLogForward.pending.v1'

export interface ForwardableLine {
  level: string
  tag: string
  msg: string
  fields?: Record<string, unknown>
}

type PostFn = (line: ForwardableLine) => Promise<{ status: number }>

/** The slice of the Web Storage API the forwarder uses. */
export type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The real transport: the `ion_session` cookie rides along automatically. */
const defaultPost: PostFn = async (line) => {
  const res = await fetch('/log', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(line),
  })
  return { status: res.status }
}

/** This tab's `sessionStorage`, or none where the page has no storage (a test, a locked-down browser). */
function defaultStorage(): PendingStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    // silent-ok: storage access can throw (disabled storage); the forwarder then keeps lines in memory only
    return null
  }
}

interface PendingLine {
  id: number
  line: ForwardableLine
  /** False while its first send is in flight; true once refused, failed, or carried over from an earlier page. */
  held: boolean
}

interface SavedState {
  lines: ForwardableLine[]
  overflowed: number
}

const isRefusal = (status: number): boolean => status === 401 || status === 429 || status === 0

export class BrowserLogForwarder {
  private pending: PendingLine[] = []
  private overflowed = 0
  private replaying = false
  private nextId = 0

  constructor(
    private readonly post: PostFn = defaultPost,
    private readonly storage: PendingStorage | null = defaultStorage(),
  ) {
    const saved = this.load()
    this.overflowed = saved.overflowed
    for (const line of saved.lines) this.pending.push({ id: this.nextId++, line, held: true })
  }

  /** Send one line, holding it for replay when the server will not take it yet. */
  send(line: ForwardableLine): void {
    // line_id lets the server recognize a line it already wrote when a later
    // page re-sends one whose reply the page did not live to read.
    const stamped: ForwardableLine = {
      ...line,
      fields: { ...line.fields, client_ts: new Date().toISOString(), line_id: crypto.randomUUID() },
    }
    const entry: PendingLine = { id: this.nextId++, line: stamped, held: false }
    this.pending.push(entry)
    this.save()
    void this.post(stamped)
      .then(({ status }) => {
        if (isRefusal(status)) {
          this.hold(entry)
          return
        }
        this.accepted(entry)
        // Accepted: anything held while it was refusing can go now.
        void this.replay()
      })
      .catch(() => {
        // A network failure is the same situation as a refusal: hold it, and
        // let the next accepted line carry the backlog.
        this.hold(entry)
      })
  }

  private hold(entry: PendingLine): void {
    entry.held = true
    this.trim()
    this.save()
  }

  private accepted(entry: PendingLine): void {
    this.pending = this.pending.filter((p) => p.id !== entry.id)
    this.save()
  }

  /** Caps held lines, dropping the oldest. A line still in flight is not held yet and never dropped here. */
  private trim(): void {
    let held = this.pending.filter((p) => p.held).length
    while (held > MAX_BUFFERED) {
      const oldest = this.pending.findIndex((p) => p.held)
      this.pending.splice(oldest, 1)
      this.overflowed += 1
      held -= 1
    }
  }

  /**
   * Drain held lines oldest-first, stopping at the first line the server
   * still refuses so the rest keep their order.
   */
  private async replay(): Promise<void> {
    if (this.replaying) return
    this.replaying = true
    try {
      for (let next = this.pending.find((p) => p.held); next; next = this.pending.find((p) => p.held)) {
        const { status } = await this.post(next.line).catch(() => ({ status: 0 }))
        if (isRefusal(status)) return
        this.accepted(next)
      }
      if (this.overflowed > 0) {
        const lost = this.overflowed
        this.overflowed = 0
        this.save()
        await this.post({
          level: 'WARN',
          tag: 'log-forward',
          msg: 'browser log lines were dropped while the server would not accept them',
          fields: { log_suppressed: lost, buffer_limit: MAX_BUFFERED, client_ts: new Date().toISOString() },
        }).catch(() => ({ status: 0 }))
      }
    } finally {
      this.replaying = false
    }
  }

  private load(): SavedState {
    const raw = this.storage?.getItem(PENDING_STORAGE_KEY)
    if (!raw) return { lines: [], overflowed: 0 }
    try {
      const parsed = JSON.parse(raw) as Partial<SavedState>
      return {
        lines: Array.isArray(parsed.lines) ? parsed.lines.filter(isForwardableLine) : [],
        overflowed: typeof parsed.overflowed === 'number' ? parsed.overflowed : 0,
      }
    } catch {
      // silent-ok: a corrupt entry is replaced on the next save; its lines are unrecoverable either way
      return { lines: [], overflowed: 0 }
    }
  }

  private save(): void {
    if (!this.storage) return
    try {
      if (this.pending.length === 0 && this.overflowed === 0) {
        this.storage.removeItem(PENDING_STORAGE_KEY)
        return
      }
      const state: SavedState = { lines: this.pending.map((p) => p.line), overflowed: this.overflowed }
      this.storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(state))
    } catch {
      // silent-ok: storage full or disabled; the lines stay in memory for this page
    }
  }

  /** TEST ONLY: how many lines are waiting, and how many were lost. */
  _stateForTest(): { buffered: number; overflowed: number } {
    return { buffered: this.pending.filter((p) => p.held).length, overflowed: this.overflowed }
  }
}

function isForwardableLine(v: unknown): v is ForwardableLine {
  if (!v || typeof v !== 'object') return false
  const l = v as Record<string, unknown>
  return typeof l.level === 'string' && typeof l.tag === 'string' && typeof l.msg === 'string'
}
