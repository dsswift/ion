// @vitest-environment jsdom
/**
 * Pins the server-held session flow's two host-level acceptance criteria:
 * `studio_hello` carries `clientKind: 'web'` and `{kind:'session'}` (no
 * token -- the server resolves identity from the `ion_session` cookie that
 * rode along with the WebSocket upgrade), and a `studio_refused
 * {reason:'unauthorized'}` navigates the whole page to `/auth/login`
 * instead of retrying in place.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../web-storage', () => ({
  getDeviceSettings: vi.fn(async () => ({})),
  setDeviceSetting: vi.fn(async () => {}),
  getEnvCache: vi.fn(async () => null),
  setEnvCache: vi.fn(async () => {}),
}))

import { BrowserStudioHost } from '../BrowserStudioHost'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

class FakeWebSocket {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 0
  sent: string[] = []
  private listeners: Record<string, Array<(ev: { data?: string; code?: number; reason?: string }) => void>> = {}

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, cb: (ev: { data?: string; code?: number; reason?: string }) => void): void {
    ;(this.listeners[type] ??= []).push(cb)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    for (const cb of this.listeners.open ?? []) cb({})
  }

  simulateMessage(data: string): void {
    for (const cb of this.listeners.message ?? []) cb({ data })
  }

  /** A close event arriving on THIS specific socket instance, whether or not it is still the host's current one. */
  simulateClose(code = 1005, reason = ''): void {
    this.readyState = 3
    for (const cb of this.listeners.close ?? []) cb({ code, reason })
  }

  simulateError(): void {
    for (const cb of this.listeners.error ?? []) cb({})
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket
  // jsdom's window.location is not directly assignable; BrowserStudioHost
  // only ever reads pathname/search/origin and writes `.href` -- stub just
  // that write so the redirect is observable without a real navigation.
  Object.defineProperty(window, 'location', {
    value: { origin: 'http://ion.example.test', pathname: '/some/tab', search: '?x=1', href: '' },
    writable: true,
  })
})

describe('BrowserStudioHost boot-time environment id', () => {
  // Regression for a real production symptom: model.list's own boot-time
  // refresh (and any other caller that fires from a React effect on mount)
  // calls `host.send(LOCAL_ENVIRONMENT_ID, ...)` before `registry.ts` has
  // finished awaiting `connectEnvironment()`. `send()`'s guard compares the
  // target against `this.environmentId`; if that field starts at some other
  // placeholder value, the call is dropped -- not queued -- because the
  // guard fires before the "no open connection yet" queueing path is ever
  // reached. Observed live: the model picker stayed on a stale value across
  // every browser Studio reload because its bootstrap fetch lost this race
  // on (effectively) every page load.
  it('queues and delivers a send() targeting LOCAL_ENVIRONMENT_ID issued before connectEnvironment() is ever called', async () => {
    const host = new BrowserStudioHost()

    // The race: a caller already knows the one id this host will ever
    // answer to, and addresses it directly -- before anything has told the
    // host to connect at all.
    host.send(LOCAL_ENVIRONMENT_ID, { type: 'studio_action', id: 'boot-1', action: 'model.list', args: [] })

    await host.connectEnvironment(LOCAL_ENVIRONMENT_ID, 'This Server', { kind: 'local' })
    await flush()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateMessage(welcomeFrame())

    const sentActions = ws.sent.map((raw) => JSON.parse(raw) as { action?: string }).filter((f) => f.action)
    expect(sentActions).toContainEqual(expect.objectContaining({ action: 'model.list' }))
  })
})

describe('BrowserStudioHost hello', () => {
  it('carries clientKind "web" and a session credential -- no token', async () => {
    const host = new BrowserStudioHost()
    await host.connectEnvironment('local', 'This Server', { kind: 'local' })
    await flush()
    const ws = FakeWebSocket.instances[0]
    expect(ws).toBeDefined()
    ws.simulateOpen()

    expect(ws.sent).toHaveLength(1)
    const hello = JSON.parse(ws.sent[0]) as { type: string; clientKind: string; credential: unknown; capabilities: string[] }
    expect(hello.type).toBe('studio_hello')
    expect(hello.clientKind).toBe('web')
    expect(hello.credential).toEqual({ kind: 'session' })
    // The hello must advertise exactly what the host reports -- pinning a
    // literal list here instead would fail every time a domain is bridged,
    // which says nothing about the hello contract. Membership of the
    // wire-routed group is asserted; the bridged `*Direct` capabilities have
    // their own coverage in browser-shell-bridge.test.ts.
    // The UI capabilities the host reports, plus `wire-ping`, which names no
    // UI at all: it tells the server this client answers `studio_ping`, and
    // the server probes no connection without it.
    expect(hello.capabilities).toEqual([...host.capabilities(), 'wire-ping'])
    expect(hello.capabilities).toEqual(expect.arrayContaining(['terminal', 'git', 'files', 'questions', 'graph', 'wire-ping']))
  })
})

