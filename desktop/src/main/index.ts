import './state'
import { wireSessionPlaneEvents, wireEngineBridgeEvents, wireRemoteSessionPlaneForwarding, wireTabFocusHandler, wireMarkResourceReadHandler, wireDeleteResourceHandler, wireResourceGetHandler } from './event-wiring'
import { registerAllIpc } from './ipc/register'
import { setupAppLifecycle } from './app-lifecycle'
import { initAutoUpdater } from './updater'

wireSessionPlaneEvents()
wireEngineBridgeEvents()
wireRemoteSessionPlaneForwarding()
wireTabFocusHandler()
wireMarkResourceReadHandler()
wireDeleteResourceHandler()
wireResourceGetHandler()
registerAllIpc()
setupAppLifecycle()
initAutoUpdater()
