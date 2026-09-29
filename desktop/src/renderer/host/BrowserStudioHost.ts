/**
 * BrowserStudioHost — the `StudioHost` implementation for a browser Studio
 * client (spec 18). Where `ElectronStudioHost` delegates every method onto
 * the preload's `window.ion` bridge, this host has no such bridge: it opens
 * its own WebSocket directly to the origin that served the page and
 * persists device settings and cached welcomes in IndexedDB
 * (`web-storage.ts`) instead of `desktop.json`. One environment per browser
 * tab — the origin's own server — so `connectEnvironment`/
 * `disconnectEnvironment`/`restartEnvironment` ignore the target they are
 * passed and always drive the one socket.
 *
 * Sign-in is server-held (spec 18 successor to the earlier client-side PKCE
 * flow): the browser never sees a token. Every `studio_hello` presents
 * `{kind:'session'}`, which the server resolves from the `ion_session`
 * HttpOnly cookie that rides along automatically with the WebSocket
 * upgrade request — there is nothing for this class to read, attach, or
 * refresh. When the server refuses that credential (no cookie yet, or the
 * session is gone), `openSocket()` navigates the whole page to
 * `/auth/login`, which redirects to the IdP and, on return, 302s straight
 * back here with a fresh cookie already set -- the app's JS bundle is
 * never even loaded on that leg. A page refresh with a live cookie needs no
 * redirect at all, unlike the old flow, which re-ran PKCE on every load
 * because it kept tokens in memory only.
 *
 * `shell: IonAPI` is partly bridged and partly refused. The surface was
 * written against Electron's preload, but only SOME of it is
 * Electron-specific by nature (native dialogs, OS tray, deep links,
 * transcription, remote-control pairing). The rest is validate-then-delegate
 * work the server can do perfectly well, and refusing it here hid whole
 * features from a browser client for want of a transport rather than an
 * implementation — the AI & Models settings category and the model picker's
 * provider list were both dark for exactly that reason.
 *
 * `browser-shell-bridge.ts` is the table of what IS served: an INVOKE entry
 * forwards the call as a `studio_action` (reproducing the preload's own
 * argument marshalling, so the server sees an identical payload whichever
 * client called it), and a SUBSCRIBE entry attaches to the `studio_event`
 * channel the server already fans out through `broadcast()`. Anything not in
 * that table still throws, deliberately: a silent no-op would leave the
 * caller believing it had succeeded.
 */
import type { SshAddEnvironmentProgress, SshAddEnvironmentResult } from '@ion/shared/types-ssh-environment'
import type { NearbyStudioServer } from '@ion/shared/types-nearby'
import type { StudioFrame, StudioRefusalReason } from '@ion/shared/studio-wire/types'
import { decodeFrame, encodeFrame } from '@ion/shared/studio-wire/codec'
import { PROTOCOL_VERSION } from '@ion/shared/studio-wire/version'
import type { IonAPI } from '../../preload/ionapi'
import type { ShellApi } from './shell-api'
import type { ConnectionPhase, ConnectionPhaseSnapshot } from '../../shared/types-connections'
import { LOCAL_ENVIRONMENT_ID, type EnvironmentTarget } from '@ion/shared/types-environments'
import type { ExportFileResult, ImportFileResult, TransferProgress } from '@ion/shared/types-transfer'
import type { Capability, StudioHost, FileDialogFilter } from './StudioHost'
import { getDeviceSettings, getEnvCache, setDeviceSetting, setEnvCache } from './web-storage'
import { rInfo, rWarn } from '../rendererLogger'
import { promptForSavePath, promptForDirectory } from './save-path-prompt-state'
import { BRIDGED_CAPABILITIES } from './browser-shell-bridge'
import { createBridgedShell, refuseUnbridged } from './bridged-shell'
import { BrowserLogForwarder } from './browser-log-forward'
import { WIRE_PING_CAPABILITY } from '@ion/shared/studio-wire/types'
import { ClientWireLatency } from '@ion/shared/client-wire-latency'

const CAPABILITIES: Capability[] = [
  'terminal', 'git', 'files', 'questions', 'graph',
  // Earned by browser-shell-bridge.ts's table: every `host.shell` verb the
  // AI & Models settings category and the model picker call is bridged, so
  // the category is no longer filtered out of SettingsDialog's sidebar.
  ...(BRIDGED_CAPABILITIES as Capability[]),
]

