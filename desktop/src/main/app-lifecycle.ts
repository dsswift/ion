import { app, BrowserWindow, globalShortcut, Menu, screen } from 'electron'
import { existsSync, rmSync, writeFileSync } from 'fs'
import { readFileSync } from 'fs'
import { join } from 'path'
import { log as _log, warn as _warn, error as _error, flushLogs, initLoggerMachineIdentity } from './logger'
import { loadMachineIdentity } from './machine-identity'
import { state, SPACES_DEBUG, sessionPlane, engineBridge, fileWatchers, bashProcesses, enterprisePolicyCache } from './state'
import { terminalManager } from './terminal-manager-instance'
import { stopTabSnapshotPolling } from './remote/snapshot-polling'
import { createTray, createWindow, installContentSecurityPolicy, snapshotWindowState, showWindow, toggleWindow } from './window-manager'
import { focusAtvWindow, isAtvWindowOpen, openAtvWindow, toggleAtvWindow, applyAtvPin, isAtvPinned } from './atv-window-manager'
import { resolveSurfacePlan } from './surface-launch'
import { requestPermissions } from './permissions-preflight'
import { cleanOrphanedWorktrees } from './git-runner'
import { focusState } from './git/focus-state'
import { startConversationCleanup } from './conversation-cleanup'
import {
  TABS_FILE,
  SESSION_CHAINS_FILE,
  SESSION_LABELS_FILE,
  legacyTabsFileForBackend,
  legacySessionChainsFileForBackend,
  legacySessionLabelsFileForBackend,
  ENGINE_CONFIG_FILE,
  ensureHybridBackendConfig,
  readSettings,
} from './settings-store'
import { ensureEngineDaemon, restartEngineDaemon } from './engine-bootstrap'
import { claimEngineEgressForDesktop } from './engine-egress-claim'
import { configureEgress, closeEgress, setEgressUser, type EgressConfig, type AuthHeaderProvider } from './log-egress'
import { startEgressTailers, stopEgressTailers } from './log-egress-tailer'
import { getAccessToken, getSignedInIdentity, ensureEntraAuthConfig } from './oauth/entra-auth'
import { getEnterprisePolicy } from './engine-bridge-fs'
import { initAutoUpdater } from './updater'
import { startWatchdog, stopWatchdog } from './watchdog'

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
 * Read egress config from engine.json (logging.egressTargets / egressEndpoint etc.)
 * and configure the desktop egress forwarder.
 *
 * Nil/absent egress config = complete no-op (default installs unchanged). Enterprise
 * enforcement (EnforceEnterprise in the engine) can seal egress on via
 * enterprise.logging.egressTargets; the desktop respects whatever the merged
 * engine.json contains.
 */
