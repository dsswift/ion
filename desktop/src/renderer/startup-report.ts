import type { StartupSource } from '../shared/startup-state'

const sequences: Record<StartupSource, number> = { main: 0, owner: 0, studio: 0 }

export function reportStartup(source: StartupSource, status: string, ready = false, error?: string): void {
  window.ion.startupReport({
    source,
    sequence: ++sequences[source],
    status,
    ready,
    ...(error ? { error } : {}),
  })
}
