/**
 * events — the `studio_event` fan-out (manifest contract C3).
 *
 * `publishStudioEvent` is the single entry point `server/src/broadcast.ts`
 * calls for every channel in `EVENT_CHANNELS`; it replaces that module's
 * former no-op branch for the channels that had no headless effect before
 * this child ("child 07's Studio wire is the specified replacement
 * mechanism" — see `broadcast.ts`'s own doc comment, now honored).
 *
 * A `'tab'`-scoped channel is delivered to a connection only when the
 * event's owning tab resolves to that connection's principal, or the tab
 * record can't be resolved at all AND the operator's
 * `server.json.tenancy.unownedTabs` policy says such a record is everyone's
 * (see `tabs-index.ts`'s `principalSubjectForTab` doc and
 * `config/current.ts`'s `unownedTabsVisible`) — the default is nobody's once
 * `oidc` is configured. An `'environment'`-scoped
 * channel reaches every connection unconditionally. A `'per-principal'`
 * channel also reaches every connection, but its payload is projected
 * through `mirror-projection.ts` first — it is a payload transform, not a
 * visibility gate. Per the spec's Edge Cases: a tab never changes owner in
 * this program, so this reads the record fresh at send time rather than
 * tracking ownership per subscription.
 *
 * Before any of that, a channel is matched against the connection's view
 * (`channelDeliveredToView`): a thin connection is sent `studio:thin-event`
 * and the few channels that name it, never the raw engine stream or the
 * owner-published store syncs, and a mirror connection is never sent
 * `studio:thin-event`.
 */
import { EVENT_CHANNEL_NAMES, THIN_EVENT_CHANNEL, channelDeliveredToView, channelKeepsLatestOnly, eventChannelScope } from '@ion/shared/studio-wire/channels'
import { scopeSatisfies } from '@ion/shared/studio-wire/action-scopes'
import { STARTUP_PROGRESS_CHANNEL } from '@ion/shared/startup-state'
import { startupReportForAttach } from '../store/startup-progress'
import { listAgentRosters } from '../engine/agent-state-mirror'
import { log as _log, debug as _debug } from '../logger'
import type { Connection, ConnectionRegistry } from './connection'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { tabIdVisibleToSubject } from './tabs-index'
import { unownedTabsVisible, isSharedTenancy } from '../config/current'
import { projectForConnection } from './mirror-projection'
import { developerSurfaceChannelAllowed, developerSurfaceThinEventAllowed, projectWorktreeSnapshotForSurfaces } from '@ion/shared/developer-surfaces'
import type { StudioWorktreeSnapshot } from '@ion/shared/types-studio'
import { isValidSpanId, isValidTraceId, type TraceParent } from '@ion/shared/trace-context'
import { annotateSpan, currentEventTrace, runWithTrace, withSpan } from '../tracing/op-span'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-events', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('studio-events', msg, fields)
}

/** Returns true when the connection was sent the event. `trace` is the engine event's, when the payload or the ambient context names one. */
type Listener = (channel: string, args: unknown[], trace: TraceParent | undefined) => boolean
const listeners = new Set<Listener>()

/**
 * Publish one channel firing to every subscribed connection handler. A
 * channel outside `EVENT_CHANNELS` is dropped with a warning — the wire
 * contract is closed, not "whatever `broadcast()` happens to call this
 * with".
 */
export function publishStudioEvent(channel: string, args: unknown[]): void {
  if (!EVENT_CHANNEL_NAMES.has(channel)) {
    // `broadcast()` calls this for every channel in the system, most of
    // which (window-focus IPC, per-window UI pushes) are not part of the
    // Studio wire contract at all — that is the expected common case, not
    // an anomaly, so this stays at DEBUG rather than WARN.
    debug('channel not in the Studio wire contract; not fanned out', { channel })
    return
  }
  // Under the engine event's trace when the payload carries one, so every
  // frame and envelope the fan-out writes names it; the span is the server's
  // fan-out to every connection, a child of the engine's span.
  // No connection means no fan-out to time: nothing is written.
  if (listeners.size === 0) return
  const trace = eventTrace(channel, args) ?? currentEventTrace()
  runWithTrace(trace, () => withSpan('store.broadcast', { attrs: { channel } }, () => {
    let delivered = 0
    for (const listener of listeners) {
      if (listener(channel, args, trace)) delivered++
    }
    annotateSpan({ connections: listeners.size, delivered })
  }))
}

/**
 * The trace of the engine event `args` carry: the `NormalizedEvent` on
 * `ion:normalized-event` (after the tab id), or a thin event projected from
 * one (`event-wiring-wire-projection.ts` spreads the event's fields, ids
 * included). Undefined when the payload names no valid trace.
 */
export function eventTrace(channel: string, args: unknown[]): TraceParent | undefined {
  const carrier = channel === 'ion:normalized-event' ? args[1] : args[0]
  if (!carrier || typeof carrier !== 'object') return undefined
  const { trace_id: traceId, span_id: spanId } = carrier as { trace_id?: unknown; span_id?: unknown }
  return isValidTraceId(traceId) && isValidSpanId(spanId) ? { traceId, spanId } : undefined
}

