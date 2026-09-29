/**
 * server-host-api-misc-browser-stub — the Studio renderer's build-time
 * replacement for `server/src/store/host-api-misc.ts`.
 *
 * The real file is the server's terminal/tab/session-persistence HostApi
 * domain: it spawns real bash subprocesses (`child_process.spawn` via
 * `cli-env.ts`'s `getCliEnv()`, itself backed by `launch-env.ts`'s
 * `execFileSync`), reads/writes real tab and session-chain files
 * (`fs`/`os`/`atomicWrite`), and drives the tab-migration runners. It is
 * unconditionally reachable from every renderer file that imports the
 * session store for its reactive selectors (spec 17: Studio renders against
 * the server-owned store), via `sessionStore.ts` → `./host-api` →
 * `./host-api-misc`. None of that belongs in a sandboxed Electron renderer:
 * the server is the one process with a real filesystem, shell, and terminal
 * PTYs, and every one of these operations already has a FORWARDED store
 * action or studio-wire round trip that reaches the server instead of
 * running locally.
 *
 * Every function here is an inert no-op/rejection rather than real I/O, so
 * an accidental renderer-side call fails loudly (a caught rejection or a
 * logged no-op) instead of crashing the bundle at build time. Wired in via
 * `electron.vite.config.ts`'s renderer plugin, keyed on
 * host-api-misc.ts's resolved absolute path so every relative import of it
 * resolves here. TypeScript typechecks call sites against the REAL file,
 * never this stub, so the loose typing below is safe.
 */

import { host } from "../renderer/host/host-instance";
import { rWarn } from "../renderer/rendererLogger";
import type { ProviderLoginUpdate } from "@ion/shared/types-engine-event";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reject(name: string): Promise<any> {
  return Promise.reject(
    new Error(`${name}() cannot run in the Studio renderer — terminal/tab/session I/O is server-owned; route through a FORWARDED store action instead.`),
  );
}

export function listEngineDirectory(..._args: unknown[]): Promise<unknown> {
  return reject("listEngineDirectory");
}
export function getEngineHostInfo(..._args: unknown[]): Promise<unknown> {
  return reject("getEngineHostInfo");
}
export function engineIsRemote(..._args: unknown[]): boolean {
  return false;
}

export function sendRemote(_event: unknown): void {}

export function terminalCreate(..._args: unknown[]): Promise<unknown> {
  return reject("terminalCreate");
}
export function terminalRelaunch(..._args: unknown[]): Promise<void> {
  return reject("terminalRelaunch");
}
export function terminalDestroy(..._args: unknown[]): Promise<void> {
  return reject("terminalDestroy");
}
export function terminalWrite(..._args: unknown[]): Promise<void> {
  return reject("terminalWrite");
}
export function terminalAttach(..._args: unknown[]): Promise<unknown> {
  return reject("terminalAttach");
}
export function getTerminalScrollback(..._args: unknown[]): string {
  return "";
}
export function setSavedBuffer(_key: string, _buffer: string): void {}

export function cancelBash(_execId: string): void {}
export function executeBash(..._args: unknown[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return reject("executeBash");
}

export function markResourceRead(_kind: string, _resourceId: string, _producer?: string): void {}

export function isVisible(): Promise<boolean> {
  return Promise.resolve(true);
}
export function openExternal(..._args: unknown[]): Promise<void> {
  return reject("openExternal");
}
export function selectDirectory(): Promise<string | null> {
  return Promise.resolve(null);
}
export function readPlan(..._args: unknown[]): Promise<{ content: string | null; fileName: string | null }> {
  return Promise.resolve({ content: null, fileName: null });
}

export interface PlanImplementedPayload {
  [key: string]: unknown;
}
export function triggerPlanImplemented(..._args: unknown[]): Promise<void> {
  return reject("triggerPlanImplemented");
}

export function attachFileByPath(..._args: unknown[]): Promise<unknown> {
  return Promise.resolve(null);
}

export function loadTabs(): Promise<unknown> {
  return Promise.resolve(null);
}
export function saveTabs(..._args: unknown[]): Promise<void> {
  return reject("saveTabs");
}
export function saveTabContent(..._args: unknown[]): Promise<void> {
  return reject("saveTabContent");
}
export function loadTabContent(..._args: unknown[]): Promise<unknown> {
  return Promise.resolve(null);
}
export function deleteTabContent(..._args: unknown[]): Promise<void> {
  return reject("deleteTabContent");
}
export function deleteStoredConversations(..._args: unknown[]): Promise<void> {
  return reject("deleteStoredConversations");
}
export function generateTitle(..._args: unknown[]): Promise<unknown> {
  return reject("generateTitle");
}
export function saveSessionLabel(..._args: unknown[]): Promise<void> {
  return reject("saveSessionLabel");
}
export function loadSession(..._args: unknown[]): Promise<unknown[]> {
  return Promise.resolve([]);
}
export function loadChainHistory(..._args: unknown[]): Promise<unknown[]> {
  return Promise.resolve([]);
}

export interface SessionChains {
  [key: string]: unknown;
}
export function loadSessionChains(): Promise<SessionChains> {
  return Promise.resolve({});
}
export function saveSessionChains(..._args: unknown[]): Promise<void> {
  return reject("saveSessionChains");
}

export function tabMetaChanged(_payload: unknown): void {}
export function studioPublishTabsSync(_payload: unknown): void {}
export function studioPublishWorktreeSync(_payload: unknown): void {}
export function studioPublishConversationTerminals(_payload: unknown): void {}
export function respondElicitation(..._args: unknown[]): Promise<void> {
  return reject("respondElicitation");
}
export function reportStartup(..._args: unknown[]): void {}
export function showDesktopNotification(_title: string, _body: string): void {}

export function onQuestionsState(_cb: (snapshot: unknown) => void): () => void {
  return () => {};
}
/**
 * The model store subscribes to two server signals here. Both are bridged
 * `on*` verbs with the `all` scope, so the listener hears every connected
 * Environment and receives the environment id as its trailing argument --
 * the store keys its catalogs and login states by it. A no-op here was how
 * Settings -> Providers never saw a sign-in progress in Studio.
 */
export function on(channel: string, cb: (...args: unknown[]) => void): void {
  if (channel === "ion:models-updated") {
    host.shell.onModelsUpdated((_payload: unknown, environmentId?: string) => cb(environmentId));
    return;
  }
  rWarn("server-host-api-stub", "on(): channel has no renderer subscription", { channel });
}
export function onProviderLoginEvent(cb: (...args: unknown[]) => void): () => void {
  return host.shell.onProviderLoginEvent((update: ProviderLoginUpdate, environmentId?: string) => cb(update, environmentId));
}

export function start(): Promise<unknown> {
  return reject("start");
}

