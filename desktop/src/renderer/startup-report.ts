import type { StartupSource } from '@ion/shared/startup-state'
import { host } from './host/host-instance'

/** A window reports only as `studio`; `server` reports come off the wire, never from a renderer. */
type RendererStartupSource = Exclude<StartupSource, 'server'>

const sequences: Record<RendererStartupSource, number> = { main: 0, studio: 0 }

export function reportStartup(source: RendererStartupSource, status: string, ready = false, error?: string): void {
  // Electron's splash window progress reporting -- no splash and no wire
  // equivalent exists for a browser tab (see StudioHost.ts's doc).
  if (!host.capabilities().includes('startupReport')) return
  host.shell.startupReport({
    source,
    sequence: ++sequences[source],
    status,
    ready,
    ...(error ? { error } : {}),
  })
}
