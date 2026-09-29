// Repair the launch environment BEFORE any other module is imported.
//
// When the package installer launches Ion, this process inherits the Installer
// script environment, including APPLE_PKGKIT_ESCALATING_ROOT. Apple's /bin/zsh
// and /bin/bash treat that variable as an order to run PRIVILEGED, which makes
// them skip every user startup file (~/.zshenv, ~/.zprofile, ~/.zshrc). Any
// shell Ion starts then has no Starship, no Zoxide, and none of the operator's
// PATH entries.
//
// The repair is a side-effect import, not a call, because import declarations
// are hoisted: a call written here would run after every module below had
// already been evaluated. Keep this import first. See launch-env-init.ts.
import './launch-env-init'
import './state'
import { migrateStudioSettings } from './settings-migration-studio'
import { migrateWorkspaceFolders } from './workspace-folder-migration'
import { returnStrandedServerKeys, runSettingsSplit, stripStaleDeviceKeys } from './settings-split'
import { registerAllIpc } from './ipc/register'
import { setupAppLifecycle } from './app-lifecycle'
import { installBrowserToolCommandHandler } from './studio-playwright/command-handler'
import { installStudioSdk } from './studio-sdk-install'

// Settings split (spec 12): partitions device keys into desktop.json before
// anything (including the local server, spawned below) reads settings.json.
// A no-op after the first successful run. stripStaleDeviceKeys covers the
// edge case of an older desktop build re-writing a device key post-split.
runSettingsSplit()
stripStaleDeviceKeys()
// Before the local server reads settings.json: its own settings, stranded on
// this device by an earlier device key list, go back to it.
returnStrandedServerKeys()

// Legacy atv* → studio* settings rename. MUST run before window creation and
// IPC registration so every consumer only ever reads the new key names.
migrateStudioSettings()

// Mounted folders written under a worktree or bench path move onto the Project
// that owns them. Also before window creation, so the first explorer render
// reads the corrected map.
migrateWorkspaceFolders()

// The Studio server answers the engine's tool gate; the Playwright browser
// tool bodies that need Electron stay here and are reached through
// `browser.tool` studio_commands on the local connection.
installBrowserToolCommandHandler()

// The Studio SDK is Studio's to ship, not the engine's: put it beside the
// engine SDK so an extension can import it. Never blocks startup.
installStudioSdk()

// The engine bridge, the session plane, the event wiring and the automation
// runtime all run in the Studio server process (ADR-033); this process is a
// Studio client and never connects to the engine.
registerAllIpc()
// The auto-updater is initialized inside setupAppLifecycle from the cached
// `studio_welcome` enterprise policy (disableAutoUpdate, D-012).
setupAppLifecycle()
