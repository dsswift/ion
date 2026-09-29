/**
 * tabs-index — reads persisted `tabs.json` for per-principal tab visibility,
 * with NO dependency on the session store.
 *
 * Split out of `snapshot.ts` deliberately: `events.ts`'s per-event
 * visibility check (the hot path during token streaming) needs only
 * `principalSubjectForTab`, and `snapshot.ts` also imports the full
 * `sessionStore.ts` (for `buildWorktreeSnapshot`'s `useSessionStore.getState()`
 * call, used only by the `studio_hello` handshake). Importing
 * `principalSubjectForTab` from `snapshot.ts` would therefore drag the ENTIRE
 * session store — and everything it initializes at module load, including
 * `setupStudioWorktreeSync`'s `host-api` call — into every consumer of
 * `events.ts`, which is every consumer of `broadcast.ts` (`event-wiring.ts`,
 * `questions-wiring.ts`, and dozens more). That regression was caught
 * concretely: dozens of existing store-slice tests mock `host-api` for the
 * functions THEY call and have no reason to know about
 * `studioPublishWorktreeSync`, so the store's module-load side effect broke
 * them the moment `broadcast.ts` gained a transitive edge to `sessionStore.ts`.
 * This module is the fix — the tabs.json reader that `events.ts` needs stays
 * free of the store, and `snapshot.ts` (imported only by `hello.ts`, which is
 * never on `broadcast.ts`'s import path) keeps the heavier snapshot-building
 * imports.
 *
 * The tabs path is computed here as `join(dataDir(), 'tabs.json')` rather
 * than importing `settings-store.ts`'s `TABS_FILE` for a narrower reason
 * than a path-resolution bug: `TABS_FILE` now also derives from `dataDir()`,
 * but as a `const` resolved once at module load, so a test that wants two
 * different `ION_DATA_DIR` values in one process still can't get isolation
 * from it (the existing convention there is `vi.mock`, not the env var).
 * This module computes its OWN path lazily, per call, so a Studio-wire test
 * (or a future multi-instance server sharing one process) gets correct
 * isolation without needing to mock anything.
 */
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { dataDir } from '../paths'
import { warn as _warn, error as _error } from '../logger'
import { unownedTabsVisible, isSharedTenancy } from '../config/current'
import type { StudioPrincipalSummary, StudioSnapshotTab } from '@ion/shared/studio-wire/types'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-tabs-index', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('studio-tabs-index', msg, fields)
}

/** `dataDir()/tabs.json`, resolved fresh on every call (never cached at module scope). */
function tabsFilePath(): string {
  return join(dataDir(), 'tabs.json')
}

function stripTabFields(raw: unknown): StudioSnapshotTab {
  const { terminalBuffers: _terminalBuffers, conversationPane: _conversationPane, ...rest } = raw as Record<string, unknown>
  return rest as StudioSnapshotTab
}

/** Read `tabs.json` and strip `terminalBuffers`/`conversationPane`. Tolerates a missing or corrupt file. */
export function loadSnapshotTabs(): StudioSnapshotTab[] {
  const tabsFile = tabsFilePath()
  if (!existsSync(tabsFile)) return []
  try {
    const parsed = JSON.parse(readFileSync(tabsFile, 'utf-8')) as { tabs?: unknown[] } | unknown[]
    const rawTabs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.tabs) ? parsed.tabs : []
    return rawTabs.map(stripTabFields)
  } catch (err) {
    error('persisted tabs read failed for snapshot', { error: String(err) })
    return []
  }
}

/**
 * Read `tabs.json`'s `settledHistory` array (closed/recoverable conversation
 * records — see `PersistedTabState.settledHistory`), same stripping and same
 * missing/corrupt tolerance as {@link loadSnapshotTabs}. Kept separate rather
 * than folded into `loadSnapshotTabs` because every existing caller of that
 * function wants live tabs only; `principalSubjectForConversation` below is
 * the one caller that needs both arrays (a deleted/settled conversation is
 * exactly what `session.deleteStored` targets).
 */
function loadSnapshotSettledHistory(): StudioSnapshotTab[] {
  const tabsFile = tabsFilePath()
  if (!existsSync(tabsFile)) return []
  try {
    const parsed = JSON.parse(readFileSync(tabsFile, 'utf-8')) as { settledHistory?: unknown[] }
    const raw = Array.isArray(parsed.settledHistory) ? parsed.settledHistory : []
    return raw.map(stripTabFields)
  } catch (err) {
    error('persisted settled history read failed', { error: String(err) })
    return []
  }
}

/**
 * A tab is visible to `principal` when its recorded owner matches. A tab
 * with no `principalSubject` at all (pre-backfill legacy record —
 * `persistence/principal-backfill.ts` stamps these on next boot) falls back
 * to the operator's `server.json.tenancy.unownedTabs` policy
 * (`config/current.ts`'s `unownedTabsVisible`) — the default is `'visible'`
 * on a non-multi-tenant desktop (nothing to isolate a legacy record FROM)
 * and `'hidden'` once `oidc` is configured, so there the same record is
 * visible to no one until the backfill (or a parse-failure recovery) stamps
 * it. Without this gate, one malformed `tabs.json` (every lookup
 * unresolvable) would silently drop the whole instance to no isolation.
 */