describe('BrowserStudioHost unauthorized refusal', () => {
  it('navigates to /auth/login with the current path as returnTo, rather than retrying in place', async () => {
    const host = new BrowserStudioHost()
    await host.connectEnvironment('local', 'This Server', { kind: 'local' })
    await flush()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    ws.simulateMessage(JSON.stringify({ type: 'studio_refused', reason: 'unauthorized' }))

    expect(window.location.href).toBe(`/auth/login?returnTo=${encodeURIComponent('/some/tab?x=1')}`)
  })
})

/** A minimally-valid studio_welcome frame per codec.ts's decoder, with the server's own (non-'local') self-declared environmentId. */
function welcomeFrame(): string {
  return JSON.stringify({
    type: 'studio_welcome',
    protocolVersion: 1,
    environmentId: 'a1b2c3d4-uuid-not-local',
    label: 'Test Server',
    platform: 'linux',
    serverVersion: '0.0.0',
    engineVersion: '0.0.0',
    capabilities: [],
    principal: { subject: 'local:test' },
    scopes: [],
    enterprisePolicy: null,
    settingsHiddenGroups: [], developerSurfaces: { sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: true }, policyHash: 'sha256:test',
    snapshot: {},
  })
}

describe('BrowserStudioHost environment id stability', () => {
  it('keeps send() targeting the local catalog id after studio_welcome carries the server\'s own (different) id', async () => {
    const host = new BrowserStudioHost()
    await host.connectEnvironment('local', 'This Server', { kind: 'local' })
    await flush()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    // The server's self-declared environmentId (server-id file, a random
    // UUID) is never the client's local catalog id -- simulate the welcome
    // a real server sends.
    ws.simulateMessage(welcomeFrame())

    host.send('local', { type: 'studio_action', id: '1', action: 'toggleTerminal', args: [] } as never)
    expect(ws.sent.some((s) => JSON.parse(s).type === 'studio_action')).toBe(true)
  })

  it('dispatches frame listeners with the local catalog id, not the server-declared one', async () => {
    const host = new BrowserStudioHost()
    await host.connectEnvironment('local', 'This Server', { kind: 'local' })
    await flush()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    const seen: string[] = []
    host.onFrame((environmentId) => seen.push(environmentId))
    ws.simulateMessage(welcomeFrame())

    expect(seen).toEqual(['local'])
  })
})

describe('BrowserStudioHost send() before studio_welcome', () => {
  // Regression pin for a real production bug: a caller (e.g. host-actions.ts's
  // loadSkeletonMessages studio_action) that calls send() before the
  // hello/welcome handshake completes -- the normal case on first page load,
  // or right after a reconnect -- used to have its frame silently dropped.
  // The caller's own 30s timeout then fired with no reply ever possible,
  // observed in production as "every fresh Studio session takes ~30s to
  // become interactive." Without the fix, the frame here is dropped and
  // never appears in ws.sent even after studio_welcome arrives.
  it('queues a frame sent while the socket is still CONNECTING and flushes it once studio_welcome arrives', async () => {
    const host = new BrowserStudioHost()
    await host.connectEnvironment('local', 'This Server', { kind: 'local' })
    await flush()
    const ws = FakeWebSocket.instances[0]
    // Deliberately NOT calling ws.simulateOpen() yet -- readyState is still
    // CONNECTING (0), matching the exact production moment: the previous
    // socket had just closed (page navigation) and the replacement hadn't
    // opened yet when a caller already tried to send.
    host.send('local', { type: 'studio_action', id: 'race-1', action: 'loadSkeletonMessages', args: [] } as never)
    expect(ws.sent.some((s) => JSON.parse(s).id === 'race-1')).toBe(false)

    ws.simulateOpen()
    ws.simulateMessage(welcomeFrame())

    expect(ws.sent.some((s) => JSON.parse(s).id === 'race-1')).toBe(true)
  })

  it('also queues a frame sent after the socket opens but before studio_welcome arrives', async () => {
    const host = new BrowserStudioHost()
    await host.connectEnvironment('local', 'This Server', { kind: 'local' })
    await flush()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    // The TCP/WS handshake is done, but hello/welcome hasn't completed --
    // app-level traffic must still wait so the server never sees a
    // studio_action ahead of studio_hello.
    host.send('local', { type: 'studio_action', id: 'race-2', action: 'loadSkeletonMessages', args: [] } as never)
    expect(ws.sent.some((s) => JSON.parse(s).id === 'race-2')).toBe(false)

    ws.simulateMessage(welcomeFrame())

    expect(ws.sent.some((s) => JSON.parse(s).id === 'race-2')).toBe(true)
  })

  it('does not replay a queued frame after a deliberate disconnect', async () => {
    const host = new BrowserStudioHost()
    await host.connectEnvironment('local', 'This Server', { kind: 'local' })
    await flush()
    const ws = FakeWebSocket.instances[0]

    host.send('local', { type: 'studio_action', id: 'race-3', action: 'loadSkeletonMessages', args: [] } as never)
    host.disconnectEnvironment('local')

    ws.simulateOpen()
    ws.simulateMessage(welcomeFrame())

    expect(ws.sent.some((s) => JSON.parse(s).id === 'race-3')).toBe(false)
  })
})

