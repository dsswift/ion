/**
 * server-host-api-engine-browser-stub — the Studio renderer's build-time
 * replacement for `server/src/store/host-api-engine.ts`.
 *
 * The real file is the server's engine/tab/prompt-lifecycle HostApi domain.
 * It funnels into `engine/prompt-pipeline.ts`, which transitively reaches
 * `engine-bridge.ts` (real engine socket connections, `execFileSync`-based
 * discovery), `remote/attachment-encoder.ts` (real file reads + native image
 * encoding), and the rest of the engine-control-plane cluster. It is
 * unconditionally reachable from every renderer file that imports the
 * session store for its reactive selectors (spec 17: Studio renders against
 * the server-owned store), via `sessionStore.ts` → `./host-api` →
 * `./host-api-engine`. None of it belongs in a sandboxed renderer: engine
 * lifecycle (start/stop/abort/rewind/fork/prompt/steer) is exactly the kind
 * of mutation every FORWARDED store action already routes to the server
 * instead of running locally.
 *
 * Every function here is an inert no-op/rejection rather than real engine
 * I/O, so an accidental renderer-side call fails loudly instead of crashing
 * the bundle at build time. Wired in via `electron.vite.config.ts`'s
 * renderer plugin, keyed on host-api-engine.ts's resolved absolute path so
 * every relative import of it resolves here. TypeScript typechecks call
 * sites against the REAL file, never this stub, so the loose typing below
 * is safe.
 */

import { action } from "../renderer/host/host-instance";
import { LOCAL_ENVIRONMENT_ID } from "@ion/shared/types-environments";

/**
 * Not every function here is inert. Engine *lifecycle* (start/stop/abort/
 * rewind/fork/prompt/steer) is a FORWARDED store action and so rejects
 * below -- but the model/provider READS are plain server-owned engine
 * configuration with no store action to ride, and a renderer genuinely
 * needs them to paint a model picker or the AI Models settings category.
 *
 * They used to return `{models: [], providers: []}`. That is the silent
 * no-op class: the settings dialog rendered an empty provider list and an
 * empty model picker with nothing logged anywhere, in BOTH the Electron
 * Studio window and a browser tab, because both build the renderer through
 * this same stub. Routing them over the studio-wire to the `model.*` /
 * `provider.*` actions the server already exposes gives one implementation
 * for both clients instead of an empty answer for each.
 */
function overWire<T>(name: string, args: unknown[] = [], environmentId: string = LOCAL_ENVIRONMENT_ID): Promise<T> {
  return action(environmentId, name, args) as Promise<T>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reject(name: string): Promise<any> {
  return Promise.reject(
    new Error(`${name}() cannot run in the Studio renderer — engine lifecycle is server-owned; route through a FORWARDED store action instead.`),
  );
}

export function engineStart(..._args: unknown[]): void {}
export function echoUserTurnToStudio(..._args: unknown[]): void {}
export function engineAbort(..._args: unknown[]): Promise<void> {
  return reject("engineAbort");
}
export function engineAbortDispatch(..._args: unknown[]): Promise<void> {
  return reject("engineAbortDispatch");
}
export function engineStopBackgroundTask(..._args: unknown[]): void {}
export function engineDialogResponse(..._args: unknown[]): Promise<void> {
  return reject("engineDialogResponse");
}
export function engineStop(..._args: unknown[]): Promise<void> {
  return reject("engineStop");
}
export function engineRewind(..._args: unknown[]): void {}
export function engineFork(..._args: unknown[]): void {}
export function engineSetPlanMode(..._args: unknown[]): void {}
export function setPermissionMode(..._args: unknown[]): void {}
export function resolvePermissionDenials(..._args: unknown[]): void {}
export function engineBroadcastHistory(..._args: unknown[]): Promise<void> {
  return reject("engineBroadcastHistory");
}
/**
 * Lists the named Environment's models (default local). The store keeps one
 * catalog per Environment (ADR-033 union store): a remote tab's picker and
 * Settings -> Providers with a remote Environment selected read that
 * server's answer, not the laptop's.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function listModels(environmentId: string = LOCAL_ENVIRONMENT_ID): Promise<{ models: any[]; providers: any[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return overWire<{ models: any[]; providers: any[] }>("model.list", [], environmentId);
}
export function resolveModelTier(...args: unknown[]): Promise<unknown> {
  return overWire("model.resolveTier", args);
}
export function providerLoginCancel(provider: string, environmentId: string = LOCAL_ENVIRONMENT_ID): Promise<unknown> {
  return overWire("provider.loginCancel", [{ provider }], environmentId);
}
export function createTab(): { tabId: string } {
  throw new Error("createTab() cannot run in the Studio renderer — engine lifecycle is server-owned; route through a FORWARDED store action instead.");
}
export function adoptTab(..._args: unknown[]): { tabId: string } {
  throw new Error("adoptTab() cannot run in the Studio renderer — engine lifecycle is server-owned; route through a FORWARDED store action instead.");
}
export function closeTab(..._args: unknown[]): Promise<void> {
  return reject("closeTab");
}
export function stopTab(..._args: unknown[]): Promise<boolean> {
  return reject("stopTab");
}
export function resetTabSession(..._args: unknown[]): void {}
export function relocateTabSession(..._args: unknown[]): Promise<unknown> {
  return reject("relocateTabSession");
}
export function ensureEngineSession(..._args: unknown[]): void {}
export function prompt(..._args: unknown[]): Promise<void> {
  return reject("prompt");
}
export function steer(..._args: unknown[]): void {}
export function respondPermission(..._args: unknown[]): Promise<void> {
  return reject("respondPermission");
}
