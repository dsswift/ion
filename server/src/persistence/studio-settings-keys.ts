/**
 * The Studio settings allowlist and its per-key validator — shared by both
 * transports.
 *
 * These keys are per-person UI state, not environment configuration:
 * `studioLayout` carries the left sidebar's visibility and the default
 * surface width, and `studioSurface` carries each conversation's own surface
 * panel record (which tabs, which is active, whether it is visible, and how
 * wide). Losing them is what makes a reloaded client feel like a different
 * machine.
 *
 * The list and the validator were inline in `main/ipc/studio-settings.ts`,
 * which meant only a client with a preload bridge could read or write them —
 * a browser Studio client got the refusal proxy, so its sidebar and surface
 * panel reset on every reload. They live here so the IPC adapter and
 * `protocol/studio-settings-actions.ts` enforce the SAME allowlist and the
 * SAME shape checks; a key accepted on one transport can never be rejected
 * on the other.
 */
import { normalizeStudioLayout } from '@ion/shared/types-studio'
import { validateSurfacePersisted } from '@ion/shared/studio-surface-persistence'
import { parseComposerStash } from '@ion/shared/composer-stash'
import { SETTINGS_DEFAULTS } from './settings-store'

/** The only settings keys the Studio surface may read or write. */
export const STUDIO_SETTING_KEYS = new Set([
  'studioTheme',
  'studioZoom',
  'studioSeed',
  'studioHeat',
  'studioBeacon',
  'studioSound',
  'studioLayout',
  'studioSurface',
  'studioComposerStash',
])

/** Project the allowlisted keys out of a settings map, filling in defaults. */
export function projectStudioSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of STUDIO_SETTING_KEYS) {
    out[key] = raw[key] ?? (SETTINGS_DEFAULTS as Record<string, unknown>)[key]
  }
  // Derived, read-only: Studio is unconditionally the active UI. The renderer
  // still reads it as a launcher-visibility flag.
  out.studioEnabled = true
  return out
}

/** Per-key shape validation. Returns false for an unknown key or a bad shape. */
export function validateStudioSetting(key: unknown, value: unknown): key is string {
  if (typeof key !== 'string' || !STUDIO_SETTING_KEYS.has(key)) return false
  if (key === 'studioSeed') return typeof value === 'string' && value.length <= 256
  if (key === 'studioHeat' || key === 'studioBeacon' || key === 'studioSound') {
    return typeof value === 'boolean'
  }
  // 0 = fit-to-window mode; 1..6 = manual zoom.
  if (key === 'studioZoom') {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6
  }
  if (key === 'studioLayout') {
    // Reject anything that does not round-trip through the shared normalizer
    // unchanged: shape, view union, and numeric bounds all live in ONE place
    // (shared/types-studio.ts) so the renderer's restore path and this
    // validator can never disagree.
    if (value == null || typeof value !== 'object') return false
    const normalized = normalizeStudioLayout(value)
    const keys = Object.keys(normalized) as (keyof typeof normalized)[]
    const candidate = value as Record<string, unknown>
    if (Object.keys(candidate).length !== keys.length) return false
    return keys.every((k) => candidate[k] === normalized[k])
  }
  // Same one-implementation rule as studioLayout: the shared parser is the
  // validator (the renderer re-validates with the identical function).
  if (key === 'studioSurface') return validateSurfacePersisted(value)
  // One parser is both this validator and the renderer's restore path.
  if (key === 'studioComposerStash') return parseComposerStash(value) !== null
  if (key === 'studioTheme') return typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value)
  return true
}
