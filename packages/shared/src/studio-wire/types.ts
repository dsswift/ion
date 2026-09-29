/**
 * The Studio wire protocol (manifest contract C3): the frame union a Studio
 * client (desktop, browser, or a second desktop) exchanges with an Ion
 * Studio Server over one WebSocket per environment.
 *
 * Text frames carry a JSON-encoded `StudioFrame`. Binary frames carry a
 * 1-byte channel header (see `channels.ts` `BinaryChannel`) and are decoded
 * separately by `codec.ts`'s `encodeBinary`/`decodeBinary` — they are never
 * part of this union, which describes only the JSON side.
 */
import type { EnterprisePolicy } from '../types-enterprise'
import type { PersistedTab } from '../types-persistence'
import type { AutomationDefinition } from '../types-automation'
import type { StudioWorktreeSnapshot } from '../types-studio'
import type { StudioConversationTerminalSnapshot } from '../studio-conversation-terminal-sync'
import type { PresenceSnapshot } from '../types-presence'
import type { EnvironmentSystemMetrics } from '../types-system-metrics'
import type { TelemetryHealthState } from '../types-telemetry-health'
import type { EnvironmentRelay } from './relay-envelope'

/** The four operate-level scopes plus `admin`, from manifest contract C4. */
export type Scope = 'conversations:read' | 'conversations:operate' | 'terminal:operate' | 'git:write' | 'admin'

export const SCOPES: readonly Scope[] = [
  'conversations:read',
  'conversations:operate',
  'terminal:operate',
  'git:write',
  'admin',
]

/** The kind of Studio client presenting the hello. */
export type StudioClientKind = 'desktop' | 'web' | 'mobile-bridge' | 'mobile'

/**
 * Which view of the Environment a connection asked for at hello.
 *
 * `mirror` (the default when `studio_hello.view` is absent) is what Studio
 * gets: the whole store, raw engine events, and the owner-published sync
 * channels. `thin` is a server-derived view for a client that renders
 * conversations but does not hold a store: its welcome snapshot carries no
 * tabs, worktrees, terminals, or automations, and everything it needs rides
 * the single `studio:thin-event` channel (see `channels.ts`), each payload
 * one `RemoteEvent` from `remote-projection-types`.
 */
export type StudioView = 'mirror' | 'thin'

export const STUDIO_VIEWS: readonly StudioView[] = ['mirror', 'thin']

/**
 * `local` is the only credential kind this child resolves (accepted ONLY on
 * the server's local Unix-socket / named-pipe listener — never over TCP).
 * `paired` and `bearer` are typed here because they are part of the wire
 * contract child 08 (server-auth) fills in, but this child's `AuthPolicy`
 * refuses both unconditionally with `studio_refused{reason:'unauthorized'}`.
 *
 * `session` (spec 18 successor) carries no payload: the browser cannot read
 * its own HttpOnly `ion_session` cookie, so the credential just says
 * "authenticate me from whatever cookie arrived with this connection" — the
 * server resolves it from the raw WebSocket upgrade request, never from
 * anything the client claims in the frame (see `DefaultAuthPolicy`'s
 * `'session'` case and `protocol/connection.ts`'s `sessionCookie` field).
 */
export type StudioCredential =
  | { kind: 'local' }
  | { kind: 'paired'; clientId: string; proof: string }
  | { kind: 'bearer'; token: string }
  | { kind: 'session' }

export interface StudioPrincipalSummary {
  subject: string
  displayName: string
  /** Identity provider ('os' for the local principal, 'entra' for a bearer door). Absent for `local`/`paired` (child 08's `bearer.ts` is the only populator). */
  provider?: string
  /** SessionPrincipal-style kind ('local', 'operator', ...). Absent for `local`/`paired`. */
  kind?: string
  /** The bearer token's `preferred_username` claim, when present. */
  username?: string
  /** The bearer token's `email` claim (or `preferred_username` when that looks like an address), when present. Feeds git commit authorship (FR-04). */
  email?: string
}

