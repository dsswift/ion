import './state'
import { wireSessionPlaneEvents, wireEngineBridgeEvents, wireRemoteSessionPlaneForwarding, wireTabFocusHandler, wireMarkResourceReadHandler, wireDeleteResourceHandler, wireResourceGetHandler } from './event-wiring'
import { registerAllIpc } from './ipc/register'
import { setupAppLifecycle } from './app-lifecycle'

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
