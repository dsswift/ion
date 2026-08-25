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
import { wireSessionPlaneEvents, wireEngineBridgeEvents, wireRemoteSessionPlaneForwarding, wireTabFocusHandler, wireMarkResourceReadHandler, wireDeleteResourceHandler, wireResourceGetHandler } from './event-wiring'
import { registerAllIpc } from './ipc/register'
import { setupAppLifecycle } from './app-lifecycle'
import { wireAutomationRuntime } from './automation/runtime'

// Legacy atv* → studio* settings rename. MUST run before window creation and
// IPC registration so every consumer only ever reads the new key names.
migrateStudioSettings()

wireSessionPlaneEvents()
wireEngineBridgeEvents()
wireRemoteSessionPlaneForwarding()
wireTabFocusHandler()
wireMarkResourceReadHandler()
wireDeleteResourceHandler()
wireResourceGetHandler()
wireAutomationRuntime()
registerAllIpc()
// The auto-updater is initialized inside setupAppLifecycle after the engine
// bridge connects: enterprise policy (disableAutoUpdate, D-012) comes from
// the engine's get_enterprise_policy RPC, which needs a live connection.
setupAppLifecycle()
