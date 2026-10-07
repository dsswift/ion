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
 * A refused line never turns into a request storm. On 401 the forwarder
 * stops sending altogether and holds everything: the person has no session,
 * the page is already on its way to sign-in, and every further request would
 * only fail and fill the console. It resumes when told the connection is
 * authenticated again (`resume()`). Any other failure (429, a 5xx, the
 * network) backs off with a growing delay and a cap on requests in flight, so
 * a server that is down or throttling is asked rarely, not constantly.
 *
 * Each line carries `fields.client_ts`, the page's own time, because a
 * replayed line reaches the server long after it happened, and
 * `fields.line_id`, because a line still in flight when the page left may
 * have been written already: the server skips an id it has seen.
 */

/** Lines held while the route is refusing. Small: this is a diagnostic tail, not a queue. */
const MAX_BUFFERED = 200

/** Requests allowed in flight at once. A burst of lines waits its turn instead of opening a connection each. */
const MAX_IN_FLIGHT = 4

/** The wait after a failure that is not a sign-in problem, doubling per consecutive failure up to the cap. */
const BACKOFF_START_MS = 2_000
const BACKOFF_MAX_MS = 60_000

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
  /** True while the line waits to be sent (never sent, refused, or carried over from an earlier page); false while its send is in flight. */
  held: boolean
}

interface SavedState {
  lines: ForwardableLine[]
  overflowed: number
}

/** The route refused this line or could not be reached: hold it, do not drop it. */
const isRefusal = (status: number): boolean => status === 401 || status === 429 || status === 0 || status >= 500

/** The server does not know this tab's session. Not a failure to retry: the page signs in again. */
const isSignedOut = (status: number): boolean => status === 401

export class BrowserLogForwarder {
  private pending: PendingLine[] = []
  private overflowed = 0
  private replaying = false
  private nextId = 0
  private inFlight = 0
  /** True after a 401, until `resume()`: nothing is sent, so nothing can fail. */
  private signedOut = false
  private failures = 0
  private backoffUntilMs = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly post: PostFn = defaultPost,
    private readonly storage: PendingStorage | null = defaultStorage(),
    private readonly now: () => number = Date.now,
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
      fields: { ...line.fields, client_ts: new Date(this.now()).toISOString(), line_id: crypto.randomUUID() },
    }
    this.pending.push({ id: this.nextId++, line: stamped, held: true })
    this.trim()
    this.save()
    this.drain()
  }

  /**
   * The connection is authenticated again: send what was held. Called by the
   * host when it is welcomed, which is the one moment a 401 stops being true.
   */
  resume(): void {
    this.signedOut = false
    this.failures = 0
    this.backoffUntilMs = 0
    this.drain()
  }

  /** Whether the forwarder is waiting for a sign-in. For the host's log line and for tests. */
  get isSignedOut(): boolean {
    return this.signedOut
  }

  /**
   * Send held lines oldest-first, a few at a time, unless the person is signed
   * out or a backoff is running. A line in flight is not held, so it is never
   * sent twice by the same drain.
   */
  private drain(): void {
    if (this.signedOut) return
    const wait = this.backoffUntilMs - this.now()
    if (wait > 0) {
      this.scheduleDrain(wait)
      return
    }
    while (this.inFlight < MAX_IN_FLIGHT) {
      const next = this.pending.find((p) => p.held)
      if (!next) return
      next.held = false
      this.inFlight += 1
      void this.post(next.line)
        .catch(() => ({ status: 0 }))
        .then(({ status }) => this.settle(next, status))
    }
  }

  private settle(entry: PendingLine, status: number): void {
    this.inFlight -= 1
    if (isSignedOut(status)) {
      this.hold(entry)
      this.signedOut = true
      return
    }
    if (isRefusal(status)) {
      this.hold(entry)
      this.failures += 1
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (this.failures - 1))
      this.backoffUntilMs = this.now() + delay
      this.scheduleDrain(delay)
      return
    }
    this.failures = 0
    this.accepted(entry)
    this.drain()
    if (this.pending.every((p) => !p.held) && this.inFlight === 0) void this.reportOverflow()
  }

  private scheduleDrain(ms: number): void {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.drain()
    }, ms)
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

  /** Says once, after the backlog is out, how many lines the buffer had to drop. */
  private async reportOverflow(): Promise<void> {
    if (this.overflowed === 0 || this.replaying) return
    this.replaying = true
    const lost = this.overflowed
    try {
      const { status } = await this.post({
        level: 'WARN',
        tag: 'log-forward',
        msg: 'browser log lines were dropped while the server would not accept them',
        fields: { log_suppressed: lost, buffer_limit: MAX_BUFFERED, client_ts: new Date(this.now()).toISOString() },
      }).catch(() => ({ status: 0 }))
      if (!isRefusal(status)) {
        this.overflowed = 0
        this.save()
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

  /** TEST ONLY: stop the backoff timer. */
  _stopForTest(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }
}

function isForwardableLine(v: unknown): v is ForwardableLine {
  if (!v || typeof v !== 'object') return false
  const l = v as Record<string, unknown>
  return typeof l.level === 'string' && typeof l.tag === 'string' && typeof l.msg === 'string'
}
