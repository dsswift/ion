declare const __ION_DESKTOP_VERSION__: string

import { app, BrowserWindow, dialog, Menu, powerMonitor, screen } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { log as _log, error as _error, initLoggerMachineIdentity, LOG_FILE } from './logger'
import { installMainCrashLogging } from './crash-logging'
import { applyConfiguredLogLevel } from './log-level'
import { loadMachineIdentity } from '@ion/server/machine-identity'
import { state, SPACES_DEBUG } from './state'
import { installContentSecurityPolicy, snapshotWindowState } from './window-manager'
import { focusStudioWindow, isStudioWindowOpen, openStudioWindow } from './studio-window-manager'
import { focusWorktreeOverlapWindow } from './worktree-overlap-window'
import { handleWindowAllClosed } from './window-all-closed'
import { requestPermissions } from './permissions-preflight'
import { claimSingleInstance, setupDeepLinks, consumeLaunchUrl, bindDeepLinkRenderer } from './deeplink-setup'
import { FORCE_QUIT_ARG } from './force-quit-arg'
import { detectRunningIon } from './instance-guard'
import { focusState } from '@ion/server/git/focus-state'
import {
  ensureHybridBackendConfig,
} from '@ion/server/persistence/settings-store'
import { ensureEngineDaemon } from '@ion/server/engine/engine-bootstrap'
import { migrateLegacySafeStorageSecrets } from '@ion/server/utils/secretStore'
import { supervisorFor } from '@ion/server/engine/engine-supervisor'
import { pruneOperationDirs } from '@ion/server/utils/temp-dir'
import { claimEngineEgressForDesktop } from './engine-egress-claim'
import { localServer } from './local-server-instance'
import { ensureEntraAuthConfig } from '@ion/server/oauth/entra-config'
import { initAutoUpdater } from './updater'
import { disableAutoUpdateFrom, firstLocalWelcome } from './local-welcome'
import { startWatchdog, setWatchdogSuspended } from '@ion/server/watchdog'
import { startDeviceMetrics } from './device-metrics'
import { broker } from './connections/broker-instance'
import { wireAttentionReporting } from './connections/attention-reporter'
import { LOCAL_ENVIRONMENT_ID, localEnvironmentLabel } from '@ion/shared/types-environments'
import { connectEnvironment, renewRemoteEnvironmentsAfterWake } from './connections/environment-connect'
import { registerEnvironmentLabel } from './ipc/studio-bridge'
import { createStartupWindow } from './startup-window'
import { installQuitHandlers } from './app-lifecycle-quit'
import { initEgressFromEngineConfig, initEgressFromSettingsConfig } from './app-lifecycle-egress'
import { failStartup, isStartupRevealed, prepareStudioStartup, reportStartup, requireStartupAuthentication } from './startup-coordinator'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _error('main', msg, fields)
}