describe('BrowserStudioHost capabilities', () => {
  it('omits every Electron-shell-only and native-transport capability', () => {
    const host = new BrowserStudioHost()
    const caps = host.capabilities()
    for (const electronOnly of ['browser', 'deeplink', 'tray', 'notifications', 'local', 'relay', 'openExternal', 'pickFile', 'pickDirectory', 'clipboardWriteImage']) {
      expect(caps).not.toContain(electronOnly)
    }
  })

  // Regression pin for a real production symptom: every browser Studio
  // reload reset the left sidebar to closed and the surface panel to its
  // defaults, even though the server-side persistence
  // (studio-settings-actions.ts, storing into the caller's own overlay) had
  // already shipped and worked correctly for every other setting. The gate
  // that was supposed to unlock it was simply never flipped on. Observed
  // live 2026-09-16, alongside its knock-on effect: with the sidebar
  // collapsed on load, the Git panel read as "missing" even though the
  // repository was correctly detected server-side the whole time.
  it('bridges studioGetSettings/studioSetSetting, so useStudioLayout actually persists the sidebar/surface state', async () => {
    const { SHELL_INVOKE } = await import('../browser-shell-bridge')
    expect(SHELL_INVOKE).toHaveProperty('studioGetSettings')
    expect(SHELL_INVOKE).toHaveProperty('studioSetSetting')
  })
})

