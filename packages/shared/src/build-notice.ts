/**
 * The Build Notice: what Studio shows the first time it opens on a desktop
 * build the person has not acknowledged yet, so a silent reinstall is never
 * in doubt.
 *
 * A build is identified by its version AND the moment it was built. The
 * version alone is not enough: two local builds of one commit carry the same
 * version, and a person rebuilding the same commit still wants to know the
 * reinstall finished.
 *
 * A released build may also carry "What's new" highlights: plain-language
 * notes the release pipeline writes into `desktop/whats-new.json`, keyed by
 * version. A build with no entry (every local build) has none.
 */

/** One desktop build's identity. */
export interface DesktopBuild {
  version: string
  /** ISO-8601 time the bundle was built. */
  builtAt: string
}

export interface BuildNotice {
  current: DesktopBuild
  /** The build last acknowledged on this device; null on the first launch that records one. */
  previous: DesktopBuild | null
  /** What's new in `current`, one plain sentence each; empty when the build has no notes. */
  highlights: string[]
}

/**
 * `version`'s entry in a `desktop/whats-new.json` document, or null when the
 * document is not an object of string arrays. An absent entry is `[]`.
 */
export function whatsNewFor(notes: unknown, version: string): string[] | null {
  if (typeof notes !== 'object' || notes === null || Array.isArray(notes)) return null
  for (const entry of Object.values(notes)) {
    if (!Array.isArray(entry) || !entry.every((item) => typeof item === 'string')) return null
  }
  const entry = (notes as Record<string, string[]>)[version]
  return entry ? [...entry] : []
}

export function sameBuild(a: DesktopBuild, b: DesktopBuild): boolean {
  return a.version === b.version && a.builtAt === b.builtAt
}

/** The stored acknowledgement, or null when absent or not the expected shape. */
export function parseDesktopBuild(value: unknown): DesktopBuild | null {
  if (typeof value !== 'object' || value === null) return null
  const { version, builtAt } = value as Record<string, unknown>
  if (typeof version !== 'string' || typeof builtAt !== 'string') return null
  return { version, builtAt }
}

/** The notice to show for `current`, or null when `acknowledged` is this very build. */
export function buildNoticeFor(current: DesktopBuild, acknowledged: DesktopBuild | null, highlights: readonly string[]): BuildNotice | null {
  if (acknowledged && sameBuild(current, acknowledged)) return null
  return { current, previous: acknowledged, highlights: [...highlights] }
}
