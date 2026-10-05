/**
 * `studio_event` channels (manifest contract C3) — the successor to the
 * desktop's window-fan-out `broadcast()` (`desktop/src/main/broadcast.ts`)
 * and its headless placeholder (`server/src/broadcast.ts`).
 *
 * `scope` says how a server filters a channel per connection:
 *   - `'tab'`: the event names (or carries) a specific tab. The server
 *     resolves the owning tab's `principalSubject` at send time and only
 *     delivers to a connection whose principal matches (or, on a
 *     single-owner/non-multi-tenant server, to every connection when the
 *     tab record can't be resolved — a multi-tenant server treats the same
 *     unresolvable record as nobody's; `server/src/protocol/events.ts` is
 *     the enforcement point and has its own tests for every branch).
 *   - `'environment'`: no per-connection projection applies at all (settings,
 *     engine status, update lifecycle) — every connection to this
 *     environment receives the identical payload.
 *   - `'per-principal'`: like `'environment'` for visibility (every
 *     connection is subscribed), but the payload itself is a whole-store
 *     projection that names several tabs/conversations at once, so it is
 *     projected down to each connection's own principal before send
 *     (`server/src/protocol/mirror-projection.ts`) rather than gated as a
 *     single yes/no like `'tab'`.
 *
 * This list is the wire contract: `server/src/protocol/events.ts` subscribes
 * to exactly these channels and no others, and `check-studio-wire.sh` treats
 * `__fixtures__/v1/studio_event.json` as pinned to `PROTOCOL_VERSION`. `scope`
 * itself is never serialized on the wire — it is server-internal filtering
 * metadata — so changing it is not a wire-shape change and needs no fixture
 * update.
 */
import type { StudioView } from './types'

export interface EventChannelSpec {
  name: string
  scope: 'tab' | 'environment' | 'per-principal'
  /**
   * Which connection views (`StudioView`) receive this channel. Absent means
   * mirror connections only, which is every channel that predates the thin
   * view. Like `scope`, this is server-side filtering metadata and is never
   * serialized.
   */
  views?: readonly StudioView[]
  /**
   * `'latest'`: every payload is a full snapshot that replaces the one before
   * it, so a connection keeps only the newest unsent payload rather than
   * queuing each. Absent means every payload is delivered in order. Server-side
   * delivery metadata, never serialized.
   */
  delivery?: 'latest'
}

/** The one channel a thin connection's conversation and tab state rides. */
export const THIN_EVENT_CHANNEL = 'studio:thin-event'

/** See its entry in `EVENT_CHANNELS`. */
export const SYSTEM_METRICS_CHANNEL = 'ion:system-metrics'

/** See its entry in `EVENT_CHANNELS`. */
export const PUSH_DOORBELL_CHANNEL = 'studio:push-doorbell'

/** See its entry in `EVENT_CHANNELS`. */
export const CLIENT_LOG_REQUEST_CHANNEL = 'studio:client-log-request'