/** Attempt ladder for a failed connection — identical to `main/connections/broker.ts`'s, so a browser tab and the desktop app behave the same way under a flaky link. */
const BACKOFF_LADDER_MS = [1000, 2000, 4000, 8000]
const BACKOFF_WINDOW_MS = 5 * 60_000
const MAX_ATTEMPTS = 5
/**
 * Once the ladder above is exhausted, retry forever at this slower, gentle
 * cadence instead of stopping. `phase: 'offline'` still fires at that point
 * (the UI reads it as "disconnected" exactly as before), but it is no
 * longer a dead end -- a tab left open across a server restart or a long
 * network outage recovers on its own instead of requiring a manual reload
 * or an explicit Reconnect action forever. Matches
 * `main/connections/broker.ts`'s identical constant for the same reason the
 * ladder above does.
 */
const OFFLINE_RETRY_MS = 30_000

const CLIENT_ID_KEY = 'ion-web-client-id'

/** Matches `host-actions.ts`'s ACTION_TIMEOUT_MS so both round trips fail the same way. */
const BRIDGED_CALL_TIMEOUT_MS = 30_000

/** A stable id for this tab, kept in `sessionStorage` so it survives a reload but not a new tab (one environment per tab — no catalog, spec 18). */
function tabClientId(): string {
  try {
    const existing = window.sessionStorage.getItem(CLIENT_ID_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    window.sessionStorage.setItem(CLIENT_ID_KEY, id)
    return id
  } catch {
    // Private-mode sessionStorage can throw; a fresh id per reconnect attempt is still correct, just not stable across reloads.
    return crypto.randomUUID()
  }
}

/**
 * The browser's local answers, read before the bridge table.
 *
 * `platform` is not a function (`IonAPI` callers read it directly), and
 * `logWrite` is the one verb with a real browser transport of its own:
 * `POST /log`, which carries the `ion_session` cookie automatically.
 */
/**
 * Holds lines the server will not take yet -- before sign-in, or over budget
 * -- and replays them once it will. Without it the lines describing a failing
 * sign-in were the exact ones thrown away.
 */
const logForwarder = new BrowserLogForwarder()

const BROWSER_OVERRIDES: Partial<IonAPI> = {
  // No native window chrome exists in a browser tab. This value only matters
  // through `useStudioWindowChrome`'s non-darwin branch, which reserves inset
  // space for native min/max/close buttons a browser tab doesn't have.
  platform: 'linux',
  getPathForFile: () => '',
  logWrite: (level, tag, msg, fields) => {
    logForwarder.send({ level, tag, msg, fields })
  },
}

export class BrowserStudioHost implements StudioHost {
  /**
   * What this tab waits through: an action leaving here and its result
   * arriving back. Its lines reach `server.jsonl` as `component=web` through
   * the same `POST /log` route every other browser log line takes.
   */
  private readonly latency = new ClientWireLatency((tag, msg, fields) => rInfo(tag, msg, fields))
  private ws: WebSocket | null = null
  // Never anything but LOCAL_ENVIRONMENT_ID for the life of this host --
  // catalog.ts's browser catalog has exactly one entry and always connects
  // it under this id (confirmed in the studio_welcome handler below). An
  // arbitrary placeholder here ('browser', in an earlier version) creates a
  // real window: registry.ts awaits `host.connectEnvironment(entry.id, ...)`
  // before this field is ever set, but any earlier caller of `send()` --
  // React effects that fire on mount are the common case -- already knows
  // the one id this host will ever answer to and addresses it directly. Each
  // such call hit `send()`'s `environmentId !== this.environmentId` guard
  // against the placeholder and was silently dropped, not queued (the
  // pendingFrames queue only covers "no open connection yet", a different
  // failure). Observed live: `model.list`'s two boot-time refreshes lost
  // every single reload, leaving the model picker on whatever value was
  // last fetched (or its own initial placeholder) until some later call
  // happened to land after the race window closed. Seeding the real,
  // permanent id from construction removes the window instead of narrowing
  // it -- there is no connection state in which the placeholder value was
  // ever correct to have sent.
  private environmentId = LOCAL_ENVIRONMENT_ID
  private label = 'This Server'
  private attempts = 0
  private windowStartMs = 0
  private closedByUser = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private phase: ConnectionPhase = { phase: 'connecting', transport: 'tcp' }
  // Frames sent before the studio_hello/studio_welcome handshake completes
  // (page just loaded and a caller already wants to run a studio_action, or
  // a reconnect landed mid-flight) queue here instead of being dropped.
  // Flushed once studio_welcome arrives. Before this queue existed, `send()`
  // silently discarded the frame and host-actions.ts's caller sat waiting
  // the full 30s ACTION_TIMEOUT_MS for a reply that could never come --
  // observed in production as "every fresh Studio session takes ~30s to
  // become interactive."
  private pendingFrames: StudioFrame[] = []
  private readonly clientId = tabClientId()
  private readonly frameListeners = new Set<(environmentId: string, frame: StudioFrame) => void>()
  private readonly connectionListeners = new Set<(snapshot: ConnectionPhaseSnapshot[]) => void>()

  readonly shell: ShellApi = createBridgedShell({
    invoke: (action, args, timeoutMs) => this.invokeBridged(action, args, timeoutMs),
    // One Environment per browser tab: every scope resolves to it.
    subscribe: (channel, cb, _scope) => this.subscribeChannel(channel, cb),
    sendOneWay: (action, args) => this.sendBridgedOneWay(action, args),
    overrides: BROWSER_OVERRIDES,
    // Nothing else exists behind the bridge here, so an unbridged verb
    // throws rather than pretending to work.
    fallback: refuseUnbridged('a browser Studio client (spec 18)'),
  })

  /**
   * Run one bridged `host.shell` method as a `studio_action`.
   *
   * A local copy of `host-actions.ts`'s correlate-by-id round trip rather
   * than an import of it: that module takes a `StudioHost` and this IS the
   * host, so importing it here would close a cycle through
   * `host-instance.ts`. The contract is the same one every other
   * `studio_action` caller gets, including the timeout.
   */
  private invokeBridged(action: string, args: unknown[], timeoutMs: number = BRIDGED_CALL_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const timeout = setTimeout(() => {
        this.frameListeners.delete(listener)
        this.latency.noteActionTimeout(this.environmentId, id)
        rWarn('BrowserStudioHost', 'bridged shell call timed out', { action, id })
        reject(new Error(`${action} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      const listener = (_environmentId: string, frame: StudioFrame): void => {
        if (frame.type !== 'studio_action_result' || frame.id !== id) return
        clearTimeout(timeout)
        this.frameListeners.delete(listener)
        if (frame.ok) {
          resolve(frame.value)
        } else {
          const failure = frame.refusal ?? frame.error
          reject(new Error(failure?.message ?? `${action} failed`))
        }
      }
      this.frameListeners.add(listener)
      this.send(this.environmentId, { type: 'studio_action', id, action, args })
    })
  }

  /**
   * Fire a bridged verb without correlating a reply.
   *
   * The server still answers; nothing is listening for it, and the frame is
   * dropped by the listener set. That is the point: this mirrors the
   * preload's `ipcRenderer.send` for terminal keystrokes and resizes, where
   * arming a correlation listener and a 30s timer per keypress would be pure
   * overhead for a call whose real answer arrives on the terminal stream.
   */
  private sendBridgedOneWay(action: string, args: unknown[]): void {
    this.send(this.environmentId, { type: 'studio_action', id: crypto.randomUUID(), action, args })
  }

  /** Attach a bridged `on*` listener to the `studio_event` channel that feeds it. */
  private subscribeChannel(channel: string, cb: (payload: unknown, environmentId: string) => void): () => void {
    const listener = (environmentId: string, frame: StudioFrame): void => {
      if (frame.type === 'studio_event' && frame.channel === channel) cb(frame.payload, environmentId)
    }
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  send(environmentId: string, frame: StudioFrame): void {
    if (frame.type === 'studio_action') {
      // A browser tab reaches its server over one connection; the kind is
      // fixed, unlike the desktop's local/tcp/relay choice.
      this.latency.noteActionSent(environmentId, frame.id, 'browser')
    }
    if (environmentId !== this.environmentId) {
      rWarn('BrowserStudioHost', 'send targeted an unknown environment', { environment_id: environmentId })
      return
    }
    if (this.closedByUser) {
      rWarn('BrowserStudioHost', 'send dropped: connection deliberately closed', { frame_type: frame.type })
      return
    }
    if (this.phase.phase !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      rWarn('BrowserStudioHost', 'send queued: no open connection yet', { frame_type: frame.type })
      this.pendingFrames.push(frame)
      return
    }
    this.ws.send(encodeFrame(frame))
  }

  /** Flush frames queued by `send()` while the hello/welcome handshake was still in flight. */
  private flushPendingFrames(): void {
    if (this.pendingFrames.length === 0) return
    const frames = this.pendingFrames
    this.pendingFrames = []
    for (const frame of frames) {
      this.ws?.send(encodeFrame(frame))
    }
  }

  onFrame(cb: (environmentId: string, frame: StudioFrame) => void): () => void {
    this.frameListeners.add(cb)
    return () => this.frameListeners.delete(cb)
  }

  async connections(): Promise<ConnectionPhaseSnapshot[]> {
    return [{ environmentId: this.environmentId, label: this.label, phase: this.phase }]
  }

  onConnections(cb: (snapshot: ConnectionPhaseSnapshot[]) => void): () => void {
    this.connectionListeners.add(cb)
    cb([{ environmentId: this.environmentId, label: this.label, phase: this.phase }])
    return () => this.connectionListeners.delete(cb)
  }

  async deviceSettings(): Promise<Record<string, unknown>> {
    return getDeviceSettings()
  }

  async setDeviceSetting(key: string, value: unknown): Promise<void> {
    await setDeviceSetting(key, value)
  }

  capabilities(): Capability[] {
    return CAPABILITIES
  }

  async openExternal(url: string): Promise<boolean> {
    const win = window.open(url, '_blank', 'noopener,noreferrer')
    return win !== null
  }

  async pickFile(_options?: { multiple?: boolean; filters?: FileDialogFilter[] }): Promise<string[] | null> {
    // No filesystem path a browser tab can hand back — a real file picker
    // here would need the File System Access API, which is not universal
    // and would still not yield a native path. Not in spec 18's capability
    // list (openExternal/pickFile/pickDirectory/clipboardWriteImage are all
    // Electron-shell-only); a caller reads this as "cancelled".
    return null
  }

  async pickSavePath(defaultPath?: string, defaultFileName?: string, _filters?: FileDialogFilter[]): Promise<{ filePath: string | null; error?: string }> {
    // The files this client edits are the server's, so a path there is the
    // answer -- see `save-path-prompt.tsx`. A typed path has no listing to
    // filter, so `filters` has nothing to apply to.
    return promptForSavePath(defaultPath, defaultFileName)
  }

  async faviconFor(hostname: string): Promise<string | null> {
    // The page can load this directly; a failed fetch renders as a broken
    // image the caller already handles by dropping the icon.
    return `https://${hostname}/favicon.ico`
  }

  async pickDirectory(): Promise<string | null> {
    // Returning a bare null here was indistinguishable from the user pressing
    // Cancel, so every caller silently did nothing. The directories that
    // matter to a browser client are the server's, and it can name one.
    const result = await promptForDirectory()
    return result.filePath
  }

  async connectEnvironment(environmentId: string, label: string, _target: EnvironmentTarget): Promise<{ ok: boolean; error?: string }> {
    this.environmentId = environmentId
    this.label = label
    this.latency.start()
    if (this.ws) return { ok: true }
    this.beginConnect()
    return { ok: true }
  }

  async pairEnvironment(_link: string, _label?: string): Promise<{ ok: true; target: EnvironmentTarget } | { ok: false; error: string }> {
    // A browser client has exactly one environment -- the origin that served
    // it -- and no catalog to add a paired server to (see `catalog.ts`).
    rWarn('BrowserStudioHost', 'pairEnvironment refused: a browser client cannot add environments')
    return { ok: false, error: 'A browser Studio client cannot pair with other environments.' }
  }

  async sshAddEnvironment(_destination: string, _label?: string): Promise<SshAddEnvironmentResult> {
    // Same reason as pairEnvironment: a browser client has no catalog and no ssh binary.
    rWarn('BrowserStudioHost', 'sshAddEnvironment refused: a browser client cannot add environments')
    return { ok: false, error: 'A browser Studio client cannot add environments over SSH.' }
  }

  async browseNearby(): Promise<NearbyStudioServer[]> {
    // A browser tab cannot do mDNS, and a browser client adds no environments.
    return []
  }

  onSshProgress(_cb: (progress: SshAddEnvironmentProgress) => void): () => void {
    return () => {}
  }

  disconnectEnvironment(_environmentId: string): void {
    this.closedByUser = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.ws?.close()
    this.ws = null
    // A deliberate disconnect means whatever queued these frames is moot --
    // flushing them on a future reconnect would replay stale actions.
    this.pendingFrames = []
  }

  restartEnvironment(_environmentId: string): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    // Explicitly close whatever's live rather than leaving beginConnect()
    // below to silently overwrite `this.ws` -- the openSocket() staleness
    // guard makes an orphaned old socket harmless now, but there is no
    // reason to leave a real, still-open server-side connection dangling
    // for the server to discover and displace a moment later.
    this.ws?.close()
    this.ws = null
    this.attempts = 0
    this.windowStartMs = 0
    this.closedByUser = false
    this.beginConnect()
  }

  async getEnvCache(environmentId: string): Promise<{ welcome: StudioFrame; cachedAt: number } | null> {
    return getEnvCache(environmentId)
  }

  async exportToFile(): Promise<ExportFileResult> {
    return { ok: false, refusal: { code: 'unsupported', message: 'file transfer is not available in a browser Studio client' } }
  }

  async importFromFile(): Promise<ImportFileResult> {
    return { ok: false, refusal: { code: 'unsupported', message: 'file transfer is not available in a browser Studio client' } }
  }

  onTransferProgress(_cb: (progress: TransferProgress) => void): () => void {
    // No binary channel is opened over this socket (see handleMessage) — transfer never produces progress here.
    return () => {}
  }

  async cancelTransfer(): Promise<boolean> {
    // Nothing can be in flight: exportToFile/importFromFile are refused above.
    return false
  }

  private beginConnect(): void {
    this.setPhase({ phase: 'connecting', transport: 'tcp' })
    this.openSocket()
  }

  /**
   * Navigates the whole page to the server's login endpoint -- there is no
   * token to fetch and hand back, so a full navigation (not a fetch) is the
   * only way to let the server drive the IdP redirect and set the cookie.
   * `returnTo` is this tab's own path, so the server's callback lands the
   * user back where they were rather than always at `/`.
   */
  private redirectToLogin(): void {
    const returnTo = window.location.pathname + window.location.search
    window.location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`
  }

  private openSocket(): void {
    const wsUrl = `${window.location.origin.replace(/^http/, 'ws')}/studio`
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      this.handleFailure(err instanceof Error ? err.message : String(err))
      return
    }
    this.ws = ws
    // Every listener below checks `this.ws === ws` before acting. A socket
    // this method has already been superseded on -- by a later reconnect, a
    // manual restartEnvironment(), or a deliberate disconnect -- keeps
    // firing its own open/message/close/error events until the browser
    // garbage-collects it, and those late events must never be allowed to
    // act as if they describe whatever connection is current now.
    //
    // Without this guard, a stale `close` firing after a newer socket had
    // already connected and been welcomed would call handleFailure(), which
    // unconditionally nulls `this.ws` -- wiping out the reference to the
    // healthy newer connection -- and immediately schedules another
    // reconnect. That reconnect's own hello then displaces the (perfectly
    // fine) newer connection server-side, whose own late close event repeats
    // the exact same thing. Observed live in production as an unbounded
    // ~1.3s reconnect loop (server log: hello -> displacing the previous
    // connection -> welcome sent -> closed, repeating forever) that a page
    // reload never actually fixed, because the very first reload re-seeds
    // the same self-sustaining cycle.
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      this.sendHello()
    })
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return
      this.handleMessage(ev)
    })
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws || this.closedByUser) return
      this.handleFailure(`connection closed: ${ev.code} ${ev.reason}`.trim())
    })
    ws.addEventListener('error', () => {
      if (this.ws !== ws) return
      this.handleFailure('WebSocket error')
    })
  }

  private sendHello(): void {
    const hello: StudioFrame = {
      type: 'studio_hello',
      protocolVersion: PROTOCOL_VERSION,
      clientId: this.clientId,
      clientKind: 'web',
      // The UI capability list, plus the one that names no UI at all:
      // `wire-ping` tells the server this client answers `studio_ping`, which
      // is how it measures the round trip here.
      capabilities: [...this.capabilities(), WIRE_PING_CAPABILITY],
      // Cookie-resolved server-side (see this file's module doc) -- there is
      // no token for the browser to attach.
      credential: { kind: 'session' },
    }
    this.ws?.send(encodeFrame(hello))
  }

  private handleMessage(ev: MessageEvent<unknown>): void {
    if (typeof ev.data !== 'string') {
      // Binary transfer channel (spec 15) has no browser consumer (exportToFile/importFromFile are refused above); ignore rather than attempt to decode.
      rWarn('BrowserStudioHost', 'binary frame arrived with no transfer support to consume it; ignoring')
      return
    }
    let frame: StudioFrame
    try {
      frame = decodeFrame(ev.data)
    } catch (err) {
      rWarn('BrowserStudioHost', 'malformed frame from server; ignoring', { error: err instanceof Error ? err.message : String(err) })
      return
    }
    if (frame.type === 'studio_ping') {
      // Answered before anything else this frame could queue behind: the
      // round trip being measured includes whatever we make the server wait
      // for.
      this.send(this.environmentId, { type: 'studio_pong', nonce: frame.nonce, t: Date.now() })
      return
    }
    if (frame.type === 'studio_action_result') {
      this.latency.noteActionResult(this.environmentId, frame.id)
    }
    if (frame.type === 'studio_welcome') {
      this.attempts = 0
      this.windowStartMs = 0
      // `frame.environmentId` is the SERVER's own self-declared identity
      // (a random UUID minted per server-side process, see
      // `server/src/identity/environment-id.ts`) -- not this client's local
      // catalog id. `this.environmentId` must stay pinned to whatever
      // `connectEnvironment()` set (always `LOCAL_ENVIRONMENT_ID`/'local' in
      // practice, per `catalog.ts`'s single-entry browser catalog), because
      // every caller (`send()`'s target, `secondary-store.ts`'s forwarded
      // actions, `getEnvCache`/`setEnvCache` keying, frame-listener dispatch)
      // addresses this one environment by that stable id. Overwriting it here
      // broke `send()`'s guard the instant a welcome arrived: every action
      // forwarded afterward targeted 'local' while this host had silently
      // renamed itself to the server's UUID.
      this.setPhase({ phase: 'connected', transport: 'tcp' })
      this.flushPendingFrames()
      void setEnvCache(this.environmentId, { welcome: frame, cachedAt: Date.now() })
    } else if (frame.type === 'studio_refused') {
      if (frame.reason === 'unauthorized') {
        // No session cookie, or the session is gone (deleted after a failed
        // refresh) -- a full navigation is the only way forward, unlike
        // every other refusal reason, which is worth retrying in place.
        rWarn('BrowserStudioHost', 'refused unauthorized; navigating to sign in')
        this.redirectToLogin()
        return
      }
      this.handleFailure(`refused: ${frame.reason}${frame.detail ? ` (${frame.detail})` : ''}`, frame.reason)
      return
    } else if (frame.type === 'studio_close' && frame.reason === 'token_expired') {
      // The session was valid at hello time but is gone now (deleted
      // server-side after a failed refresh) -- reconnecting re-sends
      // {kind:'session'}, which the server will refuse unauthorized and
      // this class will then redirect to sign in, same as above.
      rWarn('BrowserStudioHost', 'server closed the connection for an expired session; reconnecting')
    }
    for (const cb of this.frameListeners) cb(this.environmentId, frame)
  }

  private handleFailure(reason: string, refusalReason?: StudioRefusalReason): void {
    this.ws = null
    if (this.closedByUser) return
    const now = Date.now()
    if (now - this.windowStartMs > BACKOFF_WINDOW_MS) {
      this.windowStartMs = now
      this.attempts = 0
    }
    this.attempts += 1
    if (this.attempts > MAX_ATTEMPTS) {
      // Still retries -- see OFFLINE_RETRY_MS's doc comment. `phase` stays
      // 'offline' (its type carries no attempt/nextAttemptAtMs, matching
      // the desktop broker's identical phase shape) even though a timer is
      // running underneath it.
      this.setPhase({ phase: 'offline', transport: 'tcp', reason, refusalReason })
      this.retryTimer = setTimeout(() => this.beginConnect(), OFFLINE_RETRY_MS)
      return
    }
    const delay = BACKOFF_LADDER_MS[Math.min(this.attempts - 1, BACKOFF_LADDER_MS.length - 1)]
    this.setPhase({ phase: 'backoff', transport: 'tcp', reason, refusalReason, attempt: this.attempts, nextAttemptAtMs: now + delay })
    this.retryTimer = setTimeout(() => this.beginConnect(), delay)
  }

  private setPhase(phase: ConnectionPhase): void {
    this.phase = phase
    rInfo('BrowserStudioHost', 'connection phase changed', {
      environment_id: this.environmentId,
      phase: phase.phase,
      reason: 'reason' in phase ? phase.reason : undefined,
    })
    const snapshot = [{ environmentId: this.environmentId, label: this.label, phase }]
    for (const cb of this.connectionListeners) cb(snapshot)
  }
}
