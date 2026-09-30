import { setEnvironmentServerVersion } from './environment/actions'
import { isProcessEntry } from './entry-guard'
import { join } from 'path'
import { dataDir } from './paths'
import { resolveLocalStudioTarget } from './local-studio-socket'
import { log as _log, warn as _warn, error as _error, setLogLevel } from './logger'
import { publishEnterprisePolicy, settleEnterprisePolicyUnread } from './enterprise-policy-publish'
import { applyMachineIdentity, initServerEgress, installCrashHandlers } from './process-logging'
import { installExitHandlers } from './process-exit'
import { startWireLatency } from './protocol/wire-latency-probe'
import { readServerVersion } from './server-version'
import { loadStateFiles, StateFileCorrupt } from './persistence/state-files'
import { localPrincipal } from './identity/local-principal'
import { loadMachineIdentity } from './machine-identity'
import { loadOrMintEnvironmentId } from './identity/environment-id'
import { runPrincipalBackfill } from './persistence/principal-backfill'
import { runSettingsScopeMigration } from './persistence/settings-scope-migration'
import { runRetiredSettingsMigrations } from './persistence/settings-retired-keys-migration'
import { migrateToHostIdentity } from './identity/host-identity-migration'
import { applySubjectMoves } from './identity/subject-moves'
import { migratePairedDevices } from './auth/paired-device-migration'
import { startDiscovery, stopDiscovery, discovery } from './discovery/runtime'
import { checkEngineVersion } from './engine/version-check'
import { startHealth, type HealthHandle } from './http/health'
import { authConfigRoute } from './http/auth-config'
import { authPairRoute } from './http/auth-pair'
import { authLoginRoute, authCallbackRoute, authLogoutRoute } from './http/auth-browser-login'
import { authGitCallbackRoute } from './http/auth-git-callback'
import { browserSessionStore } from './auth/browser-session-store'
import { logIngestRoute } from './http/log-ingest'
import { versionzRoute } from './http/versionz'
import { setCompatContext } from './compat/runtime'
import { staticRoute } from './http/static'
import { engineBridge } from './state'
import { getEngineHostInfo } from './engine/engine-bridge-fs'
import { startTabSnapshotPolling } from './remote/snapshot-polling'
import { startStudioListeners, resolveStudioListenerOptions, type StudioListenersHandle } from './protocol/listener'
import { startRelayStudioListeners, refreshRelayStudioClients } from './protocol/relay-listener'
import { effectiveRelays } from './auth/relay-advertise'
import { probeRelayAuthConfig } from './remote/relay-auth'
import { getSignedInIdentity } from './oauth/entra-flow'
import { onPairingCompleted } from './auth/pairing-links'
import { loadServerConfig } from './config/server-config'
import { setCurrentServerConfig, isSharedTenancy, sharedTenancyIsExplicit, noteEnginePrincipalPartitioning } from './config/current'
import { wirePresenceDrivingTracking } from './protocol/presence'
import { DefaultAuthPolicy } from './auth/auth-policy'
import { credentialsStore, onCredentialsChanged } from './auth/credentials-store'
import { CLIENTS_CHANGED_CHANNEL } from '@ion/shared/types-environment-admin'
import { startRelayClients, type RelayClientsHandle } from './remote/relay-clients-boot'
import { bootRestoreTabs } from './hooks/boot-restore-tabs'
import { ensureHomeProject } from './bootstrap/home-project'
import { activateServerStore } from './store/activate-server-store'
import { activateResourceStatePersistence } from './engine/event-wiring-resource-state'
import { wireSessionPlaneEvents, wireEngineBridgeEvents, wireRemoteSessionPlaneForwarding } from './engine/event-wiring'
import { wireAutomationRuntime } from './automation/runtime'
import { wireWorktreePipelineProjection } from './remote/handlers/worktree-store-commands'
import { configureDeepLinks } from './deeplink/dispatch'
import { getDeepLinkToken } from './deeplink/token'
import { ensureHandoffDir } from './deeplink/handoff'
import { setAuthUrlOpener, broadcastAuthUrlOpener } from './oauth/url-opener'
import { wireProviderEvents } from './engine/provider-api'
import { wireThemePackEvents } from './themes-wiring'
import { startStructuralSnapshotFeed } from './remote/structural-poll'
import { startWatchdog } from './watchdog'
import { registerSettingsEditAsker, wireToolGateResponder } from './engine/tool-gate-responder'
import { wireQuestions } from './questions/questions-wiring'
import { hydrateChartCatalogFromDisk } from './engine/chart-restore'
import { restoreStudioTerminals } from './persistence/studio-terminal-persistence'
import { cleanOrphanedWorktrees } from './git/git-runner'
import { startWorktreeFreshnessPoll } from './worktree/freshness-poll'
import { installTelemetryHealthConsumer } from './engine/telemetry-health'
import { installMcpServersBroadcast } from './engine/mcp-servers-broadcast'
import { installSystemMetrics } from './system-metrics/runtime'
import { startConversationCleanup } from './maintenance/conversation-cleanup'
import { enterprisePolicyCache } from './state'
import { getEnterprisePolicy, getEnterprisePolicyNewConversationDefaults } from './engine/engine-bridge-fs'
import {
  tabsFile,
  sessionChainsFile,
  sessionLabelsFile,
  legacyTabsFileForBackend,
  legacySessionChainsFileForBackend,
  legacySessionLabelsFileForBackend,
} from './persistence/settings-store'
import { broadcast } from './broadcast'
import { setShutdownHandle } from './shutdown'
import { sessionPlane } from './state'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('main', msg, fields)
}

