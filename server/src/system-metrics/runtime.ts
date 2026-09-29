/**
 * The process-wide System Metrics publisher. `main.ts` installs it once the
 * engine bridge exists; the snapshot builder and the `environment.*` actions
 * read it. Null before install, and in a process that never installs it.
 */
import { connectionRegistry } from '../protocol/connection'
import { SystemMetricsPublisher, type SystemMetricsEngineLink } from './publisher'
import { log } from '../logger'

let publisher: SystemMetricsPublisher | null = null

export function installSystemMetrics(engine: SystemMetricsEngineLink): SystemMetricsPublisher {
  publisher = new SystemMetricsPublisher(engine)
  publisher.install()
  // A connection that leaves ends its watch, whichever path removed it.
  connectionRegistry.onRemove((conn) => publisher?.forget(conn.id))
  log('system-metrics', 'system metrics publisher installed')
  return publisher
}

export function systemMetricsPublisher(): SystemMetricsPublisher | null {
  return publisher
}
