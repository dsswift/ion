declare const __ION_DESKTOP_VERSION__: string

import { app, BrowserWindow, dialog, Menu, powerMonitor, screen } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { log as _log, error as _error, initLoggerMachineIdentity } from './logger'
import { applyConfiguredLogLevel } from './log-level'
import { hydrateChartCatalogFromDisk } from './chart-restore'
import { loadMachineIdentity } from './machine-identity'
import { state, SPACES_DEBUG, engineBridge, enterprisePolicyCache } from './state'
import { createWindow, installContentSecurityPolicy, snapshotWindowState, showWindow } from './window-manager'
import { focusStudioWindow, isStudioWindowOpen } from './studio-window-manager'
import { focusWorktreeOverlapWindow } from './worktree-overlap-window'
import { resolveSurfacePlan } from './surface-launch'
import { handleWindowAllClosed } from './window-all-closed'
import { restoreStudioTerminals } from './studio-terminal-persistence'
import { requestPermissions } from './permissions-preflight'
import { claimSingleInstance, setupDeepLinks, consumeLaunchUrl, bindDeepLinkRenderer } from './deeplink-setup'
import { detectRunningIon } from './instance-guard'
import { markDeepLinksReady } from './deeplink/dispatch'
import { cleanOrphanedWorktrees } from './git-runner'
import { focusState } from './git/focus-state'
import { startConversationCleanup } from './conversation-cleanup'
import { startWorktreeFreshnessPoll } from './worktree/freshness-poll'
import {
  TABS_FILE,
  SESSION_CHAINS_FILE,
  SESSION_LABELS_FILE,
  legacyTabsFileForBackend,
  legacySessionChainsFileForBackend,
  legacySessionLabelsFileForBackend,
  ensureHybridBackendConfig,
  readSettings,
} from './settings-store'
import { ensureEngineDaemon, restartEngineDaemon } from './engine-bootstrap'
import { supervisorFor } from './engine-supervisor'
import { pruneOperationDirs } from './utils/temp-dir'
import { claimEngineEgressForDesktop } from './engine-egress-claim'
import { getOperatorIdentityState, ensureEntraAuthConfig } from './oauth/entra-auth'
import { getEnterprisePolicy, getEnterprisePolicyNewConversationDefaults } from './engine-bridge-fs'
import { initAutoUpdater } from './updater'
import { startWatchdog, setWatchdogSuspended } from './watchdog'
import { renewRelaysAfterWake } from './remote/transport-wake'
import { createStartupWindow } from './startup-window'
import { installQuitHandlers } from './app-lifecycle-quit'
import { initEgressFromEngineConfig, initEgressFromSettingsConfig } from './app-lifecycle-egress'
import { failStartup, isStartupRevealed, reportStartup, requireStartupAuthentication, startStartup } from './startup-coordinator'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _error('main', msg, fields)
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
  // Older releases predate Electron's cooperative single-instance lock. Check
  // the durable pid and live process table first, before this process touches
  // the engine, settings, or any window.
  const runningIon = detectRunningIon()
  if (runningIon) {
    error('app_lifecycle: launch refused; another Ion is running', {
      existing_pid: runningIon.pid,
      current_pid: process.pid,
      source: runningIon.source,
    })
    // The refusal is decided here, before any startup work, but Electron
    // refuses every dialog call until the ready event fires — showing it now
    // throws an uncaught exception and the user gets a crash box instead of
    // the explanation. Defer only the telling; no startup work runs either way.
    app.whenReady().then(() => {
      dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Ion is already running',
        message: 'Quit the running Ion application before opening this copy.',
        detail: 'Ion does not start a second desktop because it could interrupt active conversations or replace a live engine.',
      })
      app.exit(0)
    }).catch((err) => {
      error('app_lifecycle: could not show already-running notice; exiting anyway', {
        error: err instanceof Error ? err.message : String(err),
      })
      app.exit(0)
    })
    return
  }

  // Claim the cooperative lock after the legacy-process guard. A lock loss
  // means a current Ion owns it and has already received this launch request.
  if (!claimSingleInstance()) {
    app.quit()
    return
  }

  // No second desktop can still be using Ion-owned operation directories once
  // Electron grants this process singleton ownership. Remove every abandoned
  // directory now rather than guessing freshness from wall-clock time.
  pruneOperationDirs()

  // Register the ion:// scheme and its arrival paths before whenReady resolves,
  // so a cold-launch URL is not dropped while the app is still booting.
  setupDeepLinks()

  // Resolve stable machine identity early (before the first log line is written
  // to egress). Non-fatal — errors are swallowed and identity fields are simply
  // absent. loadMachineIdentity resolves quickly on all platforms; the host name
  // is always available and ioreg/plutil are fast on modern macOS.
  loadMachineIdentity().then(initLoggerMachineIdentity).catch(() => { /* non-fatal */ })

  // Apply the operator's log level before the app does any real work, so a
  // DEBUG-level decision made during startup is actually recorded. The
  // packaged build has no DevTools, which makes desktop.jsonl the only
  // diagnostic channel — a filtered-out line reads as "the code never ran".
  applyConfiguredLogLevel()

  // Log build identity as the very first line the operator or an agent will
  // see when diagnosing from desktop.jsonl. `__ION_DESKTOP_VERSION__` is a
  // build-time define (electron.vite.config.ts): dev builds bake in the short
  // git SHA and a dirty-tree flag, release builds carry the release-please
  // version. Without this line, a bug that reproduces identically after a
  // rebuild is indistinguishable from a rebuild that silently installed the
  // wrong branch/commit — the exact ambiguity that stalled the Graph View
  // sigma-mount investigation until a manual `git log` comparison caught it.
  log('desktop starting', {
    appVersion: __ION_DESKTOP_VERSION__,
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  })

  // Seed the resource catalog with persisted charts BEFORE any renderer can
  // read it. Charts are files on disk keyed by conversation id, so this needs
  // no session and no engine — and doing it here is what makes the attachments
  // panel correct on first paint instead of minutes later, when the session
  // finally subscribes.
  hydrateChartCatalogFromDisk()

  app.whenReady().then(async () => {
    createStartupWindow()
    reportStartup({ source: 'main', sequence: 0, status: 'Preparing Ion…' })
    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide()
    }

    // Start the main-thread stall watchdog first, so it is already observing if
    // any later startup step wedges the main thread. It runs on its own worker
    // thread and writes stall diagnostics that survive a main-thread freeze —
    // the one condition under which the main-process logger itself goes blind.
    startWatchdog()
    powerMonitor.on('suspend', () => {
      setWatchdogSuspended(true)
      log('watchdog: paused for system suspend')
    })
    powerMonitor.on('resume', () => {
      setWatchdogSuspended(false)
      log('watchdog: resumed after system wake')
      renewRelaysAfterWake({ transport: state.remoteTransport, log })
    })

    await requestPermissions()
    reportStartup({ source: 'main', sequence: 1, status: 'Checking system permissions…' })

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
    const identityConfigured = ensureEntraAuthConfig()

    // Opt into credential-based per-provider routing: the desktop writes
    // backend:"hybrid" into engine.json (the engine default stays api for
    // headless consumers). Stamped pre-daemon like the claims above so a
    // fresh daemon start honors it; if the daemon was already running with
    // the old value, recycle it below so routing flips without a full
    // app relaunch. One-time transition per machine.
    const backendConfigChanged = ensureHybridBackendConfig()

    // Ensure the engine daemon is installed, current, and running before
    // creating the window. The bootstrap is idempotent: registers/refreshes
    // the platform supervisor (a launchd LaunchAgent on darwin, a Scheduled
    // Task on win32), copies the binary if content-mismatched, runs
    // install-assets, and starts the daemon. Logs a WARN and returns on a
    // platform with no supervisor mechanism.
    await ensureEngineDaemon()
    reportStartup({
      source: 'main',
      sequence: 2,
      status: supervisorFor() ? 'Starting Ion engine…' : 'Connecting to Ion engine…',
    })
    if (backendConfigChanged) {
      await restartEngineDaemon()
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
    // list_models refresh; the theme lock (theme-policy.ts) and the
    // settings-snapshot broadcaster read it synchronously.
    enterprisePolicyCache.policy = enterprisePolicy
    try {
      enterprisePolicyCache.newConversationDefaults = await getEnterprisePolicyNewConversationDefaults()
    } catch (err: any) {
      log('app_lifecycle: new-conversation policy fetch failed, proceeding unconstrained', { error: err.message })
    }

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

    // Restore surface-terminal scrollback (studio: namespace) before any
    // window can attach to one.
    restoreStudioTerminals()

    // Launch-surface resolution: which surface(s) the user sees first. The
    // overlay window is ALWAYS created (its renderer owns session state);
    // only its visibility is governed here.
    const surfacePlan = resolveSurfacePlan(readSettings(), enterprisePolicyCache.policy)
    log('surface plan resolved', { ...surfacePlan })
    if (surfacePlan.lockedBy === 'platform') {
      log('surface plan clamped to studio by platform', { platform: process.platform })
    }
    startStartup(surfacePlan)
    reportStartup({ source: 'main', sequence: 3, status: 'Checking identity…' })

    // Required operator identity gates session restoration. The owner renderer
    // is not created until the engine reports a usable grant, so start_session
    // cannot load extensions before authentication completes.
    // Unconfigured identity is the normal optional-auth state. Query the engine
    // only when a provider exists; required config is validated by the engine
    // before daemon startup and can never arrive here unconfigured.
    const identityAvailable = identityConfigured || !!enterprisePolicy?.auth?.identityProvider
    if (identityAvailable) {
      const identityState = await getOperatorIdentityState().catch((err) => {
        throw new Error(`Could not verify required operator identity: ${err instanceof Error ? err.message : String(err)}`)
      })
      if (identityState.required && !identityState.signedIn) {
        requireStartupAuthentication()
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          const next = await getOperatorIdentityState()
          if (next.signedIn) break
        }
      }
    }
    reportStartup({ source: 'main', sequence: 4, status: 'Preparing your workspace…' })

    // The owner renderer must always restore session state, but startup splash
    // owns first visible paint for both product surfaces.
    createWindow(false)
    snapshotWindowState('after createWindow')

    // Deep links can only run once the RENDERER STORE exists — every action
    // drives store actions (createTabInDirectory, addTerminalInstance), and the
    // confirmation dialog lives in the renderer too. `did-finish-load` is the
    // first point at which that is true. Anything that arrived earlier (a cold
    // launch, which is the common case for a link that starts the app) was
    // queued by the dispatcher and flushes here.
    if (state.mainWindow) {
      state.mainWindow.webContents.once('did-finish-load', () => {
        markDeepLinksReady()
        consumeLaunchUrl()
      })
      bindDeepLinkRenderer('overlay', state.mainWindow)
    }

    const pidDir = app.getPath('userData')
    const pidPath = join(pidDir, 'ion.pid')
    writeFileSync(pidPath, String(process.pid))
    log('app_lifecycle: pid file written', { path: pidPath, pid: process.pid })

    // Rebuilt (not mutated) whenever a checkbox state changes — Electron
    // menus are immutable snapshots. The Window menu carries the STUDIO pin
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
        // Standard window controls (minimize/zoom/front). Matters while the STUDIO
        // holds Dock presence: without a Window menu the regular-policy menu bar
        // looks broken and window-management shortcuts don't route.
        {
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'zoom' },
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

    // Register shortcuts only after splash hands off to the selected UI.
    // Early registration would let a hidden product window steal startup input.
    if (surfacePlan.openStudioOnLaunch) {
      // Studio window is created after owner reports a complete snapshot.
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

    // Keep worktree + bench state current for every consumer. Main owns this
    // timer rather than a renderer: the overlay, the Studio mirror, and iOS all
    // need the same answer, and a renderer-owned timer stops existing when its
    // window closes — which is how the previous panel-local 5s poll was lost
    // when its component was deleted. Attention-gated inside the tick, so an
    // unattended desktop does no git work.
    startWorktreeFreshnessPoll()

    // Dock click / Cmd-Tab. The Dock icon only exists while the STUDIO window is
    // open (studioDockPresence flips the activation policy) — so an activate
    // while the STUDIO is open means the user is reaching for the STUDIO, not the
    // overlay. With no STUDIO open, keep the historical overlay behavior.
    app.on('activate', () => {
      if (!isStartupRevealed()) return
      if (isStudioWindowOpen()) focusStudioWindow('app activate')
      else if (state.worktreeOverlapWindow && !state.worktreeOverlapWindow.isDestroyed()) focusWorktreeOverlapWindow('app activate')
      else showWindow('app activate')
    })
  }).catch((err) => {
    error('app_lifecycle: whenReady startup failed', { error: String(err) })
    failStartup(String(err))
  })

  installQuitHandlers(flushRendererTabs)

  app.on('window-all-closed', handleWindowAllClosed)
}