/**
 * How often to re-check `engineBridge.connected` between the events the
 * bridge itself emits. The bridge's own reconnect loop (`engine-bridge-connection.ts`)
 * flips `connected` on socket close/reconnect but only ever emits a public
 * 'reconnected' event on RECOVERY, not on loss -- polling is what lets
 * `/readyz` notice a drop within one interval instead of only on the next
 * successful reconnect.
 */
const ENGINE_READINESS_POLL_MS = 2000

/**
 * How `main()` ends the process on a fatal boot condition. A seam rather
 * than a bare `process.exit` so the boot tests can assert the refusal
 * without killing the vitest worker.
 */
let exitProcess: (code: number) => void = (code) => process.exit(code)
/** TEST ONLY: replace the fatal-exit seam. */
export function _setExitProcessForTest(fn: ((code: number) => void) | null): void {
  exitProcess = fn ?? ((code) => process.exit(code))
}

/**
 * Live engine readiness: connects, resolves the engine's version against
 * `server.json`'s `engine.minVersion`, and keeps polling `engineBridge.connected`
 * so a later drop (or recovery) is reflected on `/readyz` without a restart.
 */
function wireEngineReadiness(health: HealthHandle, minVersion: string): void {
  health.setReadiness({ ready: false, reason: 'engine_unreachable', detail: 'connecting to engine' })

  async function evaluateOnConnect(): Promise<void> {
    const info = await getEngineHostInfo()
    const version = info.ok && info.data ? info.data.version : undefined
    if (typeof version === 'string' && version) {
      const check = checkEngineVersion(version, minVersion)
      if (!check.ok) {
        health.setReadiness({
          ready: false,
          reason: 'engine_incompatible',
          detail:
            check.reason === 'unparseable_version'
              ? `engine version ${version} cannot be compared with required ${minVersion}`
              : `engine ${version} < required ${minVersion}`,
        })
        return
      }
    } else {
      warn('engine host info has no version field; skipping engine_incompatible check')
    }
    // FR-02: shared tenancy and FR-01 principal partitioning make opposite
    // assumptions -- shared tenancy means every connection sees every
    // tab, partitioning means each principal's own data is walled off
    // from others. Refuse to come up rather than silently let one
    // override the other's intent.
    noteEnginePrincipalPartitioning(info.ok && info.data?.principalPartitioning?.enabled === true)
    if (sharedTenancyIsExplicit() && info.ok && info.data?.principalPartitioning?.enabled) {
      health.setReadiness({
        ready: false,
        reason: 'tenancy_conflict',
        detail: 'server.json tenancy.mode is "shared" but the connected engine has principal partitioning enabled',
      })
      return
    }
    health.setReadiness({ ready: true })
  }

  engineBridge
    .connect()
    .then(evaluateOnConnect)
    .then(cacheEnterprisePolicy)
    .then(startConversationCleanupOnce)
    .catch((err: unknown) => {
      warn('initial engine connect failed; background reconnect loop will retry', { error: String(err) })
      // Welcomes wait for the first policy read; an unreachable engine must
      // not hold them. The reconnect path reads and publishes it later.
      settleEnterprisePolicyUnread('engine unreachable')
      health.setReadiness({ ready: false, reason: 'engine_unreachable', detail: String(err) })
    })

  engineBridge.on('reconnected', () => {
    log('engine reconnected; re-evaluating readiness')
    void evaluateOnConnect()
      .then(cacheEnterprisePolicy)
      .catch((err: unknown) => warn('post-reconnect readiness evaluation failed', { error: String(err) }))
  })

  const poll = setInterval(() => {
    if (!engineBridge.connected && health.getReadiness().reason !== 'engine_incompatible') {
      health.setReadiness({ ready: false, reason: 'engine_unreachable', detail: 'engine socket not connected' })
    }
  }, ENGINE_READINESS_POLL_MS)
  poll.unref()
}

