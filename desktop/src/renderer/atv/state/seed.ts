/**
 * Office seed: ONE seed for the whole desktop.
 *
 * The office is the user's office — the same layout across every
 * conversation. Switching tabs re-populates the same office with that
 * conversation's agents (idle conversations show everyone milling about;
 * active ones show them working). Only a seed change (user-chosen, applied
 * desktop-wide) or a different roster structure changes the layout.
 */

/** The default office seed when the user has not chosen one. */
export const DEFAULT_OFFICE_SEED = 'ion-office'

/** The effective seed: the stored override, else the constant default. */
export function resolveSeed(storedSeed: string | undefined | null): string {
  const trimmed = (storedSeed ?? '').trim()
  return trimmed.length > 0 ? trimmed : DEFAULT_OFFICE_SEED
}

/** Persist the desktop-wide seed (empty string restores the default). */
export async function persistSeed(seed: string): Promise<string> {
  await window.ion.atvSetSetting('atvSeed', seed.trim())
  return resolveSeed(seed)
}
