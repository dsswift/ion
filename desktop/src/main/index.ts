import './state'
import { migrateStudioSettings } from './settings-migration-studio'
import { wireSessionPlaneEvents, wireEngineBridgeEvents, wireRemoteSessionPlaneForwarding, wireTabFocusHandler, wireMarkResourceReadHandler, wireDeleteResourceHandler, wireResourceGetHandler } from './event-wiring'
import { registerAllIpc } from './ipc/register'
import { setupAppLifecycle } from './app-lifecycle'

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
registerAllIpc()
// The auto-updater is initialized inside setupAppLifecycle after the engine
// bridge connects: enterprise policy (disableAutoUpdate, D-012) comes from
// the engine's get_enterprise_policy RPC, which needs a live connection.
setupAppLifecycle()