export const EVENT_CHANNELS: readonly EventChannelSpec[] = [
  // The thin view (`StudioView`). Every payload is one `RemoteEvent`
  // (`remote-projection-types`): the server-derived transcript rows, batched
  // text deltas, tab and worktree state, settings, themes, and questions a
  // thin client renders. Tab-scoped when the event names a `tabId`; an event
  // that names none (settings, themes, a full snapshot built for that
  // connection's principal) reaches every thin connection. Never sent to a
  // mirror connection, which has the raw channels below instead.
  { name: THIN_EVENT_CHANNEL, scope: 'tab', views: ['thin'] },
  // The frame a push doorbell is sealed around (`relay-envelope.ts`
  // `RelayPushMeta`). It is sent through a relay to a thin client that has no
  // live connection, so the relay pushes instead of forwarding. If the client
  // joins in that instant and the relay forwards it after all, the payload
  // says nothing beyond which tab: its state arrives with its first paint.
  { name: PUSH_DOORBELL_CHANNEL, scope: 'environment', views: ['thin'] },
  // The server asking one thin client for the diagnostic log lines it has
  // written past `{sinceSeq}`. Sent to that connection only, never fanned
  // out; the client answers with the `clientLog.append` action.
  { name: CLIENT_LOG_REQUEST_CHANNEL, scope: 'environment', views: ['thin'] },
  { name: 'ion:normalized-event', scope: 'tab' },
  { name: 'ion:tab-status-change', scope: 'tab' },
  { name: 'ion:chart-jump', scope: 'tab' },
  // The Composer Actions one conversation offers, decided by the server
  // (`ComposerActionsState`): a complete snapshot for the tab it names.
  { name: 'studio:composer-actions', scope: 'tab' },
  { name: 'ion:terminal-incoming', scope: 'tab' },
  { name: 'ion:terminal-activity', scope: 'tab' },
  { name: 'ion:terminal-exit', scope: 'tab' },
  { name: 'ion:terminal-restarted', scope: 'tab' },
  { name: 'ion:enriched-error', scope: 'environment' },
  { name: 'ion:settings-changed', scope: 'environment' },
  { name: 'ion:themes-changed', scope: 'environment' },
  { name: 'ion:engine-reconnected', scope: 'environment' },
  { name: 'ion:questions-state', scope: 'environment' },
  // FR-02: who is connected and which tab each connection has focused --
  // see server/src/protocol/presence.ts. Full snapshot every change,
  // every connection, in every tenancy mode.
  { name: 'studio:presence', scope: 'environment' },
  // Startup progress from the server's tab and session restoration, the
  // long part of a desktop boot. The desktop relays the LOCAL environment's
  // reports to its splash (`STARTUP_PROGRESS_CHANNEL` in startup-state.ts).
  { name: 'startup:progress', scope: 'environment' },
  // A deep link needs a confirmation surface: the local desktop opens (or
  // focuses) its Studio window on this; the renderer then reports itself
  // ready through `deeplink.setConfirmAvailability`.
  { name: 'ion:deeplink-present', scope: 'environment' },
  { name: 'ion:deeplink-confirm-request', scope: 'environment' },
  { name: 'ion:deeplink-confirm-settled', scope: 'environment' },
  // A navigation link the local desktop received from its OS, resolved by
  // the server: the desktop's window moves its view to the target.
  { name: 'ion:deeplink-navigate', scope: 'environment' },
  { name: 'ion:update-downloaded', scope: 'environment' },
  { name: 'ion:update-progress', scope: 'environment' },
  { name: 'ion:update-staged', scope: 'environment' },
  { name: 'ion:update-error', scope: 'environment' },
  { name: 'ion:resource-catalog-changed', scope: 'environment' },
  // A finite, validated automation action handed to an attached client for
  // UI-mediated execution. Environment-scoped: the action names its own
  // target conversation, and any attached client may run it.
  { name: 'ion:automation-command', scope: 'environment' },
  // One report per evaluated automation (`AutomationRuntimeEvent`): which
  // automation ran, on what trigger, and how it ended. Environment-scoped:
  // an automation belongs to the host, and its trigger need not name a tab.
  { name: 'ion:automation-event', scope: 'environment' },
  // An interactive sign-in page a headless server cannot show itself. The
  // client opens it in a new tab; the flow completes through its own
  // callback or poll, not through any acknowledgement on this channel.
  { name: 'ion:open-auth-url', scope: 'environment' },
  // The Environment's device transport (iOS / LAN / relay), which the server
  // owns: transport state, pairing and revocation, relay discovery and the
  // remote display name. Environment-scoped: they describe the Environment,
  // not any one tab, and the Remote settings category renders them on every
  // host. Writes go through the admin `remote.*` actions.
  { name: 'ion:remote-state-changed', scope: 'environment' },
  // Environment page (ADR-033): a clone/setup/purge job's progress snapshot,
  // and "the project registry on this server changed" so every client
  // re-lists. Environment-scoped: a project belongs to the host, not a tab.
  // Both views: a thin client administers a host through the same
  // `environment.*` actions, and these are their only progress signals.
  { name: 'ion:project-job', scope: 'environment', views: ['mirror', 'thin'] },
  { name: 'ion:projects-changed', scope: 'environment', views: ['mirror', 'thin'] },
  // A project's committed `.ion/studio.json` changed, or its Quick Tools were
  // trusted. Environment-scoped: the payload names a project root on that host.
  { name: 'ion:project-studio-config', scope: 'environment' },
  // Discovery status (`{mode, advertising, until}`, never the pairing code)
  // and the bare "paired clients changed" signal. Both describe the host. The
  // server has broadcast `ion:discovery` since discovery shipped, but it was
  // missing here, and a channel missing here is dropped before it reaches any
  // client: a Devices list waiting on it never refreshed. Both views, with
  // relay discovery below: a phone administers pairing and the relay through
  // the same actions and needs the same refresh signals.
  { name: 'ion:discovery', scope: 'environment', views: ['mirror', 'thin'] },
  { name: 'ion:clients-changed', scope: 'environment', views: ['mirror', 'thin'] },
  { name: 'ion:remote-device-paired', scope: 'environment' },
  { name: 'ion:remote-device-revoked', scope: 'environment' },
  { name: 'ion:remote-relays-changed', scope: 'environment', views: ['mirror', 'thin'] },
  { name: 'ion:remote-display-changed', scope: 'environment' },
  // The engine's telemetry delivery health, retained and described by the
  // server (`engine/telemetry-health.ts`); a client turns `notify` into an
  // OS notification under its own policy.
  { name: 'ion:telemetry-health', scope: 'environment' },
  // The Environment's System Metrics (`system-metrics/publisher.ts`): one
  // complete `EnvironmentSystemMetrics` per engine sample. Sent only to the
  // connections that asked with `environment.systemMetrics.watch`, never
  // fanned out; a thin connection gets `desktop_system_metrics` on the thin
  // channel instead.
  { name: SYSTEM_METRICS_CHANNEL, scope: 'environment' },
  // The engine's complete MCP server list, republished on every add, remove,
  // login, and logout from any client. Environment-scoped: MCP servers are
  // configured on the engine, not on a tab. Both views: a phone administers
  // the same servers.
  { name: 'ion:mcp-servers-changed', scope: 'environment', views: ['mirror', 'thin'] },
  // The engine's complete Provider Subscription state (the provider key a
  // lookup endpoint resolved for the signed-in identity), republished on
  // every change. Never carries the key. Both views: a phone chooses the
  // subscription too.
  { name: 'ion:provider-subscription-changed', scope: 'environment', views: ['mirror', 'thin'] },
  // A host installing a release or a sent build on itself: each step, to
  // every client. Both views: a phone starts an update too.
  { name: 'ion:host-install-progress', scope: 'environment', views: ['mirror', 'thin'] },
  // Every deploy `ion fleet deploy` told this server of, newest first,
  // republished whenever one changes. Mirror only: a deploy from source runs
  // on a desktop, and a phone has no surface for it.
  { name: 'ion:fleet-deploys', scope: 'environment', delivery: 'latest' },
  // The Graph View's live corpus (`graph-view/corpus-store.ts`) and resolved
  // configuration (`graph-view/config-store.ts`). Both are published as
  // `broadcast(channel, projectPath, payload)`; the client filters on the
  // project it is showing. Environment-scoped: a project directory is not
  // owned by a tab.
  { name: 'ion:graph-corpus-delta', scope: 'environment' },
  { name: 'ion:graph-view-config-changed', scope: 'environment' },
  // Export progress from `backup.export` ("Compressing N of M").
  { name: 'ion:conversation-backup-progress', scope: 'environment' },

  // ── Owner-published mirror sync ──────────────────────────────────────
  // The seven pushes a Studio window needs to stay in step with the store
  // owner. They were Electron `webContents.send` only, so a browser client
  // skipped all of them: no conversation terminal panel (the toggle flipped
  // server state the client never saw), no worktree inventory, no permission
  // clearing, no user-turn echo, and a rewind left a stale transcript.
  //
  // Four name (or carry) exactly one tab and are 'tab'-scoped like any other
  // per-tab channel above -- no separate mechanism needed.
  { name: 'studio:active-tab', scope: 'tab' },
  { name: 'studio:permission-resolved', scope: 'tab' },
  { name: 'studio:user-message-echo', scope: 'tab' },
  { name: 'studio:history-replace', scope: 'tab' },
  // A paired device asked to open a terminal's web application as a Studio
  // Browser Surface tab. Tab-scoped: the payload names the owning tab.
  { name: 'studio:open-web-application', scope: 'tab' },
  // Three are whole-store projections naming several tabs/conversations at
  // once (the multi-tenant gap report's A1: these three were broadcast
  // 'environment'-wide, which meant `studio:tabs-sync` sent every principal's
  // tab titles, working directories, conversation ids, live statuses, and
  // staged attachment content to every connection on every persistence tick).
  // 'per-principal': every connection is still subscribed, but
  // `mirror-projection.ts` projects the payload down to each connection's own
  // tabs before send.
  //
  // Manifest contract C3 names this channel `studio:terminal-sync`. The live
  // IPC constant that carries the same payload (a full conversation Terminal
  // Panel sync across every tab, per `IPC.STUDIO_CONVERSATION_TERMINALS` in
  // `types-ipc.ts`) is `studio:conversation-terminals` — there is no separate
  // `studio:terminal-sync` emitter anywhere in the codebase. This uses the
  // real, verified channel name rather than inventing a string with no
  // producer.
  { name: 'studio:conversation-terminals', scope: 'per-principal', delivery: 'latest' },
  { name: 'studio:worktree-sync', scope: 'per-principal', delivery: 'latest' },
  { name: 'studio:tabs-sync', scope: 'per-principal', delivery: 'latest' },
  { name: 'ion:explorer-state-changed', scope: 'environment' },
  { name: 'ion:models-updated', scope: 'environment' },
  // The provider/model configuration snapshots. Both are bare signals: the
  // client re-reads through `model.listTiers` / `provider.getDefault` rather
  // than trusting a pushed payload, matching how the Electron renderer has
  // always consumed these two IPC channels. Both views: a phone edits the
  // tiers and the default provider too.
  { name: 'ion:model-tiers-updated', scope: 'environment', views: ['mirror', 'thin'] },
  { name: 'ion:default-provider-updated', scope: 'environment', views: ['mirror', 'thin'] },
  // A delegated-CLI sign-in's stages. Both views: a phone starts and
  // finishes these sign-ins too.
  { name: 'ion:provider-login-event', scope: 'environment', views: ['mirror', 'thin'] },
  // An external edit to a watched file. Environment-scoped: a path is not
  // owned by a tab, and every client with the file open needs the reload.
  { name: 'ion:fs-file-changed', scope: 'environment' },
  // Directories under a watched root changed (`FsTreeChange`). Delivered
  // only to the connection that subscribed, for the reason `ion:git-event`
  // is: another client may be watching a different root.
  { name: 'ion:fs-tree-changed', scope: 'environment' },
  // Repo events for a watched repository. Environment-scoped in the spec
  // sense (no owning tab), but delivered only to the connection that
  // subscribed -- `git-actions.ts` sends it on that one connection rather
  // than broadcasting, since another client may be watching a different repo.
  { name: 'ion:git-event', scope: 'environment' },
  // Worktree announcements, produced by `worktree/title-announce.ts` and the
  // land path in `remote/handlers/worktree.ts` through the server's
  // `broadcast()`, which is a no-op for any channel absent from this list.
  { name: 'ion:worktree-titled', scope: 'environment' },
  { name: 'ion:worktree-landed', scope: 'environment' },
]