/**
 * A `studio_event` frame, stamped with the trace of the engine event it
 * carries or was derived from. The default is the engine event's trace while
 * one is being handled (`engine-bridge-core.ts` carries it with
 * `runWithTrace`), whatever server spans are open inside it, and nothing
 * otherwise: a frame never names the server's own span.
 */
export function studioEventFrame(channel: string, payload: unknown, trace: TraceParent | undefined = currentEventTrace()): Extract<StudioFrame, { type: 'studio_event' }> {
  return trace
    ? { type: 'studio_event', channel, payload, trace_id: trace.traceId, span_id: trace.spanId }
    : { type: 'studio_event', channel, payload }
}

function subscribeStudioEvents(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Extract the owning tabId from a channel's broadcast args, when the channel names one. */
function tabIdForEvent(channel: string, args: unknown[]): string | null {
  switch (channel) {
    case 'ion:normalized-event':
    case 'ion:tab-status-change':
    case 'studio:active-tab':
    case 'studio:permission-resolved':
    case 'studio:user-message-echo':
      return typeof args[0] === 'string' ? args[0] : null
    case THIN_EVENT_CHANNEL: {
      // `desktop_tab_created` carries the whole tab rather than a bare id.
      const payload = args[0] as { tabId?: unknown; tab?: { id?: unknown } } | undefined
      if (typeof payload?.tabId === 'string') return payload.tabId
      return typeof payload?.tab?.id === 'string' ? payload.tab.id : null
    }
    case 'ion:chart-jump':
    case 'studio:composer-actions':
    case 'studio:open-web-application':
    case 'studio:history-replace': {
      const payload = args[0] as { tabId?: unknown } | undefined
      return typeof payload?.tabId === 'string' ? payload.tabId : null
    }
    case 'ion:terminal-incoming':
    case 'ion:terminal-exit':
    case 'ion:terminal-restarted': {
      const key = args[0]
      if (typeof key !== 'string') return null
      const sep = key.indexOf(':')
      return sep === -1 ? key : key.slice(0, sep)
    }
    case 'ion:terminal-activity': {
      const activity = args[0] as { tabId?: unknown } | undefined
      return typeof activity?.tabId === 'string' ? activity.tabId : null
    }
    default:
      return null
  }
}

/** Condense broadcast args into the single JSON value `studio_event.payload` carries. */
function formatEventPayload(channel: string, args: unknown[]): unknown {
  if (channel === 'ion:tab-status-change') {
    return { tabId: args[0], status: args[1], previousStatus: args[2] }
  }
  // The third argument names whose setting changed and only routes the event
  // (see `visibleTo`); a client receives the key and the value.
  if (channel === SETTINGS_CHANGED_CHANNEL) return [args[0], args[1]]
  // Likewise a Provider Subscription snapshot: the second argument names whose it is.
  if (channel === PROVIDER_SUBSCRIPTION_CHANGED_CHANNEL && typeof args[1] === 'string') return args[0]
  if (args.length === 1) return args[0]
  return args
}

const SETTINGS_CHANGED_CHANNEL = 'ion:settings-changed'
const PROVIDER_SUBSCRIPTION_CHANGED_CHANNEL = 'ion:provider-subscription-changed'

/**
 * Worktree and bench state on the thin channel is held to the rule
 * `mirror-projection.ts` applies to `studio:worktree-sync`: it is keyed by
 * repository, not by tab, so it is gated on the `git:write` scope instead.
 */
function thinEventNeedsGitWrite(args: unknown[]): boolean {
  const type = (args[0] as { type?: unknown } | undefined)?.type
  return typeof type === 'string' && (type.startsWith('desktop_worktree_') || type.startsWith('desktop_bench_'))
}

const WORKTREE_SYNC_CHANNEL = 'studio:worktree-sync'

/** False when the event belongs to a developer surface this connection may not reach. */
function developerSurfaceAllows(conn: Connection, channel: string, args: unknown[]): boolean {
  const surfaces = conn.developerSurfaces
  if (!developerSurfaceChannelAllowed(channel, surfaces)) return false
  if (channel !== THIN_EVENT_CHANNEL) return true
  const type = (args[0] as { type?: unknown } | undefined)?.type
  return typeof type !== 'string' || developerSurfaceThinEventAllowed(type, surfaces)
}

function visibleTo(conn: Connection, channel: string, args: unknown[]): boolean {
  if (!developerSurfaceAllows(conn, channel, args)) return false
  if (channel === THIN_EVENT_CHANNEL && thinEventNeedsGitWrite(args) && !scopeSatisfies(conn.scopes, 'git:write')) return false
  // A setting that lives in one person's overlay changed: only that person's
  // connections hear it. Broadcasting it to everyone patched another
  // person's client with a value that was never theirs. An Environment
  // setting names no owner and reaches every connection.
  if (channel === SETTINGS_CHANGED_CHANNEL && typeof args[2] === 'string') {
    return conn.principal !== null && conn.principal.subject === args[2]
  }
  // A Provider Subscription snapshot that names a person reaches that person's
  // connections only. One the engine broadcast (no owner) reaches everyone, as before.
  if (channel === PROVIDER_SUBSCRIPTION_CHANGED_CHANNEL && typeof args[1] === 'string') {
    return conn.principal !== null && conn.principal.subject === args[1]
  }
  const scope = eventChannelScope(channel)
  if (scope !== 'tab') return true // 'environment' and 'per-principal' both reach every connection
  if (isSharedTenancy()) return true // FR-02: every connection sees every tab's events
  const tabId = tabIdForEvent(channel, args)
  // A thin event that names no tab is not an unowned tab's event: it is
  // environment state (settings, themes, engine profiles), or a snapshot the
  // thin publisher already built for one principal and sent to it directly.
  if (!tabId && channel === THIN_EVENT_CHANNEL) {
    // Git state names a directory, not a tab. It belongs to whoever has a
    // tab there, which is why that directory is being watched at all.
    const directory = (args[0] as { directory?: unknown } | undefined)?.directory
    return typeof directory === 'string' ? conn.thinDirectories.has(directory) : true
  }
  if (!tabId) return unownedTabsVisible() // no resolvable tab id: everyone's in single-owner mode, no one's otherwise
  // A tab record not found reads as unowned — see tabs-index.ts's principalSubjectForTab doc.
  return tabIdVisibleToSubject(tabId, conn.principal?.subject ?? null)
}

/**
 * Subscribe `conn` to the event bus for its lifetime. Returns an unsubscribe
 * function the caller (`listener.ts`) invokes on connection close.
 */
export function attachConnectionToEvents(conn: Connection): () => void {
  // Hand the newcomer the restore's current phase, or its terminal report:
  // a splash that attached mid-restore would otherwise show nothing until
  // the next tab, and one that attached after a fast restore would wait on
  // a ready it had already missed.
  const inFlight = startupReportForAttach()
  if (inFlight && channelDeliveredToView(STARTUP_PROGRESS_CHANNEL, conn.view)) {
    log('replaying latest startup progress to a new connection', { sequence: inFlight.sequence, status: inFlight.status, ready: inFlight.ready === true })
    // Same shape as a live report: `broadcast(channel, report)` is one
    // argument, which formatEventPayload condenses to the bare object. The
    // replay used to wrap it in an array, so the desktop accepted the replay
    // and rejected every live report after it -- the splash froze on the
    // phase the connection attached during.
    conn.send({ type: 'studio_event', channel: STARTUP_PROGRESS_CHANNEL, payload: formatEventPayload(STARTUP_PROGRESS_CHANNEL, [inFlight]) })
  }
  replayAgentRosters(conn)
  return subscribeStudioEvents((channel, args, trace) => {
    if (conn.isClosed) return false
    if (!channelDeliveredToView(channel, conn.view)) return false
    if (!visibleTo(conn, channel, args)) return false
    const projected = eventChannelScope(channel) === 'per-principal'
      ? projectForConnection(channel, formatEventPayload(channel, args), conn)
      : formatEventPayload(channel, args)
    const payload = channel === WORKTREE_SYNC_CHANNEL
      ? projectWorktreeSnapshotForSurfaces(projected as StudioWorktreeSnapshot, conn.developerSurfaces)
      : projected
    const frame = studioEventFrame(channel, payload, trace)
    return channelKeepsLatestOnly(channel) ? conn.sendLatest(channel, frame) : conn.send(frame)
  })
}

/**
 * Hand a new connection every conversation's current agent roster, as the same
 * `agent_state` event a live one is. A client builds a conversation's agent
 * panel from these events alone (the tab sync strips rosters), and the engine
 * re-sends a roster only on its periodic heartbeat, so without this a client
 * that connected after the last event showed no agents until the next beat.
 * A roster is a complete snapshot, so replaying it can only bring the client
 * up to date.
 */
function replayAgentRosters(conn: Connection): void {
  const channel = 'ion:normalized-event'
  if (!channelDeliveredToView(channel, conn.view)) return
  let sent = 0
  for (const { key, agents } of listAgentRosters()) {
    const args = [key, { type: 'agent_state', agents }]
    if (!visibleTo(conn, channel, args)) continue
    conn.send({ type: 'studio_event', channel, payload: formatEventPayload(channel, args) })
    sent++
  }
  log('replayed current agent rosters to a new connection', { connection_id: conn.id, rosters: sent })
}

/** Broadcast one channel to every live connection unconditionally (used by `commands.ts`/`listener.ts` for server-authored events like `studio_environment_policy`). */
export function broadcastToAll(registry: ConnectionRegistry, channel: string, args: unknown[]): void {
  for (const conn of registry.all()) {
    if (conn.isClosed) continue
    conn.send({ type: 'studio_event', channel, payload: formatEventPayload(channel, args) })
  }
  log('broadcast to all connections', { channel, connection_count: registry.all().length })
}
