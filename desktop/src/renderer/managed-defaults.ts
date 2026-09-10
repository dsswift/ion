/**
 * One-shot record of which enterprise managed defaults this profile has
 * already had applied.
 *
 * An unlocked enterprise policy is a DEFAULT, not an enforcement: it seeds a
 * value on a profile that has never had it, and after that the user owns the
 * setting. That requires distinguishing "never applied" from "applied, and
 * the user has since changed it" -- and the setting's own value cannot answer
 * it, because a user who chose the policy's value looks identical to one who
 * never chose at all.
 *
 * The presence of the key in settings.json cannot answer it either. The
 * desktop persists the entire settings object on every save, so every key
 * exists as soon as any unrelated preference is written; on a real profile
 * that is all 87 of them, from the first launch.
 *
 * localStorage is the right home: it is per-profile, survives restarts,
 * is not part of the settings object the desktop rewrites wholesale, and is
 * where the theme policy already keeps the equivalent marker.
 */
import { rWarn } from './rendererLogger'

const STORAGE_KEY = 'ion_managedDefaultsApplied'

/** Managed defaults that apply once per profile. */
export type ManagedDefaultId = 'tabStrip'

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set()
  } catch (err) {
    // A corrupt marker must not block startup. Treating it as empty re-applies
    // the managed default once, which is the safe direction: the operator's
    // intended value is restored and the user can change it again.
    rWarn('preferences', 'managed-defaults marker unreadable; treating as unapplied', {
      error: err instanceof Error ? err.message : String(err),
    })
    return new Set()
  }
}

export function hasAppliedManagedDefault(id: ManagedDefaultId): boolean {
  return read().has(id)
}

export function markManagedDefaultApplied(id: ManagedDefaultId): void {
  const applied = read()
  applied.add(id)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...applied]))
  } catch (err) {
    // Failing to record it means the default re-applies on the next launch,
    // overriding a user change. Worth an error: it is silent to the user and
    // reads as the setting refusing to stick.
    rWarn('preferences', 'could not record managed default; it may re-apply next launch', {
      id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Test seam. */
export function _resetManagedDefaultsForTest(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // silent-ok: test-only reset on a storage that is already unavailable
  }
}