const LATEST_ONLY_CHANNELS: ReadonlySet<string> = new Set(EVENT_CHANNELS.filter((c) => c.delivery === 'latest').map((c) => c.name))

/** Whether a newer payload on `name` supersedes an unsent older one. */
export function channelKeepsLatestOnly(name: string): boolean {
  return LATEST_ONLY_CHANNELS.has(name)
}

/** Channel names, for a fast membership check without scanning the spec list. */
export const EVENT_CHANNEL_NAMES: ReadonlySet<string> = new Set(EVENT_CHANNELS.map((c) => c.name))

/** Whether a connection that asked for `view` is sent `name` at all. An unknown channel is sent to nobody. */
export function channelDeliveredToView(name: string, view: StudioView): boolean {
  const spec = EVENT_CHANNELS.find((c) => c.name === name)
  if (!spec) return false
  return (spec.views ?? ['mirror']).includes(view)
}

export function eventChannelScope(name: string): 'tab' | 'environment' | 'per-principal' | undefined {
  return EVENT_CHANNELS.find((c) => c.name === name)?.scope
}

/** The binary-frame channel header byte (see `codec.ts` `encodeBinary`/`decodeBinary`). */
export const BinaryChannel = {
  TERMINAL_DATA: 0x01,
  TERMINAL_RESIZE: 0x02,
  FILE_CHUNK: 0x03,
  /**
   * "No more FILE_CHUNK frames are coming for this key." Sent by whichever
   * side finished streaming, with an empty payload.
   *
   * Without it the receiver can only infer completion by counting bytes
   * against a total declared up front, which makes a wrong total
   * indistinguishable from a stalled link — the receiver waits forever for
   * bytes the sender already finished sending. The end marker is the sender
   * stating the fact instead, so a short stream fails immediately and says
   * how short it was.
   */
  FILE_END: 0x04,
  /**
   * Port Forward streams (`@ion/shared/port-forward`). The key is the stream
   * id the client chose in `port.open`. `PORT_DATA` carries the stream's bytes
   * either way. `PORT_END` says the sender has no more bytes (empty payload)
   * or abandoned the stream (one byte, `PORT_END_ABORT`). `PORT_CREDIT` is the
   * receiver granting the sender more bytes (a 4-byte big-endian count) once
   * it has written what it was sent.
   */
  PORT_DATA: 0x05,
  PORT_END: 0x06,
  PORT_CREDIT: 0x07,
} as const
export type BinaryChannel = (typeof BinaryChannel)[keyof typeof BinaryChannel]

const BINARY_CHANNEL_VALUES: ReadonlySet<number> = new Set(Object.values(BinaryChannel))

export function isBinaryChannel(value: number): value is BinaryChannel {
  return BINARY_CHANNEL_VALUES.has(value)
}