function initEgressFromEngineConfig(): void {
  if (!existsSync(ENGINE_CONFIG_FILE)) return
  try {
    const raw = JSON.parse(readFileSync(ENGINE_CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    const logging = raw.logging as Record<string, unknown> | undefined
    if (!logging) return

    const targets = logging.egressTargets as string[] | undefined
    if (!Array.isArray(targets) || targets.length === 0) return

    const cfg: EgressConfig = {
      egressTargets: targets,
      egressEndpoint: typeof logging.egressEndpoint === 'string' ? logging.egressEndpoint : undefined,
      egressHeaders: typeof logging.egressHeaders === 'object' && logging.egressHeaders !== null
        ? logging.egressHeaders as Record<string, string>
        : undefined,
      egressBatchSize: typeof logging.egressBatchSize === 'number' ? logging.egressBatchSize : undefined,
      egressFlushIntervalMs: typeof logging.egressFlushIntervalMs === 'number' ? logging.egressFlushIntervalMs : undefined,
      egressOtel: typeof logging.egressOtel === 'object' && logging.egressOtel !== null
        ? logging.egressOtel as import('./log-egress').EgressOtelConfig
        : undefined,
    }

    // Shipping-responsibility matrix: the desktop's share is
    // logging.egressClientShipSources. Unset preserves the legacy
    // single-collection-point default (the desktop ships everything).
    const rawClientSources = logging.egressClientShipSources
    const clientSources: string[] = Array.isArray(rawClientSources)
      ? (rawClientSources as string[])
      : ['desktop', 'engine', 'ios', 'telemetry']
    if (clientSources.length === 0) {
      log('app_lifecycle: matrix assigns the desktop no sources; egress left to the engine', { targets })
      return
    }

    // OIDC header provider: called at every flush for a fresh token. The
    // engine owns the grant and mints ephemeral access tokens on demand
    // (oidc_token). Returns {} when signed out / unconfigured, so egress
    // still functions against a no-auth sink and simply receives 401 from
    // an authenticated sink until the user completes sign-in.
    const oidcHeaderProvider: AuthHeaderProvider = async () => {
      try {
        const token = await getAccessToken()
        if (token) return { Authorization: `Bearer ${token}` }
      } catch {
        // Non-fatal: fall through to unauthenticated egress.
      }
      return {} as Record<string, string>
    }

    configureEgress(cfg, oidcHeaderProvider, {
      shipOwnRecords: clientSources.includes('desktop'),
    })
    // F4: populate user-attribution field on egress records. Read the signed-in
    // identity (from the engine's snapshot) so the field is set before the first
    // flush. If not signed in yet, the field remains absent (omitted by default).
    getSignedInIdentity().then((identity) => {
      if (identity) setEgressUser(identity.user)
    }).catch((err) => log("app_lifecycle: egress user identity read failed", { error: String(err) }))
    startEgressTailers(clientSources)
    log('app_lifecycle: egress configured', { targets, sources: clientSources })
  } catch (err) {
    log('app_lifecycle: egress config read failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Read egress config from settings.json (logging.egressTargets / egressOtel etc.)
 * and configure the desktop egress forwarder.
 *
 * This is the desktop-owned shipping path, separate from the engine's own
 * egress config in engine.json. When configured here, the desktop ships all
 * four local log sources (desktop, engine, iOS, telemetry) to the specified
 * endpoint under its own authenticated identity. The engine ships nothing unless
 * it has its own egressTargets set in engine.json — the two are independent.
 *
 * Nil/absent logging block = complete no-op.
 */
function initEgressFromSettingsConfig(): void {
  try {
    const raw = readSettings()
    const logging = raw.logging as Record<string, unknown> | undefined
    if (!logging) return

    const targets = logging.egressTargets as string[] | undefined
    if (!Array.isArray(targets) || targets.length === 0) return

    const cfg: EgressConfig = {
      egressTargets: targets,
      egressEndpoint: typeof logging.egressEndpoint === 'string' ? logging.egressEndpoint : undefined,
      egressHeaders: typeof logging.egressHeaders === 'object' && logging.egressHeaders !== null
        ? logging.egressHeaders as Record<string, string>
        : undefined,
      egressBatchSize: typeof logging.egressBatchSize === 'number' ? logging.egressBatchSize : undefined,
      egressFlushIntervalMs: typeof logging.egressFlushIntervalMs === 'number' ? logging.egressFlushIntervalMs : undefined,
      egressOtel: typeof logging.egressOtel === 'object' && logging.egressOtel !== null
        ? logging.egressOtel as import('./log-egress').EgressOtelConfig
        : undefined,
    }

    // OIDC header provider: called at every flush for a fresh token.
    // Returns {} when signed out / unconfigured — egress still functions
    // against a no-auth sink and receives 401 from an authenticated sink
    // until the user completes sign-in.
    const oidcHeaderProvider: AuthHeaderProvider = async () => {
      try {
        const token = await getAccessToken()
        if (token) return { Authorization: `Bearer ${token}` }
      } catch {
        // Non-fatal: fall through to unauthenticated egress.
      }
      return {} as Record<string, string>
    }

    // Desktop always ships all four local sources when settings egress is enabled.
    // No shipping matrix needed: the desktop is the sole shipper for these files
    // in this deployment; the engine is configured separately via engine.json.
    configureEgress(cfg, oidcHeaderProvider, { shipOwnRecords: true })
    getSignedInIdentity().then((identity) => {
      if (identity) setEgressUser(identity.user)
    }).catch((err) => log("app_lifecycle: egress user identity read failed", { error: String(err) }))
    startEgressTailers(['desktop', 'engine', 'ios', 'telemetry'])
    log('app_lifecycle: settings egress configured', { targets })
  } catch (err) {
    log('app_lifecycle: settings egress config read failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Force the renderer to flush any pending debounced tab persistence.
 * The Zustand store debounces persistTabs() at 100ms — if we call
 * app.exit(0) before the timer fires, the latest tab state (including
 * conversationId, titles, etc.) is lost. This mirrors the pattern used
 * by SWITCH_BACKEND in ipc/settings.ts.
 */
async function flushRendererTabs(): Promise<void> {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      await win.webContents.executeJavaScript(
        'window.__ionForceFlushTabs && window.__ionForceFlushTabs()',
      )
    } catch {
      // Window may already be destroyed or renderer unresponsive — safe to skip.
    }
  }
}

export function setupAppLifecycle(): void {
  // Resolve stable machine identity early (before the first log line is written
  // to egress). Non-fatal — errors are swallowed and identity fields are simply
  // absent. loadMachineIdentity resolves quickly on all platforms; the host name
  // is always available and ioreg/plutil are fast on modern macOS.
  loadMachineIdentity().then(initLoggerMachineIdentity).catch(() => { /* non-fatal */ })

  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide()
    }

    // Start the main-thread stall watchdog first, so it is already observing if
    // any later startup step wedges the main thread. It runs on its own worker
    // thread and writes stall diagnostics that survive a main-thread freeze —
    // the one condition under which the main-process logger itself goes blind.
    startWatchdog()

    await requestPermissions()

    // Claim engine-log egress for the desktop before bootstrapping the daemon.
    // When egress is configured and no explicit shipping matrix is present,
    // the desktop is the sole authenticated shipper (it tails engine.jsonl);
    // stamping egressManagedByClient=true suppresses the engine's own
    // forwarder so engine lines aren't double-shipped. Stamped before
    // ensureEngineDaemon() so a fresh daemon start honors it immediately.
    claimEngineEgressForDesktop()

    // Seed the Ion Entra app registration into engine.json's auth block
    // (identityProvider=entra) so the ENGINE owns the OIDC identity: login
    // flow, grant persistence, silent refresh, per-scope minting. Same
    // pre-daemon timing rationale as the egress claim above. Idempotent —
    // never overwrites an operator/enterprise identity choice.
    ensureEntraAuthConfig()

    // Opt into credential-based per-provider routing: the desktop writes
    // backend:"hybrid" into engine.json (the engine default stays api for
    // headless consumers). Stamped pre-daemon like the claims above so a
    // fresh daemon start honors it; if the daemon was already running with
    // the old value, recycle it below so routing flips without a full
    // app relaunch. One-time transition per machine.
    const backendConfigChanged = ensureHybridBackendConfig()

    // Ensure the engine daemon is installed, current, and running before
    // creating the window. The bootstrap is idempotent: writes/refreshes the
    // LaunchAgent plist, copies the binary if version-mismatched, runs
    // install-assets, and kickstarts the daemon. On non-macOS this is a no-op.
    await ensureEngineDaemon()
    if (backendConfigChanged) {
      restartEngineDaemon()
    }

    // Configure egress forwarder from engine.json before connecting — that
    // way the first engine events are captured even if egress is configured.
    initEgressFromEngineConfig()

    // Configure desktop-owned egress from settings.json. Independent of
    // engine egress: the desktop ships its own sources (desktop, engine,
    // iOS, telemetry) to the endpoint configured here; the engine ships
    // nothing unless separately configured in engine.json.
    initEgressFromSettingsConfig()

    // Connect to the engine daemon. The bridge retries with backoff if the
    // daemon is still starting after a fresh kickstart.
    try {
      await engineBridge.connect()
    } catch (err: any) {
      log('app_lifecycle: engine connect failed, will retry', { error: err.message })
    }

    // Fetch the enterprise policy blob (D-004) once the bridge is up. The
    // policy is a read-only runtime constraint consumed by the auto-updater
    // gate (D-012) and the conversation-cleanup TTL (D-018) below. A null
    // policy (no enterprise config, engine unreachable) means no constraints
    // — the safe default that preserves unmanaged-install behavior.
    let enterprisePolicy: import('../shared/types-engine').EnterprisePolicy | null = null
    try {
      enterprisePolicy = await getEnterprisePolicy()
    } catch (err: any) {
      log('app_lifecycle: enterprise policy fetch failed, proceeding unconstrained', { error: err.message })
    }
    // Cache the policy for main-process consumers that run later: the model
    // cache filter (D-011 iOS-parity in ipc/models.ts) reads it on every
    // list_models refresh.
    enterprisePolicyCache.policy = enterprisePolicy

    // Auto-updater (D-012): enterprise-managed installs pin their version
    // through MDM; the app-level updater must not fight it. The flag rides
    // the desktop-owned customFields['ion-desktop'] namespace of the blob.
    const ionDesktopFields = (enterprisePolicy?.customFields?.['ion-desktop'] ?? {}) as import('../shared/types-engine').IonDesktopPolicyFields
    const disableAutoUpdate = ionDesktopFields.disableAutoUpdate === true
    if (disableAutoUpdate) {
      log('app_lifecycle: auto-update disabled by enterprise policy')
    }
    initAutoUpdater({ disableAutoUpdate })

    installContentSecurityPolicy()

    cleanOrphanedWorktrees().catch((err: Error) => log('app_lifecycle: worktree cleanup failed', { error: err.message }))

    // Launch-surface resolution: which surface(s) the user sees first. The
    // overlay window is ALWAYS created (its renderer owns session state);
    // only its visibility is governed here.
    const surfacePlan = resolveSurfacePlan(readSettings())
    log('surface plan resolved', { ...surfacePlan })

    createWindow(surfacePlan.showOverlayOnLaunch)
    snapshotWindowState('after createWindow')

    const pidDir = app.getPath('userData')
    const pidPath = join(pidDir, 'ion.pid')
    writeFileSync(pidPath, String(process.pid))
    log('app_lifecycle: pid file written', { path: pidPath, pid: process.pid })

    // Rebuilt (not mutated) whenever a checkbox state changes — Electron
    // menus are immutable snapshots. The Window menu carries the ATV pin
    // toggle so the visualizer chrome stays free of window-management UI.
    function buildAppMenu(): void {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        // Standard window controls (minimize/zoom/front). Matters while the ATV
        // holds Dock presence: without a Window menu the regular-policy menu bar
        // looks broken and window-management shortcuts don't route.
        {
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'zoom' },
            { type: 'separator' },
            {
              label: 'Pin Visualizer',
              type: 'checkbox',
              checked: isAtvPinned(),
              click: () => {
                applyAtvPin(!isAtvPinned())
                buildAppMenu()
              },
            },
            { type: 'separator' },
            { role: 'front' },
          ],
        },
      ]))
    }
    buildAppMenu()

    app.on('browser-window-focus', () => focusState.setFocused(true))
    app.on('browser-window-blur', () => {
      focusState.setFocused(BrowserWindow.getAllWindows().some((w) => w.isFocused()))
    })

    if (SPACES_DEBUG) {
      state.mainWindow?.on('show', () => snapshotWindowState('event window show'))
      state.mainWindow?.on('hide', () => snapshotWindowState('event window hide'))
      state.mainWindow?.on('focus', () => snapshotWindowState('event window focus'))
      state.mainWindow?.on('blur', () => snapshotWindowState('event window blur'))
      state.mainWindow?.webContents.on('focus', () => snapshotWindowState('event webContents focus'))
      state.mainWindow?.webContents.on('blur', () => snapshotWindowState('event webContents blur'))

      app.on('browser-window-focus', () => snapshotWindowState('event app browser-window-focus'))
      app.on('browser-window-blur', () => snapshotWindowState('event app browser-window-blur'))

      screen.on('display-added', (_e, display) => {
        log('app_lifecycle: display added', { display_id: display.id })
        snapshotWindowState('event display-added')
      })
      screen.on('display-removed', (_e, display) => {
        log('app_lifecycle: display removed', { display_id: display.id })
        snapshotWindowState('event display-removed')
      })
      screen.on('display-metrics-changed', (_e, display, changedMetrics) => {
        log('app_lifecycle: display metrics changed', { display_id: display.id, changed: changedMetrics.join(',') })
        snapshotWindowState('event display-metrics-changed')
      })
    }

    // Alt+Space drives the overlay glass; under an 'atv-only' policy it
    // retargets to the ATV so the muscle-memory hotkey still works.
    const overlayToggle = surfacePlan.overlayEnabled
      ? () => toggleWindow('shortcut Alt+Space')
      : () => toggleAtvWindow('shortcut Alt+Space (atv-only policy)')
    const registered = globalShortcut.register('Alt+Space', overlayToggle)
    if (!registered) {
      log('Alt+Space shortcut registration failed — macOS input sources may claim it')
    }
    globalShortcut.register('CommandOrControl+Shift+K', () => toggleWindow('shortcut Cmd/Ctrl+Shift+K'))
    // The ATV's own global shortcut (configurable; '' = none / disabled by
    // policy). Same show/focus/hide toggle model as the overlay's Alt+Space.
    if (surfacePlan.atvShortcut) {
      const ok = globalShortcut.register(surfacePlan.atvShortcut, () => toggleAtvWindow(`shortcut ${surfacePlan.atvShortcut}`))
      if (!ok) log('atv shortcut registration failed', { accelerator: surfacePlan.atvShortcut })
    }

    createTray()

    if (surfacePlan.openAtvOnLaunch) {
      openAtvWindow('launch surface')
    }

    // Background conversation cleanup (dry-run by default).
    //
    // We pass explicit per-backend file paths instead of deriving them
    // inside a closure. The previous version did `require('./settings-store')`
    // lazily inside the callback and silently returned `[]` on any error,
    // which on June 7 caused the desktop to send `excludeIds=[]` to the
    // engine. With DRY_RUN=true that was harmless; with DRY_RUN=false it
    // would have deleted ~51 tab-referenced conversations. See
    // docs/plans/grassy-chirping-crest.md Layer 2 for the full analysis.
    //
    // The unified files are the live sources; the legacy per-backend files
    // are still read during the merge-migration window — a conversation
    // referenced only by a not-yet-merged legacy file is still a valid
    // resumable conversation and must not be deleted.
    //
    // conversationRetentionDays (D-018): when the enterprise policy declares
    // a TTL, the cleanup performs real deletions against it; absent policy
    // keeps the dry-run default (nothing deleted).
    startConversationCleanup({
      tabsFiles: [TABS_FILE, legacyTabsFileForBackend('api'), legacyTabsFileForBackend('cli')],
      chainsFiles: [SESSION_CHAINS_FILE, legacySessionChainsFileForBackend('api'), legacySessionChainsFileForBackend('cli')],
      labelsFiles: [SESSION_LABELS_FILE, legacySessionLabelsFileForBackend('api'), legacySessionLabelsFileForBackend('cli')],
    }, enterprisePolicy?.conversationRetentionDays)

    // Dock click / Cmd-Tab. The Dock icon only exists while the ATV window is
    // open (atvDockPresence flips the activation policy) — so an activate
    // while the ATV is open means the user is reaching for the ATV, not the
    // overlay. With no ATV open, keep the historical overlay behavior.
    app.on('activate', () => {
      if (isAtvWindowOpen()) focusAtvWindow('app activate')
      else showWindow('app activate')
    })
  }).catch((err) => error('app_lifecycle: whenReady startup failed', { error: String(err) }))

  app.on('will-quit', () => {
    stopWatchdog()
    globalShortcut.unregisterAll()
    sessionPlane.shutdown()
    for (const [, entry] of fileWatchers) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.watcher.close()
    }
    fileWatchers.clear()
    if (state.tray) {
      state.tray.destroy()
      state.tray = null
    }
    stopTabSnapshotPolling()
    if (state.remoteTransport) {
      state.remoteTransport.stop().catch((err) => warn('app_lifecycle: remote transport stop failed on will-quit', { error: String(err) }))
      state.remoteTransport = null
    }
    try { rmSync(join(app.getPath('userData'), 'ion.pid')) } catch { /* silent-ok: best-effort pid-file cleanup on quit */ }
    flushLogs()
    // Stop tailers first so no new records arrive after we drain, then drain egress.
    stopEgressTailers()
    closeEgress().catch(() => {}) // silent-ok: terminal shutdown drain; flushLogs already ran and closeEgress logs its own flush errors
  })

  process.on('SIGUSR1', () => {
    log('SIGUSR1 received, draining active work before quit')
    const timeout = setTimeout(() => {
      void (async () => {
        log('Drain timeout (5min), force quitting')
        await flushRendererTabs()
        state.forceQuit = true
        terminalManager.destroyAll()
        // Bootout the daemon so launchd does not restart it after we exit.
        await engineBridge.shutdownAndWait().catch((e) => { log('app_lifecycle: engine daemon bootout failed on quit', { error: e instanceof Error ? e.message : String(e) }) })
        sessionPlane.shutdown()
        globalShortcut.unregisterAll()
        if (state.tray) { state.tray.destroy(); state.tray = null }
        try { rmSync(join(app.getPath('userData'), 'ion.pid')) } catch { /* silent-ok: best-effort pid-file cleanup on quit */ }
        flushLogs()
        app.exit(0)
      })()
    }, 5 * 60 * 1000)

    sessionPlane.drain(() => bashProcesses.size > 0).then(async () => {
      clearTimeout(timeout)
      log('All agents finished, quitting')
      await flushRendererTabs()
      state.forceQuit = true
      terminalManager.destroyAll()
      // Bootout the daemon so launchd does not restart it after we exit.
      await engineBridge.shutdownAndWait().catch((e) => { log('app_lifecycle: engine daemon bootout failed on quit', { error: e instanceof Error ? e.message : String(e) }) })
      sessionPlane.shutdown()
      globalShortcut.unregisterAll()
      if (state.tray) { state.tray.destroy(); state.tray = null }
      try { rmSync(join(app.getPath('userData'), 'ion.pid')) } catch { /* silent-ok: best-effort pid-file cleanup on quit */ }
      flushLogs()
      app.exit(0)
    }).catch((err) => error('app_lifecycle: drain-quit sequence failed', { error: String(err) }))
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