/**
 * Enterprise policy as served to a Studio client. This is exactly the
 * engine's `get_enterprise_policy` payload (`EnterprisePolicy`) — no Studio
 * wire re-shaping — so a future field the engine adds reaches the client
 * without a second definition to keep in sync.
 */
export type EnterprisePolicySnapshot = EnterprisePolicy

/**
 * One tab's metadata as served in a snapshot: everything durable EXCEPT
 * `terminalBuffers` (raw terminal scrollback) and `conversationPane`
 * (message-content instance rows). A Studio client gets the tab list and its
 * durable fields; conversation bodies stream separately via
 * `studio_body_request`/`studio_body`.
 */
export type StudioSnapshotTab = Omit<PersistedTab, 'terminalBuffers' | 'conversationPane'>

/** Settings exposed to a Studio client — server-side keys only, never secrets. */
export type StudioSettingsSnapshot = Record<string, unknown>

export interface StudioEngineStatusSnapshot {
  connected: boolean
  version?: string
}

/**
 * The complete first-paint payload carried on `studio_welcome` and repeated
 * (in full — never a diff) on `studio_snapshot`. Never conversation bodies.
 */
export interface StudioSnapshot {
  tabs: StudioSnapshotTab[]
  /**
   * The model each conversation runs on: tab id → instance id → model id.
   * The server decides it (one resolver, the owner's Account settings) and a
   * client renders it, never a default of its own. `tabs` carries no
   * conversation pane, so first paint needs this beside it; after that the
   * same map rides `studio:tabs-sync` as `liveResolvedModel`. Absent on a
   * thin snapshot, whose tabs arrive as thin events.
   */
  resolvedModels?: Record<string, Record<string, string>>
  settings: StudioSettingsSnapshot
  worktrees: StudioWorktreeSnapshot
  /**
   * First-paint Conversation Terminal Panel state.
   *
   * Both this and `worktrees` exist because their boot PULL
   * (`studioGetConversationTerminals`, `studioGetWorktreeSync`) is an
   * Electron-only IPC verb with no browser equivalent, while their delta
   * channels are bridged and work everywhere. A browser client that pulled
   * got a thrown refusal out of a mount effect; one that only subscribed saw
   * nothing until the next change. Carrying the snapshot on the handshake
   * gives every client the same first paint over one transport.
   */
  terminals: StudioConversationTerminalSnapshot
  automations: AutomationDefinition[]
  engine: StudioEngineStatusSnapshot
  /** FR-02: every connected principal, their current tab focus, and per-tab driving state, for first paint -- see `studio:presence` and `protocol/presence.ts`. */
  presence: PresenceSnapshot
  /**
   * The Environment's latest System Metrics, for first paint. Live samples
   * ride `ion:system-metrics` only to a connection that watches
   * (`environment.systemMetrics.watch`). Absent before the first sample.
   */
  systemMetrics?: EnvironmentSystemMetrics
  /**
   * The current delivery health of every telemetry target the engine has
   * reported on. Live changes ride `ion:telemetry-health`; this replays the
   * current state to a client that connects mid-outage, which would
   * otherwise see nothing until the next transition. Empty when no target
   * has reported.
   */
  telemetryHealth?: TelemetryHealthState[]
}

export type StudioRefusalReason =
  | 'protocol_version'
  | 'unauthorized'
  | 'not_ready'
  | 'engine_incompatible'
  | 'duplicate_client'
  | 'scope'

/**
 * `displaced` closes a connection because the SAME client reconnected under
 * the same clientId and authenticated as the same subject. The new socket
 * takes over; the old one is told why rather than being left to guess.
 */
export type StudioCloseReason = 'slow_client' | 'token_expired' | 'revoked' | 'shutdown' | 'engine_lost' | 'displaced'

export interface StudioActionRefusal {
  code: string
  message: string
}

export interface StudioActionError {
  code: string
  message: string
}

