/**
 * The one `Broker` instance for this process (spec 12). Kept separate from
 * `ipc/studio-bridge.ts` (which wires it to IPC) so `connections/
 * environment-connect.ts` (main-side connect/disconnect/restart driver, spec
 * 13) can reference the same instance without an import cycle between the
 * IPC layer and the connection layer.
 */
import { Broker } from './broker'

export const broker = new Broker()
