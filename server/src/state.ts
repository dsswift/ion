import { registerEnterprisePolicySource } from "./enterprise-policy-source";
import type { ChildProcess } from "child_process";
import type { watch } from "fs";
import type { RendererSnapshotCache } from "@ion/shared/remote-projection-types";
import type { RemoteWorktreeState } from "./remote/protocol-worktree";
import { EngineBridge } from "./engine/engine-bridge";
import { EngineControlPlane } from "./engine/engine-control-plane";
import { wireEarlyStopPolicy } from "./engine/early-stop-policy";
import { wireCredentialResponder } from "./engine/credential-responder";
import { registerPrincipalSource } from "./credentials/principal-source";
import { adminRefsSource } from "./credentials/sources/admin-refs";
import { currentServerConfig } from "./config/current";
import { RelayDiscovery } from "./remote/discovery";

export const DEBUG_MODE = process.env.Ion_DEBUG === "1";
export const SPACES_DEBUG = DEBUG_MODE || process.env.Ion_SPACES_DEBUG === "1";

export interface FileWatcherEntry {
  watcher: ReturnType<typeof watch>;
  refCount: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export const engineBridge = new EngineBridge();
export const sessionPlane = new EngineControlPlane(engineBridge);

// Wire the reference policy for the engine's wire-protocol early-stop
// continuation hook. The server is one specific consumer of this hook; any
// harness engineer can implement their own policy in a similar way by
// subscribing to engine_early_stop_decision_request on their socket
// connection. See ./engine/early-stop-policy.ts for the architectural
// rationale (ported from the desktop's original consumer).
wireEarlyStopPolicy(
  sessionPlane as unknown as Parameters<typeof wireEarlyStopPolicy>[0],
  engineBridge,
);

// FR-05 child 09: register the shipped `admin` unified credential source
// (operator-managed server.json entries, both axes) and wire the responder
// that answers the engine's engine_credential_request with it. Registered
// once here, at the same construction point as the early-stop policy above
// -- this is the server's own reference PrincipalCredentialSource; any
// harness engineer can register their own via registerPrincipalSource.
registerPrincipalSource(
  adminRefsSource(
    () => currentServerConfig().providerCredentials,
    () => currentServerConfig().git.credentials,
  ),
);
wireCredentialResponder(
  sessionPlane as unknown as Parameters<typeof wireCredentialResponder>[0],
  engineBridge,
);
export const relayDiscovery = new RelayDiscovery();

export const bashProcesses = new Map<string, ChildProcess>();
export const fileWatchers = new Map<string, FileWatcherEntry>();
export const recentlyWrittenPaths = new Set<string>();
export const activeAssistantMessages = new Map<
  string,
  { id: string; content: string }
>();
export const lastMessagePreview = new Map<string, string>();
export const terminalOutputAccumulator = new Map<string, string>();

/**
 * Server-side scrollback buffer per terminal key.
 * Accumulates terminal output so that a terminal-snapshot request can be
 * served even when no client has an attached xterm instance for the
 * terminal (e.g. a terminal tab created remotely from iOS or a paired
 * desktop). Capped at MAX_SCROLLBACK_SIZE bytes per key.
 */
export const terminalScrollback = new Map<string, string>();
export const MAX_SCROLLBACK_SIZE = 100_000;

interface MutableState {
  forceQuit: boolean;
  toggleSequence: number;
  screenshotCounter: number;
  cachedFonts: string[] | null;
  terminalOutputFlushTimer: ReturnType<typeof setInterval> | null;
  tabSnapshotInterval: ReturnType<typeof setInterval> | null;
  /**
   * Last store-pushed remote tab-state projection. Every connected Studio
   * client session that hosts the store pushes RemoteTabStatesPayload on
   * store change (debounced); the snapshot builder serves this cache when
   * fresh. Null until the first push.
   */
  rendererSnapshotCache: RendererSnapshotCache | null;
  /** Last full worktree projection per repo, used by first-render snapshots. */
  remoteWorktreeStates: Map<string, RemoteWorktreeState>;
  /**
   * The active tab ID and engine profile used to seed the Studio window.
   * Set by the desktop's `wireTabFocusHandler` (main/ipc/resource-wiring.ts,
   * the Electron `ipcMain` registration for `NOTIFY_TAB_FOCUS`) on every
   * active-tab change; read by the desktop's studio-window-manager to seed a
   * newly-opened Studio window and by ipc/studio.ts to resolve the "no tabId
   * given" default target. Lives here rather than desktop-local state so
   * server-side engine wiring (studio-window-manager's own notification path)
   * can read it without an Electron-bound import.
   */
  studioActiveTabId: string | null;
  studioActiveProfileId: string | null;
}

export const state: MutableState = {
  forceQuit: false,
  toggleSequence: 0,
  screenshotCounter: 0,
  cachedFonts: null,
  terminalOutputFlushTimer: null,
  tabSnapshotInterval: null,
  rendererSnapshotCache: null,
  remoteWorktreeStates: new Map(),
  studioActiveTabId: null,
  studioActiveProfileId: null,
};

/**
 * Cached model list from engine, populated by the model-list bridge call and
 * included in remote snapshots.
 *
 * `providerLabel` is the resolved human-facing provider name (operator
 * `engine.json` displayName > built-in name map > capitalized id), flattened
 * onto each model at projection time the same way `hasAuth` is. iOS never
 * receives `ProviderEntry`, so this is how the phone's provider-grouped model
 * picker gets its section headers without duplicating the name table.
 */
export const modelCache = {
  models: [] as Array<{
    id: string;
    providerId: string;
    providerLabel: string;
    label: string;
    contextWindow: number;
    hasAuth: boolean;
    thinkingMode?: string;
    thinkingEfforts?: string[];
    modelKind?: string;
    isCustom?: boolean;
    maxOutputTokens?: number;
    effectiveContextLimit?: number;
    costPer1kInput?: number;
    costPer1kCacheCreation?: number;
    costPer1kCacheRead?: number;
    supportsCaching?: boolean;
    cacheTtlSeconds?: number;
  }>,
  lastFetched: 0,
};

import { enterprisePolicyCache } from './enterprise-policy-publish';
export { enterprisePolicyCache };

// The model resolver and the settings-files guard read this policy at call
// time, so it is wired where the cache is made: before any conversation is
// restored and resolved.
registerEnterprisePolicySource(() => enterprisePolicyCache.policy);


/**
 * Per-session extension-command registry cache.
 *
 * Keyed by engine session key — `tabId` for CLI tabs, `${tabId}:${instanceId}`
 * for engine tabs (matches the keying used by `engineBridge.sendCommand`).
 * Populated and invalidated by `engine_command_registry` events emitted from
 * the Go engine (see `engine/internal/session/command_registry.go`). The cache
 * is a routing HINT for the unified prompt pipeline, not a source of truth:
 *
 *   - HIT  → "this name is registered with extensions on this session,
 *            dispatch confidently."
 *   - MISS → "either the name is not an extension command OR our snapshot is
 *            stale (mid-session registration race). Dispatch anyway; the
 *            engine resolves the live table at dispatch time and emits
 *            engine_command_result with CommandError='unknown_command' if it
 *            resolves the name through its complete command precedence chain, including `.md`
 *            expansion on that signal."
 *
 * Snapshot semantics: every event REPLACES the prior entry for the key. An
 * empty `commands: []` payload is the authoritative "no extension commands
 * live for this session" signal — we delete the cache entry on empty so a
 * subsequent re-population creates a fresh entry.
 *
 * Entries are populated reactively from engine events; never written by
 * dispatch code. Reads are O(1) Set.has lookups, called once per slash
 * command parsed by the unified pipeline.
 */
export const extensionCommandRegistry = new Map<string, Set<string>>();

/**
 * Per-device iOS focus and intercept-preference state.
 *
 * Keyed by deviceId. iOS sends `report_focus` whenever the focused tab changes,
 * the app foregrounds/backgrounds, or the intercept preference toggles. The
 * server reads this map in `event-wiring-intercept.ts` when an
 * `engine_intercept` event arrives to decide which devices to forward it to
 * and whether to perform abort + re-prompt for "redirect" level events.
 *
 * tabId null means the iOS device is backgrounded or has no tab focused.
 * Entries are removed when the device disconnects (see transport-init.ts).
 */
export const deviceFocusMap = new Map<
  string,
  { tabId: string | null; interceptEnabled: boolean }
>();

/**
 * Dedupe set for AskUserQuestion / ExitPlanMode `permission_request`
 * envelopes synthesized from engine-view `engine_status.permissionDenials`
 * and forwarded to iOS. The engine emits engine_status repeatedly
 * (cost-only ticks fire ~1ms after the denial-carrying tick), so we'd
 * otherwise re-push the same `denied-<toolUseId>` question over and over
 * — each one fires a push notification, which is the visible spam.
 *
 * Keyed by the synthetic `questionId` (`denied-<toolUseId>`). The toolUseId
 * is engine-assigned and unique per call, so a fresh question always
 * misses the set. Entries are cleared:
 *   - When the user answers (the owning client clears tab.permissionDenied →
 *     next engine_status sees no denials → nothing to forward; the answered
 *     toolUseId is never seen again because the engine doesn't re-emit it).
 *   - When the engine tab is closed (closeTab; see wiring below).
 *
 * Memory bound: ~one entry per AskUserQuestion ever asked on this server
 * process. Acceptable — toolUseId is a short string and the process is
 * already long-lived; if it becomes a leak we can prune on engine_dead
 * or on snapshot reconcile.
 */
export const forwardedEnginePermissionDenials = new Set<string>();

/**
 * Last tab status forwarded to iOS for extension-hosted conversations.
 *
 * Extension-hosted events bypass `EngineControlPlane` (compound key mismatch:
 * the control plane is keyed by bare tabId, engine-view events arrive as
 * `tabId:instanceId`). That means no `tab-status-change` event fires on
 * the sessionPlane for extension tabs — iOS never learns the tab transitioned
 * from 'running' to 'idle'/'completed'.
 *
 * `wireEngineBridgeEvents` synthesizes `tab_status` messages for iOS from
 * `engine_status.fields.state`. This map deduplicates: we only forward
 * when the derived status differs from the last forwarded value.
 *
 * Keyed by bare tabId (not compound key) since `tab_status` is a per-tab
 * concept on iOS.
 */
export const lastForwardedTabStatus = new Map<string, string>();

/**
 * Dedup guard for desktop_tab_meta cost deltas emitted on each engine_status
 * tick. Keyed by bare tabId → last forwarded runCostUsd. Prevents flooding
 * iOS with repeated cost pushes when engine_status fires repeatedly at the
 * same cost during idle polling.
 */
export const lastForwardedTabMeta = new Map<string, number>();