export type StudioFrame =
  | {
      type: 'studio_hello'
      protocolVersion: number
      clientId: string
      clientKind: StudioClientKind
      capabilities: string[]
      credential: StudioCredential
      /** Absent means `mirror`, so every client that predates the field is unchanged. */
      view?: StudioView
    }
  | {
      type: 'studio_welcome'
      protocolVersion: number
      environmentId: string
      label: string
      platform: NodeJS.Platform
      serverVersion: string
      engineVersion: string
      capabilities: string[]
      principal: StudioPrincipalSummary
      scopes: Scope[]
      /**
       * The pairing this connection authenticated through (`credentials.json`
       * clientId), for a `paired` credential; absent for every other door. A
       * client uses it to recognise its own row in the devices list -- the
       * principal cannot tell devices apart, because on a shared install every
       * device acts as the same host identity.
       */
      pairedClientId?: string
      /**
       * The relays this server is reachable through and how to authenticate
       * to each, for a `paired` credential. A pair response says the same
       * thing once; this says it at every connect, so a pairing made before
       * the server had a relay learns of it without pairing again.
       */
      relays?: EnvironmentRelay[]
      /**
       * The LAN addresses this server answers on, for a `paired` credential.
       *
       * Same reason as `relays`, for the other route: a client learns where
       * to reach this server directly at EVERY connect, including a connect
       * that arrived over a relay. Without it the direct address could only
       * ever come from a Bonjour browse, so a client paired over a relay
       * never had one, and a client whose stored address went stale (the
       * server moved port, DHCP moved the host) could only be repaired by
       * switching LAN advertising back on. Discovery is for finding a server
       * to pair with; staying reachable afterwards is this.
       *
       * Literal addresses first, then the machine's own `.local` name. The
       * name is what still reaches a laptop after it moves to another
       * network, where every stored address is dead.
       */
      directAddresses?: string[]
      enterprisePolicy: EnterprisePolicySnapshot | null
      /**
       * Settings groups hidden from this connection: the enterprise device
       * policy's `customFields['ion-desktop'].hiddenSettingsGroups`, for the
       * local connection only. Device policy governs a person's own desktop,
       * so a visiting connection always gets an empty list. What a visiting
       * client may change is decided by its scopes, not by hiding groups.
       */
      settingsHiddenGroups: string[]
      /**
       * Whether this connection runs on the server's own host (it arrived on
       * the local socket). A sign-in that finishes through a loopback
       * callback on the host can only finish for a client where this is
       * true. Keyed on the connection, never on an environment id: a
       * browser attached to a headless server has the local environment id
       * and is still not on the host. Absent from an older server, which
       * reads as not on the host.
       */
      onHost?: boolean
      snapshot: StudioSnapshot
    }
  | {
      type: 'studio_refused'
      reason: StudioRefusalReason
      detail?: string
      requiredProtocolVersion?: number
    }
  | {
      type: 'studio_action'
      id: string
      action: string
      args: unknown[]
      /**
       * The sending window's active tab, for an action that names no tab and
       * acts on the active one (`ForwardedActionSpec.activeTab`). The server
       * makes it its active tab before the action runs, so the action lands
       * on the conversation the person is looking at, not on whichever tab
       * that server last had selected.
       */
      activeTabId?: string
      /**
       * The W3C trace context of the work this action starts, when one of its
       * arguments carries a `traceparent` (a prompt submit does). The server
       * reads the argument; a transport that crosses a relay copies this onto
       * the frame's outer envelope so the relay can record its own span.
       */
      traceparent?: string
    }
  | {
      type: 'studio_action_result'
      id: string
      ok: boolean
      value?: unknown
      refusal?: StudioActionRefusal
      error?: StudioActionError
    }
  | {
      type: 'studio_event'
      channel: string
      payload: unknown
    }
  | {
      type: 'studio_command'
      id: string
      command: string
      args: unknown
      timeoutMs: number
    }
  | {
      type: 'studio_command_result'
      id: string
      ok: boolean
      value?: unknown
      error?: string
    }
  | {
      type: 'studio_snapshot'
      snapshot: StudioSnapshot
    }
  | {
      type: 'studio_reauth'
      credential: { kind: 'bearer'; token: string }
    }
  | {
      type: 'studio_environment_policy'
      enterprisePolicy: EnterprisePolicySnapshot | null
      settingsHiddenGroups: string[]
      policyHash: string
    }
  | {
      /**
       * Ask the server to re-send its full `StudioSnapshot` as a
       * `studio_snapshot` frame. A client that rebinds its mirror to this
       * environment after having been connected for a while (the desktop
       * switching its active environment) hydrates from its retained last
       * welcome/snapshot first, then sends this so the mirror converges on
       * the server's current state rather than a possibly stale copy.
       */
      type: 'studio_snapshot_request'
    }
  | {
      type: 'studio_body_request'
      tabId: string
      instanceId?: string
      /**
       * Paging. Both absent: the whole transcript in one frame, which is what
       * a client on a fast local link wants. Either present: one page,
       * newest first, snapped to a turn boundary. `before` is the `cursor` a
       * previous page returned (a row id), absent for the newest page;
       * `limit` is the rows wanted, clamped by the server.
       *
       * A large transcript does not fit one frame on every route: a relay
       * caps a message, and a connection that buffers past its cap is closed.
       */
      before?: string
      limit?: number
      /**
       * Thin connections only: ask for a dispatched agent's transcript
       * instead of the tab's own. `tabId` names the tab that dispatched it;
       * `dispatchId` names the dispatch whose in-flight activity is laid on
       * top of the conversation file (absent when the agent has no
       * registered dispatch).
       */
      conversationId?: string
      dispatchId?: string
    }
  | {
      type: 'studio_body'
      tabId: string
      instanceId?: string
      /** A dispatch transcript's request fields, echoed. */
      conversationId?: string
      dispatchId?: string
      rows: unknown[]
      /** Paged replies only: whether older rows exist behind this page. */
      hasMore?: boolean
      /** Paged replies only: pass as the next request's `before`. Absent on the oldest page. */
      cursor?: string
      /**
       * Paged replies only: the request's own `before`, echoed (null for the
       * newest page). A client replaces its rows when this is null and
       * prepends when it is not -- never on `cursor`, which is set on every
       * page that has more behind it.
       */
      before?: string | null
      /**
       * Thin replies only: the transcript stream these rows belong to, and
       * where they sit in it. `rows` are `TranscriptRow`s at revision `rev`
       * of stream `streamId` (epoch `epoch`); `rows[0]` is row `startIndex`
       * of `total`. A newest-page reply subscribes the connection, and
       * `desktop_transcript_patch` events follow from `rev`. See
       * `@ion/shared/transcript/transcript-patch`.
       */
      streamId?: string
      epoch?: string
      rev?: number
      total?: number
      startIndex?: number
    }
  | {
      /**
       * A latency probe. The server sends it; a client answers `studio_pong`
       * with the same `nonce` as soon as it decodes it.
       *
       * The round trip is timed on the SERVER's clock, start to finish, so
       * there is no clock skew between two machines to estimate away -- the
       * measure that replaced it needed a heartbeat-seeded correction and
       * worked for one client kind. This works the same for every client and
       * every route: local socket, TCP and relay.
       *
       * Not the WebSocket-level ping in `protocol/listener.ts`: that one
       * exists to drop a socket an intermediary killed silently, carries no
       * payload a client can time, and on a relayed connection only reaches
       * the relay.
       *
       * Sent only to a client whose `studio_hello.capabilities` includes
       * `wire-ping`, so a client that predates these frames never receives
       * one it would refuse to decode.
       */
      type: 'studio_ping'
      /** Opaque, unique per probe. Echoed back unchanged. */
      nonce: string
      /** The server's clock when it sent this, for a client that wants to show its own view. */
      t: number
    }
  | {
      type: 'studio_pong'
      /** The `nonce` of the `studio_ping` being answered. */
      nonce: string
      /** The client's clock when it answered. Never differenced against `t` -- see `studio_ping`. */
      t: number
    }
  | {
      type: 'studio_close'
      reason: StudioCloseReason
      detail?: string
    }

/**
 * The capability a client advertises in `studio_hello.capabilities` to say it
 * can answer `studio_ping`. The server probes no connection without it.
 */
export const WIRE_PING_CAPABILITY = 'wire-ping'

/** Every `StudioFrame['type']` value, used by the codec's exhaustive switch. */
export type StudioFrameType = StudioFrame['type']
