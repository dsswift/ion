/**
 * server-tabs-index-browser-stub — the Studio renderer's build-time
 * replacement for `server/src/protocol/tabs-index.ts`.
 *
 * The real file reads persisted `tabs.json` (`fs.readFileSync`/`statSync`)
 * to resolve per-principal tab visibility on the server's hot event-
 * broadcast path. It is reachable from the renderer transitively (e.g.
 * through `questions/questions-wiring.ts`'s import chain) via
 * `sessionStore.ts`'s reactive selectors. Per-principal visibility
 * filtering is a server-side broadcast concern — the renderer only ever
 * receives the events it was already sent, so this file's decision never
 * needs to run client-side.
 *
 * Every function returns a safe empty/permissive default rather than
 * throwing. Wired in via `electron.vite.config.ts`'s renderer plugin, keyed
 * on tabs-index.ts's resolved absolute path so every relative import of it
 * resolves here.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadSnapshotTabs(): any[] {
  return [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tabVisibleTo(_tab: any, _principal: any): boolean {
  return true;
}

export function principalSubjectForTab(_tabId: string): string | undefined {
  return undefined;
}

export function principalSubjectForConversation(_conversationId: string): string | undefined {
  return undefined;
}

export function tabIdVisibleToSubject(_tabId: string, _subject: string | null): boolean {
  return true;
}

export function tabOwnedBySubject(_tabId: string, _subject: string | null): boolean {
  return true;
}

export function registerTabOwner(_tabId: string, _subject: string): void {}

export function _resetPrincipalIndexForTest(): void {}