/**
 * The enterprise policy blob (D-004), fetched once the bridge is up and kept
 * for the readers that run later: `studio_welcome.enterprisePolicy`, the
 * settings-group visibility filter, the theme lock, the automation policy,
 * the model-cache filter. A null policy (no enterprise config, engine
 * unreachable) means no constraints, the safe default for an unmanaged
 * install. This used to run only inside the desktop's own process, so a
 * server-served client saw no policy at all.
 */
async function cacheEnterprisePolicy(): Promise<void> {
  try {
    publishEnterprisePolicy(await getEnterprisePolicy())
  } catch (err) {
    warn('enterprise policy fetch failed; proceeding unconstrained', { error: String(err) })
    settleEnterprisePolicyUnread('fetch failed')
  }
  try {
    enterprisePolicyCache.newConversationDefaults = await getEnterprisePolicyNewConversationDefaults()
  } catch (err) {
    warn('new-conversation policy fetch failed; proceeding unconstrained', { error: String(err) })
  }
  log('enterprise policy cached', { has_policy: enterprisePolicyCache.policy !== null, has_defaults: enterprisePolicyCache.newConversationDefaults !== null })
  // The LAN-discovery seal lives in this policy and can arrive after boot.
  discovery()?.reconcile()
}

let conversationCleanupStarted = false

/**
 * Background conversation cleanup (dry-run by default), once per process.
 *
 * Explicit per-backend file paths rather than a lazy closure: an earlier
 * version resolved them inside the callback and silently returned `[]` on
 * any error, which once sent `excludeIds=[]` to the engine. The unified
 * files are the live sources; the legacy per-backend files are still read
 * during the merge-migration window. `conversationRetentionDays` (D-018)
 * turns the dry run into real deletions when the enterprise policy declares
 * a TTL, which is why this runs after the policy is cached.
 */
function startConversationCleanupOnce(): void {
  if (conversationCleanupStarted) return
  conversationCleanupStarted = true
  startConversationCleanup({
    tabsFiles: [tabsFile(), legacyTabsFileForBackend('api'), legacyTabsFileForBackend('cli')],
    chainsFiles: [sessionChainsFile(), legacySessionChainsFileForBackend('api'), legacySessionChainsFileForBackend('cli')],
    labelsFiles: [sessionLabelsFile(), legacySessionLabelsFileForBackend('api'), legacySessionLabelsFileForBackend('cli')],
  }, enterprisePolicyCache.policy?.conversationRetentionDays)
}

/** `main()`'s return type, extended with the Studio wire listeners child 07 adds. */
export interface ServerHandle extends HealthHandle {
  /** Null when boot stopped at the state-files gate (the Studio wire never started). */
  studio: StudioListenersHandle | null
  /** Null when boot stopped at the state-files gate, or `server.json` configures no `relays[]`. */
  relays: RelayClientsHandle | null
}

