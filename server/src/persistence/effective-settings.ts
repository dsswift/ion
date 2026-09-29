/**
 * effective-settings — the settings document as ONE person sees it on this
 * server.
 *
 * `settings.json` is the Environment's document: one value for the whole
 * server. An Account setting (`@ion/shared/settings-registry`) is a person's
 * own on this server and lives in that subject's overlay
 * (`user-settings-store.ts`), so two people on one server never fight over
 * each other's default model, git mode, or tab groups.
 *
 * A server-side read of an Account setting goes through here, never through
 * `readSettings()` alone: reading the Environment copy is what once started a
 * new conversation on a value its owner had already replaced, while the
 * Settings dialog showed the replacement.
 *
 * WHOSE settings: pass the conversation owner's subject when the read is on
 * behalf of a conversation. Most such reads run with no request in context
 * (an engine event, a timer), where the ambient fallback below resolves to
 * the host account, which is not the owner. With no explicit subject the
 * ambient request principal applies, then the local operator, the only
 * identity the host can honestly name outside a request.
 *
 * An Environment setting must NOT come through here. `readSettingsForSubject`
 * strips those from the overlay before merging, so they resolve to the
 * Environment's value either way — but read them from `settings-store`
 * directly, so the call site says which document it means.
 *
 * Personal and Device settings are not on the server at all. The ones the
 * server consumes reach it as the conversation's stamp
 * (`conversation-preferences.ts`).
 */
import {
  readSettingsForSubject,
  writeSettingsForSubject,
} from "./user-settings-store";
import { currentPrincipal } from "../identity/request-principal";
import { localPrincipal } from "../identity/local-principal";

/**
 * The identity whose preferences apply to the call in flight.
 *
 * `explicit` wins when a caller already knows whose conversation it is acting
 * on; otherwise the ambient principal, then the local operator.
 */
export function effectiveSubject(explicit?: string | null): string {
  if (explicit) return explicit;
  const ambient = currentPrincipal()?.subject;
  if (ambient) return ambient;
  return localPrincipal().subject;
}

/**
 * The Environment document with this caller's personal overlay applied over
 * it. A preference the caller has never set still follows the Environment.
 */
// `Record<string, any>`, matching `readSettings()`: this is a parsed JSON
// document whose every field is unvalidated until a caller narrows it, and
// `persistence/preferences.ts` IS that narrowing layer (each getter checks
// `typeof`/`Array.isArray` before returning). Returning `unknown` here would
// only move the same unchecked cast to each of those getters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readEffectiveSettings(subject?: string | null): Record<string, any> {
  return readSettingsForSubject(effectiveSubject(subject));
}

/**
 * Merge a personal-preference patch into this caller's overlay.
 *
 * The counterpart to `readEffectiveSettings`, and the reason both live here:
 * a getter that prefers the overlay while its setter persists to the
 * Environment document writes a value it can never read back, because the
 * stale overlay entry shadows it on every subsequent read.
 *
 * A narrow patch only. Never hand this a whole settings document: the overlay
 * holds the keys this identity has actually chosen, and freezing every
 * inherited default into it would stop a later Environment change from ever
 * reaching this user.
 */
export function writeEffectiveSettings(
  patch: Record<string, unknown>,
  subject?: string | null,
): void {
  writeSettingsForSubject(effectiveSubject(subject), patch);
}
