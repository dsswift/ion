/**
 * Keeps a browser tab's session honest across sleep.
 *
 * A tab left open overnight, a laptop that slept, or a background tab all wake
 * up holding a session the server may have forgotten. If everything the page
 * does on waking fails with 401 first, the person sees a flood of errors and a
 * half-working app. This asks one question first -- does `GET /auth/session`
 * still say my session works? -- and acts on the answer before anything else
 * the page does:
 *
 *   - yes: carry on. The socket is re-checked by the host's own reconnect.
 *   - unknown or expired (401): go straight to the silent sign-in
 *     (`/auth/login?silent=1`), which the provider answers from the person's
 *     existing sign-in with nothing on screen; when that sign-in has ended
 *     too, the server sends them on to the interactive sign-in page.
 *   - the sign-in service could not be reached (503, or no network): the session is
 *     kept, nothing is thrown away, and the check runs again.
 *
 * The check runs when the tab becomes visible, when the browser comes back
 * online, and when a timer notices the page was frozen for a long time (a
 * sleeping laptop fires no event, but a timer that should have ticked every
 * 15 seconds did not for minutes).
 */

/** What the host does with the answer. Injected so the rules are testable. */
export interface SessionGuardDeps {
  /** `GET /auth/session`'s status, or 0 when it could not be reached. */
  checkSession(): Promise<number>
  /** Navigates the page to the silent sign-in. */
  signInSilently(): void
  /** Whether the tab is in front of the person. */
  isVisible(): boolean
  now(): number
  log(level: 'info' | 'warn', msg: string, fields?: Record<string, unknown>): void
}

/** The tick the idle detector runs on, and how late a tick must be before the page counts as having slept. */
export const TICK_MS = 15_000
export const SLEPT_AFTER_MS = 60_000

/** Waits between re-checks while the sign-in service cannot be reached: 2 s doubling to 1 min. */
const RECHECK_START_MS = 2_000
const RECHECK_MAX_MS = 60_000

/** One check at a time, and a guard against signing in over and over. */
const MIN_SIGN_IN_GAP_MS = 20_000

export class SessionGuard {
  private checking = false
  private lastTickMs: number
  private failures = 0
  private lastSignInMs = -Infinity
  private recheckTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: SessionGuardDeps) {
    this.lastTickMs = deps.now()
  }

  /**
   * Called every `TICK_MS` by a timer. Returns true when this tick arrived
   * long after it was due, which means the page was frozen: the caller then
   * checks the session. It only reports; the check is the caller's to await.
   */
  tick(): boolean {
    const now = this.deps.now()
    const late = now - this.lastTickMs - TICK_MS
    this.lastTickMs = now
    return late >= SLEPT_AFTER_MS - TICK_MS
  }

  /** True while a sign-in has been started and the page is about to leave. */
  get signingIn(): boolean {
    return this.deps.now() - this.lastSignInMs < MIN_SIGN_IN_GAP_MS
  }

  async check(reason: string): Promise<void> {
    if (this.checking || this.signingIn) return
    this.checking = true
    try {
      const status = await this.deps.checkSession()
      if (status === 200) {
        this.failures = 0
        this.deps.log('info', 'session still good after waking', { reason })
        return
      }
      if (status === 401) {
        this.lastSignInMs = this.deps.now()
        this.deps.log('info', 'session gone while away; signing in silently', { reason })
        this.deps.signInSilently()
        return
      }
      // 503, or the network is down: keep the session and look again, slowly.
      this.failures += 1
      const wait = Math.min(RECHECK_MAX_MS, RECHECK_START_MS * 2 ** (this.failures - 1))
      this.deps.log('warn', 'could not check the session; will look again', { reason, status, retry_in_ms: wait })
      this.scheduleRecheck(wait)
    } finally {
      this.checking = false
    }
  }

  private scheduleRecheck(ms: number): void {
    if (this.recheckTimer) return
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null
      if (this.deps.isVisible()) void this.check('recheck')
    }, ms)
  }

  stop(): void {
    if (this.recheckTimer) clearTimeout(this.recheckTimer)
    this.recheckTimer = null
  }
}

/** The real dependencies, bound to this page. */
export function browserSessionGuardDeps(log: SessionGuardDeps['log']): SessionGuardDeps {
  return {
    checkSession: async () => {
      try {
        const res = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' })
        return res.status
      } catch {
        return 0
      }
    },
    signInSilently: () => {
      const returnTo = window.location.pathname + window.location.search
      window.location.href = `/auth/login?silent=1&returnTo=${encodeURIComponent(returnTo)}`
    },
    isVisible: () => document.visibilityState === 'visible',
    now: () => Date.now(),
    log,
  }
}