export function tabVisibleTo(tab: StudioSnapshotTab, principal: StudioPrincipalSummary): boolean {
  if (isSharedTenancy()) return true
  if (!tab.principalSubject) return unownedTabsVisible()
  return tab.principalSubject === principal.subject
}

let principalIndexMtimeMs = -1
let principalIndex = new Map<string, string>()
let conversationIndex = new Map<string, string>()

/**
 * A brand-new tab's owner (P0: stamped in `makeLocalTab()`) before the
 * debounced `tabs.json` write (`session-store-persistence.ts`) has landed.
 * Consulted first by {@link principalSubjectForTab} so the tab's very first
 * events resolve to its real owner instead of racing the debounce and
 * reading as unowned. Pruned lazily in {@link rebuildPrincipalIndexesIfStale}
 * once the file-backed index catches up with the same subject, so this map
 * only ever holds entries for tabs created since the last file rebuild.
 */
const liveTabOwners = new Map<string, string>()

/** Registers `tabId`'s owner immediately, ahead of the next persisted `tabs.json` write. Call once, at tab creation. */
export function registerTabOwner(tabId: string, subject: string): void {
  liveTabOwners.set(tabId, subject)
}

function rebuildPrincipalIndexesIfStale(): void {
  const tabsFile = tabsFilePath()
  const mtimeMs = existsSync(tabsFile) ? statSync(tabsFile).mtimeMs : -1
  if (mtimeMs === principalIndexMtimeMs) return
  principalIndexMtimeMs = mtimeMs

  const owned = (t: StudioSnapshotTab): t is StudioSnapshotTab & { id: string; principalSubject: string } => !!t.id && !!t.principalSubject
  const live = loadSnapshotTabs()
  const settled = loadSnapshotSettledHistory()

  principalIndex = new Map(live.filter(owned).map((t) => [t.id, t.principalSubject]))

  for (const [tabId, subject] of liveTabOwners) {
    if (principalIndex.get(tabId) === subject) liveTabOwners.delete(tabId)
  }

  const conversations = new Map<string, string>()
  for (const t of [...live, ...settled]) {
    if (!t.principalSubject) continue
    if (t.conversationId) conversations.set(t.conversationId, t.principalSubject)
    for (const historicalId of t.historicalSessionIds ?? []) conversations.set(historicalId, t.principalSubject)
  }
  conversationIndex = conversations
}

/**
 * `tabId -> principalSubject`, rebuilt only when `tabs.json`'s mtime
 * changes. The live `TabState` carries no `principalSubject` field (it is
 * persisted-only — see the module doc), and re-parsing the file on every
 * `studio_event` (the hot path during token streaming) would not scale, so
 * `events.ts`'s per-event visibility check goes through this cache rather
 * than `loadSnapshotTabs()` directly.
 */
export function principalSubjectForTab(tabId: string): string | undefined {
  const live = liveTabOwners.get(tabId)
  if (live) return live
  try {
    rebuildPrincipalIndexesIfStale()
  } catch (err) {
    warn('principal-subject index rebuild failed', { error: String(err) })
  }
  return principalIndex.get(tabId)
}

/**
 * Whether the person `subject` may hear about the conversation `tabId`. One
 * rule for everything a conversation sends: its live events
 * (`events.ts`'s `visibleTo`) and the pushes it rings
 * (`relay-listener.ts`). A shared-tenancy server shows every conversation to
 * everyone; otherwise only its owner hears it, and a conversation with no
 * recorded owner follows `unownedTabsVisible`.
 */
export function tabIdVisibleToSubject(tabId: string, subject: string | null): boolean {
  if (isSharedTenancy()) return true
  const owner = principalSubjectForTab(tabId)
  if (!owner) return unownedTabsVisible()
  return subject !== null && owner === subject
}

/**
 * `conversationId -> principalSubject`, covering both a tab's CURRENT
 * `conversationId` and every id in its `historicalSessionIds` chain (a
 * rewind/fork keeps the same principal across the chain), for both live tabs
 * AND `settledHistory` — a closed conversation is exactly what
 * `session.deleteStored`/`session.loadChainHistory`/`session.getConversation`
 * name. Shares `principalSubjectForTab`'s mtime-cached rebuild (one
 * `tabs.json` parse builds both indexes) rather than tracking its own cache.
 * A conversation id that predates every live/settled tab's own record (a very
 * old fork `session-chains.json` still knows about) is unresolved, same
 * fail-open/fail-closed rule as everything else this module can't resolve.
 */
export function principalSubjectForConversation(conversationId: string): string | undefined {
  try {
    rebuildPrincipalIndexesIfStale()
  } catch (err) {
    warn('conversation-principal index rebuild failed', { error: String(err) })
  }
  return conversationIndex.get(conversationId)
}

/** TEST ONLY. Force the next `principalSubjectForTab`/`principalSubjectForConversation` call to rebuild the cache. */
export function _resetPrincipalIndexForTest(): void {
  principalIndexMtimeMs = -1
  principalIndex = new Map()
  conversationIndex = new Map()
  liveTabOwners.clear()
}