/**
 * Boot orchestrator (manifest spec 06 Phase 2, extended by child 07's Studio
 * wire and child 08's auth): paths → logger (self-inits at import via
 * `dataDir()`) → server.json → health (TCP + local socket, with the
 * `/auth/config`/`/auth/pair` routes attached) → state files → server-id →
 * local principal → backfill → Studio wire listeners (with the real
 * `DefaultAuthPolicy`) → relay clients → engine wiring.
 *
 * On `StateFileCorrupt`, only the health listener starts -- the process
 * stays up for probes (manifest: "process stays up for probes") but never
 * touches the store, the Studio wire, the relay clients, or the engine
 * bridge against a data root one of whose files could not even be parsed.
 */
export async function main(): Promise<ServerHandle> {
  const dir = dataDir()
  log('server boot starting', { dir })

  const config = loadServerConfig(dir)
  setCurrentServerConfig(config)

  /*
   * Apply the configured log level before anything else runs.
   *
   * `server-config.ts` has always parsed `server.json`'s `logLevel` (defaulting
   * to DEBUG), and nothing ever applied it: the logger's compiled-in `minLevel`
   * stayed INFO for the life of the process. A deployment configured for DEBUG
   * therefore wrote zero DEBUG lines, and every diagnostic placed at that level
   * -- the studio-wire fan-out decisions, snapshot hydration, queued user-turn
   * echoes -- was discarded before it reached the file.
   *
   * That is worse than an unset level, because the absence of those lines reads
   * as "this code path never ran" and sends the reader after the wrong cause.
   * It did exactly that during a live investigation.
   *
   * `log-level.ts#applyConfiguredLogLevel` is NOT reused here: it resolves from
   * the desktop's `settings.json`, which is a different file with a different
   * owner. The server's level is its own config's.
   */
  setLogLevel(config.logLevel)
  log('log level applied', { level: config.logLevel, source: 'server.json' })
  // Before anything else logs: a line written ahead of this ships nowhere.
  initServerEgress(config.logging, (oidcScope) =>
    engineBridge.request<{ accessToken?: string }>('oidc_token', { oidcScope }))
  // `loadServerConfig` already resolved the default (7331) when
  // `server.json` omits `listen.tcp.port` -- an explicit `0` (OS-assigned
  // ephemeral port, used by tests to avoid colliding across parallel runs)
  // must pass through unchanged, so no `|| DEFAULT_TCP_PORT` fallback here.
  const port = config.listen.tcp.port
  // The local socket/named pipe both `startHealth` and the Studio wire's
  // local listener bind. On win32 the pipe is named by the user's SID (see
  // local-studio-socket.ts); with no SID there is nothing discoverable to
  // bind, and a server nobody can reach is a defect to report, not a
  // degraded mode.
  let socketPath: string | undefined
  try {
    socketPath = config.listen.local ? resolveLocalStudioTarget(dir).path : undefined
  } catch (err) {
    error('local Studio listener has no address; refusing to boot without a reachable local wire', { error: String(err) })
    exitProcess(1)
    throw err
  }

  // `/auth/config`'s environmentId/label are not known until after the
  // state-files gate below (the server id is minted post-gate, matching
  // `loadOrMintEnvironmentId` runs after that gate), but the HTTP
  // route table is fixed at `startHealth()` call time. `authRuntime` is a
  // mutable holder `authConfigRoute`'s closure reads at REQUEST time, the
  // same pattern `protocol/listener.ts` uses for `cachedEngineVersion` --
  // updated in place once the real values are known, never rebuilt.
  const authRuntime = { environmentId: `boot-${process.pid}`, label: config.label, serverVersion: readServerVersion() }
  setEnvironmentServerVersion(authRuntime.serverVersion)
  setCompatContext({ serverVersion: authRuntime.serverVersion, engineMinVersion: config.engine.minVersion })
  const health = startHealth({
    port,
    host: config.listen.tcp.host,
    socketPath,
    // A second server on the same data dir is a defect, never a degraded
    // mode: it would adopt every tab against the engine alongside the first
    // and could not serve the local wire anyway. Exit non-zero so the
    // supervisor (the desktop's respawn ladder) reports the failure instead
    // of a half-running process logging warnings. The one time this
    // happened, the owner was an orphan of a previous desktop running older
    // code, and the new desktop had connected to it.
    onLocalSocketOwned: (ownedPath) => {
      error('another Studio server owns the local socket; refusing to run a second instance', {
        socket_path: ownedPath,
        pid: process.pid,
        hint: `stop the other server (lsof -U | grep studio.sock) or point ION_DATA_DIR elsewhere`,
      })
      exitProcess(2)
    },
    routes: {
      '/auth/config': authConfigRoute({ getOidc: () => config.oidc, getEnvironmentId: () => authRuntime.environmentId, label: authRuntime.label, serverVersion: authRuntime.serverVersion }),
      '/auth/pair': authPairRoute(credentialsStore()),
      '/auth/login': authLoginRoute(() => config.oidc),
      '/auth/callback': authCallbackRoute(() => config.oidc, browserSessionStore()),
      '/auth/logout': authLogoutRoute(browserSessionStore()),
      '/auth/git/callback': authGitCallbackRoute(() => config.git),
      '/versionz': versionzRoute(engineBridge),
      '/log': logIngestRoute({ getOidc: () => config.oidc, sessions: browserSessionStore() }),
    },
    notFound: staticRoute({ enabled: config.web.enabled }),
  })

  try {
    const files = loadStateFiles(dir)
    log('state files loaded', { present: Object.entries(files).filter(([, r]) => r.present).map(([name]) => name) })
  } catch (err) {
    if (err instanceof StateFileCorrupt) {
      error('state file corrupt; refusing to start store/engine wiring', {
        filename: err.filename,
        error: err.parseError.message,
      })
      health.setReadiness({
        ready: false,
        reason: 'state_file_corrupt',
        detail: `${err.filename}: ${err.parseError.message}`,
      })
      return { ...health, studio: null, relays: null, close: () => health.close() }
    }
    throw err
  }

  const { id: serverId, source: serverIdSource } = loadOrMintEnvironmentId(dir)
  log('server id resolved', { serverId, source: serverIdSource })
  authRuntime.environmentId = serverId

  // Seed the resource catalog with persisted charts BEFORE any client can
  // read it: charts are files on disk keyed by conversation id, so this
  // needs no session and no engine, and doing it before the listeners open
  // is what makes an attachments panel correct on first paint.
  hydrateChartCatalogFromDisk()

  const principal = localPrincipal()
  await runPrincipalBackfill(dir, principal)
  // A shared-tenancy install is one person's: every paired device acts as
  // the host identity, so anything still keyed by a device is folded in
  // before the listeners open and a device can authenticate as itself.
  // A phone paired on the desktop_* wire becomes a credentials client before
  // the listeners open, so its first Studio-wire hello already has a record.
  migratePairedDevices(credentialsStore())
  if (isSharedTenancy()) {
    migrateToHostIdentity(dir, principal.subject)
  } else {
    log('isolated tenancy: device-shaped principals left as they are')
  }
  // A person whose sign-in subject changed (the server moved to another app
  // registration) gets back what their old subject owned, before anything
  // looks a principal's data up.
  const subjectMoves = config.tenancy.subjectMoves ?? []
  if (subjectMoves.length > 0) applySubjectMoves(dir, subjectMoves)
  else log('no subject moves declared')
  // After the host-identity fold, so a paired device's values have already
  // joined the local account's overlay, and before anything reads a setting.
  runSettingsScopeMigration(principal.subject, dir)
  // Retired features' saved keys go with them (the Tab Strip, old panels).
  runRetiredSettingsMigrations(dir)
  // Must complete before bootRestoreTabs() below can create the first boot
  // tab, so a fresh personal instance's very first tab lands in the home
  // project directory instead of the bare $HOME.
  await ensureHomeProject(config.homeProject)

  const studio = startStudioListeners(health, {
    environmentId: serverId,
    label: config.label,
    serverVersion: authRuntime.serverVersion,
    authPolicy: new DefaultAuthPolicy({ oidc: config.oidc, credentials: credentialsStore(), sessions: browserSessionStore() }),
  })

  // Every client showing a Devices list re-reads it on this signal, so a
  // pairing completed anywhere shows up without anyone polling for it.
  onCredentialsChanged((change, clientIds) => {
    log('paired clients changed', { change, client_count: clientIds.length })
    broadcast(CLIENTS_CHANGED_CHANNEL, {})
  })

  // The snapshot tick serves thin Studio-wire connections as well as the
  // desktop_* transport, so it runs for the life of the server and idles
  // while neither kind of client exists.
  startTabSnapshotPolling()

  const relays = startRelayClients(config, serverId)
  // Studio connections through the relay (ADR-033): one E2E channel per
  // paired desktop, admitted by the same path as a TCP client. Reconciled
  // again whenever a pairing completes so the new client's channel is up
  // before its first connect.
  const relayStudio = startRelayStudioListeners({
    relays: effectiveRelays(config),
    listener: resolveStudioListenerOptions({
      environmentId: serverId,
      label: config.label,
      serverVersion: authRuntime.serverVersion,
      authPolicy: new DefaultAuthPolicy({ oidc: config.oidc, credentials: credentialsStore(), sessions: browserSessionStore() }),
    }),
    oidc: {
      probe: probeRelayAuthConfig,
      ownIssuer: async () => (await getSignedInIdentity())?.issuer ?? '',
      requestToken: (oidcScope, forceRefresh) => engineBridge.request<{ accessToken?: string; expiresAt?: number }>(
        'oidc_token',
        { oidcScope, oidcForceRefresh: forceRefresh || undefined },
      ),
    },
  })
  const unsubscribePairing = onPairingCompleted(({ clientId, kind }) => {
    log('pairing completed; reconciling relay channels', { client_id: clientId, kind })
    refreshRelayStudioClients()
  })

  wireEngineReadiness(health, config.engine.minVersion)
  wirePresenceDrivingTracking()

  // Must run before bootRestoreTabs: restoration issues real store mutations
  // that persistence/sync subscribers need to observe.
  activateServerStore()
  activateResourceStatePersistence()

  // The standalone server package is a second consumer of these engine/
  // control-plane event bridges (Electron's main/index.ts is the first,
  // desktop-specific one). They were never carried over when the server
  // package was extracted (ADR-033) -- most severely, wireSessionPlaneEvents
  // is what attaches the 'error' listener on sessionPlane; without it, any
  // EngineControlPlane emit('error', ...) throws as an unhandled EventEmitter
  // error and crashes the whole process (observed in production: a boot
  // restoration attach failure took down the pod). Must also run before
  // bootRestoreTabs for the same reason as the persistence activation above
  // -- restoration emits real events these wire up subscribers for.
  // The engine's tool gate (policy allow/deny plus every client tool: bench,
  // browser, graph, chart, telemetry, Guided Questions) is answered here.
  // Browser and graph bodies run in an attached Studio client and are
  // reached through reverse studio_commands; the responder only needs the
  // declarations. Guided Questions registers its human-wait fulfiller on
  // the responder, so it is wired right after and before any session event
  // can arrive.
  wireToolGateResponder(engineBridge)
  registerSettingsEditAsker((question) => sessionPlane.askSettingsEdit(question))
  wireQuestions(engineBridge)
  // Telemetry delivery health: retained here, described here, and broadcast
  // for whichever client wants to interrupt the operator about it.
  installTelemetryHealthConsumer(engineBridge)
  installMcpServersBroadcast(engineBridge)
  installSystemMetrics(engineBridge)
  wireSessionPlaneEvents()
  wireEngineBridgeEvents()
  wireRemoteSessionPlaneForwarding()
  wireAutomationRuntime()
  // iOS renders the worktree sync pipeline's banner from this projection.
  await wireWorktreePipelineProjection()
  // `ion://` deep links: the desktop hands the OS URL to `deeplink.dispatch`;
  // the dispatcher runs here against this store, and asks the desktop to
  // present its window when a confirmation is needed. The token the
  // terminals carry and the handoff directory are this process's too.
  configureDeepLinks({ presentConfirmation: () => { broadcast('ion:deeplink-present', { owner: 'studio' }); return 'studio' } })
  getDeepLinkToken()
  ensureHandoffDir()
  // Model-tier / default-provider snapshots reach clients as studio_events.
  // This wiring lived in desktop/src/main/ipc/models.ts, so the standalone
  // server emitted neither channel and a remote client never learned that
  // either had changed.
  wireProviderEvents((channel, payload) => broadcast(channel, payload))
  // Custom theme packs: `themes.list` answers the boot read; this pushes
  // `ion:themes-changed` when the on-disk set changes.
  wireThemePackEvents()

  // Interactive sign-in pages. A headless server cannot open a browser, so
  // the URL is broadcast and whichever Studio client is attached opens it.
  // Without this the OAuth, Entra, and MCP login flows would wait on a
  // callback nobody could ever trigger.
  setAuthUrlOpener(broadcastAuthUrlOpener)

  // The pieces that keep every attached client fed: the store-driven
  // snapshot feed and the main-thread stall watchdog.
  startStructuralSnapshotFeed()
  startWireLatency()
  startWatchdog({ logFile: join(dir, 'server.jsonl'), component: 'server' })

  // Boot-time maintenance the desktop used to run in its own process:
  // surface-terminal scrollback (studio: namespace) restored before any
  // client can attach, worktrees whose registry record outlived their
  // checkout swept, and the worktree/bench freshness poll that every
  // consumer (desktop, browser, iOS) reads the same answer from. The poll
  // is attention-gated inside its tick (`presence.attention`), so an
  // unattended Environment does no git work.
  restoreStudioTerminals()
  cleanOrphanedWorktrees().catch((err: unknown) => warn('orphaned worktree cleanup failed', { error: String(err) }))
  startWorktreeFreshnessPoll()

  // Fire-and-forget, matching the desktop's former Overlay-owned
  // useTabRestoration.ts: restoration runs concurrently with the rest of
  // boot rather than blocking it (a slow resumeSession on one tab must not
  // hold up readiness for every other consumer). Failures are logged inside
  // bootRestoreTabs itself; a rejection here would only ever be a bug in the
  // orchestration, not a per-tab failure.
  void bootRestoreTabs().catch((err: unknown) => error('boot tab restoration failed', { error: String(err) }))

  // The announcement carries this host's machine id, which is how a phone
  // recognises the server it is already paired with. `getMachineIdentity()`
  // is a per-process memory cache and this process never filled it: the
  // desktop loads the identity in ITS process, so the server announced an
  // empty `machine` and a paired phone could not match it. Awaited, because
  // an announcement that goes out before it resolves is the same silent
  // miss with better timing.
  try {
    const identity = await loadMachineIdentity()
    log('machine identity loaded for the announcement', { resolved_host: identity.host, has_machine_id: identity.machineId !== '' })
    // The same identity every log line should carry. It was loaded here and
    // never handed to the logger, so server lines had none of the fields the
    // log schema documents for them.
    applyMachineIdentity(identity)
  } catch (err) {
    // Not fatal: discovery still announces, a desktop can still find this
    // server by label, and only phone matching is lost.
    warn('machine identity unavailable; the announcement will carry none', { error: String(err) })
  }

  // LAN discovery: silent unless server.json asks for a persistent
  // announcement, a person opens a window, and no enterprise seal forbids it.
  startDiscovery({ environmentId: () => authRuntime.environmentId, serverVersion: authRuntime.serverVersion, port })

  log('server boot complete', { serverId, port, socket_path: socketPath, studio_listener_count: studio.wssList.length, relay_count: relays.clients.length, relay_studio_channels: relayStudio.channelCount() })
  return {
    ...health,
    studio,
    relays,
    close: async () => {
      stopDiscovery()
      unsubscribePairing()
      relayStudio.close()
      relays.close()
      await studio.close()
      await health.close()
    },
  }
}

// Auto-run only when this module is the process entry point -- true both for
// `node dist/main.js` (the esbuild bundle) and `node src/main.ts` in dev,
// including through a symlink (the installed layout's `current`), and false
// when a test imports `main` to call it directly against a mocked engine
// bridge. See entry-guard.ts for why a plain path comparison was wrong.
if (isProcessEntry(import.meta.url)) {
  // Before anything else in the entry path: a throw during boot must reach
  // server.jsonl, not only stderr.
  installCrashHandlers()
  installExitHandlers()
  main()
    .then((handle) => setShutdownHandle(handle))
    .catch((err: unknown) => {
      error('server boot failed', { error: String(err) })
      process.exitCode = 1
    })
}
