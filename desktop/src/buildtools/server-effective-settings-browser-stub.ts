/**
 * server-effective-settings-browser-stub — the Studio renderer's build-time
 * replacement for `server/src/persistence/effective-settings.ts`.
 *
 * The real file resolves a personal preference against the calling identity:
 * `readSettingsForSubject()` reads the Environment document plus that
 * subject's overlay with real `fs`, and `localPrincipal()` calls `os.userInfo`.
 * Neither can run in a browser bundle, and the renderer reaches this module
 * unconditionally through `persistence/preferences.ts`, which the session
 * store imports for its reactive selectors (spec 17).
 *
 * Every export returns the shipped default rather than a read. That is
 * correct rather than merely safe: an Account setting is only ever consumed
 * to decide something the SERVER owns, because every action that reads one is
 * a FORWARDED action. A renderer that reached one of these would be about to
 * make a decision on the wrong side of the wire.
 */

export function effectiveSubject(explicit?: string | null): string {
  return explicit || "studio-renderer-stub";
}

export function readEffectiveSettings(
  _subject?: string | null,
): Record<string, unknown> {
  return {};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function writeEffectiveSettings(
  _patch: Record<string, unknown>,
  _subject?: string | null,
): void {
  throw new Error(
    "writeEffectiveSettings() cannot run in the Studio renderer — preference persistence is server-owned; route through a FORWARDED store action instead.",
  );
}
