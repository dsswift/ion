/**
 * The one `LocalServerSupervisor` for this process (spec 12). Kept separate
 * from `local-server.ts` (pure supervisor class, independently testable) so
 * both `index.ts` (boot: `start()`) and `window-manager.ts` (tray "Restart"
 * item) can reference the same instance without an import cycle.
 */
declare const __ION_DESKTOP_VERSION__: string
import { LocalServerSupervisor } from './local-server'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('local-server-instance', msg, fields)
}

export const localServer = new LocalServerSupervisor({ hostAppVersion: __ION_DESKTOP_VERSION__ })

localServer.on('offline', (reason: string) => {
  log('local server reported offline; operator can Restart from the tray menu', { reason })
})