export function setupAppLifecycle(): void {
  // The cooperative single-instance lock first: a running Ion that holds it
  // receives this launch (its window comes forward, or a forced quit runs)
  // and this process leaves without startup work.
  if (!claimSingleInstance()) {
    app.quit()
    return
  }

  // Holding the lock, only an Ion from a release older than the lock can
  // still be running. It cannot receive this launch, so say so. Checked
  // before this process touches the engine, settings, or any window.
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

  // Holding the lock means no Ion was running to take the forced quit.
  if (process.argv.includes(FORCE_QUIT_ARG)) {
    log('launched to force a quit, but no Ion is running; exiting')
    app.exit(0)
    return
  }

  // Secrets the desktop once encrypted with the macOS Keychain are unreadable
  // to the Studio server, which owns them now (a plain Node child). This is
  // the one process that can still decrypt them, and the one moment nothing
  // else is writing the files: rewrite them under the shared keyfile tier
  // before the server starts.
  try {
    const migration = migrateLegacySafeStorageSecrets()
    if (migration.rewritten > 0 || migration.unreadable > 0) {
      log('legacy secret migration complete', { rewritten: migration.rewritten, unreadable: migration.unreadable, files: migration.files.length, safe_storage_ready: migration.safeStorageReady })
    }
  } catch (err) {
    error('legacy secret migration failed; the server will report any values it cannot read', { error: String(err) })
  }

  // The Studio server: a child process the desktop supervises with a respawn
  // ladder (spec 12). Started only once both guards have passed — a refused
  // launch used to spawn it from index.ts first and then exit around it,
  // leaving an orphaned server. IPC is already registered by now, so
  // studio-bridge.ts's broker is wired to receive its connection.
  localServer.start()

  // This process talks to that server over the Studio wire from here on
  // (the identity gate, deep links, quit), before any window exists to ask
  // for the connection. The broker retries until the socket answers; the
  // renderer's own later request for the local environment finds this
  // connection already open and keeps it.
  const localLabel = localEnvironmentLabel(process.platform)
  registerEnvironmentLabel(LOCAL_ENVIRONMENT_ID, localLabel)
  // Startup policy (the auto-update kill switch, the identity provider)
  // arrives on this connection's live welcome, so listen before connecting.
  const localWelcome = firstLocalWelcome(broker)
  void localWelcome.then(async (welcome) => {
    // Auto-updater (D-012): enterprise-managed installs pin their version
    // through MDM, so it never checks before the policy is known.
    if (!welcome) {
      log('app_lifecycle: auto-update not started; the local environment never delivered its policy')
      return
    }
    const disableAutoUpdate = disableAutoUpdateFrom(welcome)
    if (disableAutoUpdate) log('app_lifecycle: auto-update disabled by enterprise policy')
    await app.whenReady()
    initAutoUpdater({ disableAutoUpdate })
  })
  void connectEnvironment(LOCAL_ENVIRONMENT_ID, localLabel, { kind: 'local' }).catch((err) => {
    log('app_lifecycle: local environment connect failed', { error: String(err) })
  })

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

  app.whenReady().then(async () => {
    createStartupWindow()
    reportStartup({ source: 'main', sequence: 0, status: 'Preparing Ion…' })

    // Before any other start-up step: a throw from one of them must land in
    // desktop.jsonl rather than only in Electron's dialog.
    installMainCrashLogging()
    // Start the main-thread stall watchdog first, so it is already observing if
    // any later startup step wedges the main thread. It runs on its own worker
    // thread and writes stall diagnostics that survive a main-thread freeze —
    // the one condition under which the main-process logger itself goes blind.
    startWatchdog({ logFile: LOG_FILE, component: 'desktop' })
    // This device's own Studio processes and GPU time (Device Metrics), with
    // the idle-repaint warning. Local only: nothing here reaches a server.
    startDeviceMetrics()
    // This client's own view of wire latency, alongside the server's.
    broker.latency.start()
    // The server owns the relay sockets and its own stall watchdog; this
    // process is the one that hears powerMonitor, so it relays each edge as a
    // lifecycle action to the local Environment.
    powerMonitor.on('suspend', () => {
      setWatchdogSuspended(true)
      log('watchdog: paused for system suspend')
      broker.sendAction(LOCAL_ENVIRONMENT_ID, 'lifecycle.systemSuspend', []).catch((err) =>
        error('lifecycle: systemSuspend not delivered to the local server', { error: String(err) }),
      )
    })
    powerMonitor.on('resume', () => {
      setWatchdogSuspended(false)
      log('watchdog: resumed after system wake')
      broker.sendAction(LOCAL_ENVIRONMENT_ID, 'lifecycle.systemWake', []).catch((err) =>
        error('lifecycle: systemWake not delivered to the local server', { error: String(err) }),
      )
      renewRemoteEnvironmentsAfterWake()
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

    // Log whether engine.json's auth block configures an OIDC identity, so an
    // unconfigured install is diagnosable from the log alone. Reads only;
    // the identity is the deployment's to write.
    const identityConfigured = ensureEntraAuthConfig()

    // Opt into credential-based per-provider routing: the desktop writes
    // backend:"hybrid" into engine.json (the engine default stays api for
    // headless consumers). Stamped pre-daemon like the claims above so a
    // fresh daemon start honors it; a change forces the daemon start below,
    // so one already running with the old value is recycled without a full
    // app relaunch. One-time transition per machine.
    const backendConfigChanged = ensureHybridBackendConfig()

    // Ensure the engine daemon is installed, current, and running before
    // creating the window. The bootstrap is idempotent: registers/refreshes
    // the platform supervisor (a launchd LaunchAgent on darwin, a Scheduled
    // Task on win32), copies the binary if content-mismatched, runs
    // install-assets, and starts the daemon. Logs a WARN and returns on a
    // platform with no supervisor mechanism.
    await ensureEngineDaemon({}, { configChanged: backendConfigChanged })
    reportStartup({
      source: 'main',
      sequence: 2,
      status: supervisorFor() ? 'Starting Ion engine…' : 'Connecting to Ion engine…',
    })

    // Configure egress forwarder from engine.json before connecting — that
    // way the first engine events are captured even if egress is configured.
    initEgressFromEngineConfig()

    // Configure desktop-owned egress from settings.json. Independent of
    // engine egress: the desktop ships its own sources (desktop, engine,
    // iOS, telemetry) to the endpoint configured here; the engine ships
    // nothing unless separately configured in engine.json.
    initEgressFromSettingsConfig()

    // This process never connects to the engine: the Studio server child
    // (started before whenReady) is the engine's one client, and this process reaches
    // it over the Studio wire.

    installContentSecurityPolicy()

    reportStartup({ source: 'main', sequence: 3, status: 'Checking identity…' })

    // Required operator identity gates session restoration. The Studio window
    // is not created until the engine reports a usable grant, so start_session
    // cannot load extensions before authentication completes.
    // Unconfigured identity is the normal optional-auth state. Query the engine
    // only when a provider exists; required config is validated by the engine
    // before daemon startup and can never arrive here unconfigured. Without a
    // local provider, the enterprise one is on the live welcome.
    const identityAvailable = identityConfigured || !!(await localWelcome)?.enterprisePolicy?.auth?.identityProvider
    if (identityAvailable) {
      // The engine's identity snapshot, read through the local server: this
      // process never connects to the engine itself.
      const getOperatorIdentityState = () => broker.sendAction(LOCAL_ENVIRONMENT_ID, 'entra.operatorIdentityState', []) as Promise<{ required: boolean; signedIn: boolean }>
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

    // Create the (hidden) Studio window now; startup splash owns first
    // visible paint until the renderer reports ready (maybeReveal in
    // startup-coordinator.ts).
    prepareStudioStartup()
    snapshotWindowState('after prepareStudioStartup')

    // Deep links can only run once the RENDERER STORE exists — every action
    // drives store actions (createTabInDirectory, addTerminalInstance), and the
    // confirmation dialog lives in the renderer too. `did-finish-load` is the
    // first point at which that is true. Anything that arrived earlier (a cold
    // launch, which is the common case for a link that starts the app) was
    // queued by the dispatcher and flushes here.
    if (state.studioWindow) {
      state.studioWindow.webContents.once('did-finish-load', () => {
        broker.sendAction(LOCAL_ENVIRONMENT_ID, 'deeplink.ready', []).then(
          () => consumeLaunchUrl(),
          (err) => log('app_lifecycle: deeplink.ready failed; cold-launch url not consumed', { error: String(err) }),
        )
      })
      bindDeepLinkRenderer('studio', state.studioWindow)
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

    // Attention gates each Environment's background git work; every client
    // reports its own window focus and a server keeps working while any of
    // them is attentive. The local focusState still feeds this process's own
    // git subscriptions until those move too.
    const reportToEnvironments = wireAttentionReporting(broker, () => BrowserWindow.getAllWindows().some((w) => w.isFocused()))
    const reportAttention = (focused: boolean): void => {
      focusState.setFocused(focused)
      reportToEnvironments(focused)
    }
    app.on('browser-window-focus', () => reportAttention(true))
    app.on('browser-window-blur', () => {
      reportAttention(BrowserWindow.getAllWindows().some((w) => w.isFocused()))
    })

    if (SPACES_DEBUG) {
      state.studioWindow?.on('show', () => snapshotWindowState('event window show'))
      state.studioWindow?.on('hide', () => snapshotWindowState('event window hide'))
      state.studioWindow?.on('focus', () => snapshotWindowState('event window focus'))
      state.studioWindow?.on('blur', () => snapshotWindowState('event window blur'))
      state.studioWindow?.webContents.on('focus', () => snapshotWindowState('event webContents focus'))
      state.studioWindow?.webContents.on('blur', () => snapshotWindowState('event webContents blur'))

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



    // Dock click / Cmd-Tab. Studio is the only window, so an activate either
    // focuses it (if open) or reopens it (if the user closed it and the app
    // stayed tray-resident).
    app.on('activate', () => {
      if (!isStartupRevealed()) return
      if (isStudioWindowOpen()) focusStudioWindow('app activate')
      else if (state.worktreeOverlapWindow && !state.worktreeOverlapWindow.isDestroyed()) focusWorktreeOverlapWindow('app activate')
      else openStudioWindow('app activate')
    })
  }).catch((err) => {
    error('app_lifecycle: whenReady startup failed', { error: String(err) })
    failStartup(String(err))
  })

  installQuitHandlers()

  app.on('window-all-closed', handleWindowAllClosed)
}