describe('BrowserStudioHost stale socket events', () => {
  // Regression for a real, live production defect (2026-09-16): a `close`
  // firing on a WebSocket this host has already moved past used to be
  // treated as if it described the CURRENT connection -- nulling out
  // `this.ws` out from under a perfectly healthy newer socket and
  // triggering an immediate reconnect. That reconnect's own hello then
  // displaced the (still fine) newer connection server-side, whose own late
  // close repeated the same thing -- an unbounded ~1.3s reconnect loop that
  // never settled and that a page reload only re-seeded.
  it('ignores a close event firing on a socket that has already been superseded by a newer one', async () => {
    const host = new BrowserStudioHost()
    await host.connectEnvironment('local', 'This Server', { kind: 'local' })
    await flush()
    const first = FakeWebSocket.instances[0]
    first.simulateOpen()
    first.simulateMessage(welcomeFrame())

    // Something (restartEnvironment, or a second internal reconnect) opens
    // a replacement while `first` is still the host's live socket. The old
    // production bug required no such second cause for the loop to become
    // self-sustaining -- once seeded once, every subsequent stale close was
    // enough on its own.
    host.restartEnvironment('local')
    const second = FakeWebSocket.instances[1]
    expect(second).toBeDefined()
    second.simulateOpen()
    second.simulateMessage(welcomeFrame())

    // The stale close arrives late, as it does in production (the browser
    // fires it once the old socket's underlying connection actually tears
    // down, which lags the moment `this.ws` was reassigned).
    first.simulateClose(1005, '')

    const snapshot = await host.connections()
    expect(snapshot[0].phase.phase).toBe('connected')

    // A send after the stale close must still reach the CURRENT (second)
    // socket, not be silently queued because handleFailure() nulled `this.ws`.
    host.send('local', { type: 'studio_action', id: 'after-stale-close', action: 'model.list', args: [] } as never)
    expect(second.sent.some((s) => JSON.parse(s).id === 'after-stale-close')).toBe(true)
  })

  // Regression for the genuine trigger behind the above: a real abnormal
  // closure (WebSocket code 1006, no close frame at all) fires BOTH the
  // browser's 'error' and 'close' events for the SAME socket, per the
  // WebSocket spec. Before this fix, each independently called
  // handleFailure(), which scheduled two overlapping retry timers from one
  // failure -- the first reconnected cleanly, and the second, orphaned timer
  // fired anyway a moment later and forcibly reconnected AGAIN over a
  // perfectly healthy connection. That second, needless reconnect is what
  // displaced the healthy one server-side and produced the first "displaced"
  // close in the log -- the exact seed the stale-event tests above show
  // turning into an infinite loop pre-fix. Confirmed in production logs
  // 2026-09-16: "connection closed: 1006" and "WebSocket error" both logged
  // within 1ms of each other for the same socket, on the very first
  // connection of the affected session.
  it('schedules only one reconnect when a socket fires both error and close for the same failure', async () => {
    vi.useFakeTimers()
    try {
      const host = new BrowserStudioHost()
      await host.connectEnvironment('local', 'This Server', { kind: 'local' })
      await vi.advanceTimersByTimeAsync(0)
      const first = FakeWebSocket.instances[0]
      first.simulateOpen()
      first.simulateMessage(welcomeFrame())

      // Spec order: 'error' precedes 'close' on an abnormal closure.
      first.simulateError()
      first.simulateClose(1006, '')

      // Advance well past BOTH ladder rungs (1000ms, 2000ms) a double-fire
      // would have scheduled. A single reconnect means exactly one new
      // socket -- a double-fire would produce two.
      await vi.advanceTimersByTimeAsync(5000)
      expect(FakeWebSocket.instances).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an open/message pair firing on an already-superseded socket', async () => {
    const host = new BrowserStudioHost()
    await host.connectEnvironment('local', 'This Server', { kind: 'local' })
    await flush()
    const first = FakeWebSocket.instances[0]

    host.restartEnvironment('local')
    const second = FakeWebSocket.instances[1]
    second.simulateOpen()
    second.simulateMessage(welcomeFrame())

    // The first socket's handshake completes late, after it has already
    // been superseded -- it must not re-send hello or reprocess a welcome
    // on the host's behalf.
    first.simulateOpen()
    expect(first.sent).toHaveLength(0)

    const snapshot = await host.connections()
    expect(snapshot[0].phase.phase).toBe('connected')
  })
})

describe('BrowserStudioHost offline recovery', () => {
  // Regression for a real production consequence of the fix above: with the
  // reconnect loop fixed, a genuine unbroken run of failures (e.g. the
  // server pod itself restarting) now correctly exhausts the fast ladder
  // and reaches 'offline' -- and used to just stop there forever, observed
  // live 2026-09-16 when a rolling deploy dropped an open tab's connection
  // and it never came back without a manual page reload.
  it('keeps retrying at the slow cadence instead of stopping forever once the ladder is exhausted', async () => {
    vi.useFakeTimers()
    try {
      const host = new BrowserStudioHost()
      await host.connectEnvironment('local', 'This Server', { kind: 'local' })
      await vi.advanceTimersByTimeAsync(0)

      // MAX_ATTEMPTS is 5: the first 5 failures walk the fast ladder
      // (scheduling a retry each time), and only the 6th tips
      // `attempts > MAX_ATTEMPTS` into 'offline'.
      for (let i = 0; i < 6; i++) {
        const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
        sock.simulateClose(1006, '')
        if (i < 5) await vi.advanceTimersByTimeAsync(8000)
      }
      const offlineSnapshot = await host.connections()
      expect(offlineSnapshot[0].phase.phase).toBe('offline')
      const countAtOffline = FakeWebSocket.instances.length

      // Advance well past the 30s offline retry cadence -- a dead-forever
      // connection would never open another socket here.
      await vi.advanceTimersByTimeAsync(31_000)
      expect(FakeWebSocket.instances.length).toBeGreaterThan(countAtOffline)
    } finally {
      vi.useRealTimers()
    }
  })
})

