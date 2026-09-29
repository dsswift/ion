/**
 * server-request-principal-browser-stub — the Studio renderer's build-time
 * replacement for `server/src/identity/request-principal.ts`.
 *
 * The real file uses `node:async_hooks`' `AsyncLocalStorage`, unavailable in
 * a renderer/browser bundle. It is reachable transitively from
 * `session-store-helpers.ts`'s `makeLocalTab()`, which every tab-creation
 * store slice calls. The LOCAL environment the Studio renderer boots against
 * has no Studio-wire connection and no ambient principal to read — it IS the
 * store owner, the same case `hello.ts`'s `LocalOnlyAuthPolicy` grants every
 * scope to — so `currentPrincipal()` returning `undefined` here is the
 * correct browser-side answer, not a degraded one: every caller already
 * falls back to `localPrincipal()` when this returns `undefined`.
 */
export function runAsPrincipal<T>(_principal: unknown, fn: () => T): T {
  return fn();
}

export function currentPrincipal(): undefined {
  return undefined;
}

/**
 * A renderer is never inside a server request, so it has no calling client's
 * Personal preferences to report. `makeLocalTab` reads this when it stamps a
 * new tab; in the renderer that tab is a mirror row whose stamp the server
 * owns.
 */
export function currentPreferences(): undefined {
  return undefined;
}

export function currentClaims(): undefined {
  return undefined;
}
