/** How the Fleet page writes times, loads, limits, and a server's own install steps. */
import { HOST_INSTALL_STALE_MS, hostInstallEnded, type HostInstallProgress } from '@ion/shared/host-install'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5m", "3h", "2d": how long a span is, in its largest whole unit. */
export function formatSpan(ms: number): string {
  if (ms < MINUTE) return 'under a minute'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`
  return `${Math.floor(ms / DAY)}d`
}

export function formatAgo(thenMs: number, now: number): string {
  const span = now - thenMs
  return span < MINUTE ? 'just now' : `${formatSpan(span)} ago`
}

/** "in 3h", or "now" once the time has passed. */
export function formatUntil(iso: string | undefined, now: number): string | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  return at <= now ? 'now' : `in ${formatSpan(at - now)}`
}

/** The local date and time of a reset, for a tooltip. */
export function formatWhen(iso: string | undefined): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatPercent(fraction: number | null | undefined): string {
  return fraction === null || fraction === undefined ? '—' : `${Math.round(fraction * 100)}%`
}

/** How long an install that ended is still worth a word on its server's row. */
const INSTALL_OUTCOME_SHOWN_MS = 10 * MINUTE

/**
 * A server's newest install step in a few words, as the server itself
 * reported it; null once it is old news. A step that never got an ending
 * (the server did not come back) stops being shown after
 * `HOST_INSTALL_STALE_MS`.
 */
export function describeHostInstall(progress: HostInstallProgress | undefined, now: number): { tone: 'ok' | 'warn' | 'error' | 'accent'; text: string } | null {
  if (!progress) return null
  const age = now - progress.at
  if (age > (hostInstallEnded(progress.stage) ? INSTALL_OUTCOME_SHOWN_MS : HOST_INSTALL_STALE_MS)) return null
  const restart = progress.kind === 'restart'
  switch (progress.stage) {
    case 'requested': return { tone: 'accent', text: restart ? 'restart requested' : 'install requested' }
    case 'downloading': return { tone: 'accent', text: 'downloading' }
    case 'installing': return { tone: 'accent', text: 'installing' }
    case 'restarting': return { tone: 'warn', text: 'restarting' }
    case 'completed': return { tone: 'ok', text: progress.version ? `back, running ${progress.version}` : 'back' }
    case 'refused': return { tone: 'error', text: restart ? 'restart refused' : 'install refused' }
    case 'failed': return { tone: 'error', text: restart ? 'restart failed' : 'install failed' }
  }
}
