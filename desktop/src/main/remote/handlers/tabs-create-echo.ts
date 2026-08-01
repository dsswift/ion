/**
 * tabs-create-echo — remote-initiated tab creation and its
 * `desktop_tab_created` echo.
 *
 * Owns the whole create path for `desktop_create_tab` /
 * `desktop_create_terminal_tab`: the store invocation, the confirm-or-resend
 * idempotency map, and the echo back to the client. Split out of tabs.ts, which
 * sat at exactly 600/600 lines against the hard cap; creation is the natural
 * seam because the echo is meaningless without the create that produced it.
 *
 * ─── Why the echo is not a timer ────────────────────────────────────────────
 *
 * The echo used to be `setTimeout(… , 500)` followed by a `getRemoteTabStates()`
 * read and an `if (newTab)` with no `else`. Three things were wrong with that,
 * and together they cost ~4 seconds of visible latency on every iOS tab create:
 *
 *  1. The 500ms was a guess at losing a race. The renderer publishes its
 *     projection on a 250ms trailing debounce (remote-projection-push.ts), so
 *     whether the new tab had landed in the cache by the deadline depended on
 *     where in that debounce window the create happened to fall.
 *  2. `getRemoteTabStates()` serves any cache younger than
 *     RENDERER_CACHE_MAX_AGE_MS (10s) without checking whether it contains the
 *     tab being asked about. A 4-second-old cache is "fresh" and confidently
 *     returns the pre-create tab list, so losing the race did not even trigger
 *     the legacy poll fallback.
 *  3. On a miss the function returned silently. No send, no log. The tab
 *     existed on the desktop and the phone had no idea, so the only recovery
 *     was the client's 4s confirm-or-resend timeout — which is exactly what the
 *     logs showed (`handle_create_tab: duplicate clientCmdId` four seconds
 *     after a create that completed in 32ms).
 *
 * The replacement is deterministic: force a projection refresh (bypassing the
 * age gate — see `refreshRendererSnapshotCache`), then emit. The tab was minted
 * by an awaited store call before we get here, so one refresh is normally
 * enough. A miss is a genuine defect rather than an expected race, so it is
 * logged at ERROR and retried on a bounded backoff instead of vanishing.
 */

import { homedir } from 'os'
import { state } from '../../state'
import { log as _log, error as _error } from '../../logger'
import { readSettings } from '../../settings-store'
import { terminalManager } from '../../terminal-manager-instance'
import { refreshRendererSnapshotCache, getRemoteTabStates } from '../snapshot'
import type { RemoteCommand } from '../protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('tabs-create-echo', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _error('tabs-create-echo', msg, fields)
}

/**
 * Total attempts to resolve the freshly created tab before giving up. The first
 * runs immediately; each subsequent one waits RETRY_BACKOFF_MS[attempt-1].
 */
const MAX_ATTEMPTS = 3

/**
 * Backoff before retries 2 and 3. Deliberately shorter than the client's 4s
 * confirm-or-resend timeout so the whole ladder completes before the phone
 * gives up and resends — a resend is dedup'd (`handleDuplicateCreate`) and
 * therefore harmless, but it is a round-trip we should never need.
 *
 * Overridable so the failure-path tests assert the ladder's behaviour without
 * actually sleeping through it. Production never passes this.
 */
const RETRY_BACKOFF_MS = [150, 400]

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resolve the newly created tab from a force-refreshed renderer projection and
 * emit `desktop_tab_created` to every paired device.
 *
 * `createdAt` is the epoch-ms timestamp of the create itself, so the success
 * log reports true end-to-end create→echo latency (the number this whole module
 * exists to keep small) rather than just the time spent in here.
 *
 * Returns true if the echo was sent. Awaiting it is optional — the caller is a
 * command handler with nothing left to do — but tests await it to assert the
 * echo lands without advancing any timer.
 */
export async function notifyTabCreated(
  tabId: string,
  clientCmdId?: string,
  createdAt: number = Date.now(),
  backoffMs: readonly number[] = RETRY_BACKOFF_MS,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Refresh first so the cache provably reflects the just-created tab, then
      // read through getRemoteTabStates for the MAPPED wire shape. The refresh
      // returns the raw renderer projection (ProjectedRendererTab); the echo
      // must carry a RemoteTabState, which is what the snapshot mapper
      // produces. Refreshing makes the subsequent read a guaranteed cache hit,
      // so this is one renderer round-trip, not two.
      await refreshRendererSnapshotCache()
      const { tabs } = await getRemoteTabStates()
      const newTab = tabs.find((t) => t.id === tabId)
      if (newTab) {
        state.remoteTransport?.send({ type: 'desktop_tab_created', tab: newTab, clientCmdId })
        log('tab_created echo sent', {
          tab_id: tabId,
          client_cmd_id: clientCmdId,
          attempt,
          elapsed_ms: Date.now() - createdAt,
        })
        return true
      }
      // The tab was created by an awaited store call, so a refreshed projection
      // that lacks it means the renderer has not committed the new tab into the
      // slice the projection reads. Retry — but say so, every time.
      error('tab_created echo: tab absent from refreshed projection', {
        tab_id: tabId,
        client_cmd_id: clientCmdId,
        attempt,
        max_attempts: MAX_ATTEMPTS,
        tab_count: tabs.length,
        elapsed_ms: Date.now() - createdAt,
      })
    } catch (err) {
      // If this echo never sends, iOS's confirm-or-resend loop resends the
      // create command with no desktop-side explanation. Log every failure.
      error('tab_created echo: projection refresh failed', {
        tab_id: tabId,
        client_cmd_id: clientCmdId,
        attempt,
        max_attempts: MAX_ATTEMPTS,
        error: String(err),
      })
    }
    const backoff = backoffMs[attempt - 1]
    if (attempt < MAX_ATTEMPTS && backoff !== undefined) await sleep(backoff)
  }
  error('tab_created echo: gave up, client will resend', {
    tab_id: tabId,
    client_cmd_id: clientCmdId,
    attempts: MAX_ATTEMPTS,
    elapsed_ms: Date.now() - createdAt,
  })
  return false
}
async function createTabFromCommand(
  cmd: { workingDirectory?: string },
  storeMethod: string,
  defaultArgs: string[] = [],
): Promise<string | null> {
  let dir = cmd.workingDirectory
  if (!dir) {
    const s = readSettings()
    dir = s.defaultBaseDirectory || homedir() || ''
  }
  if (!dir) return null
  try {
    const escaped = dir.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const args = ["'" + escaped + "'", ...defaultArgs].join(', ')
    // The store creators (createTabInDirectory / createTerminalTab) are async.
    // await INSIDE the IIFE so the activeTabId restore runs after the tab id is
    // minted rather than racing the unresolved promise; executeJavaScript
    // resolves the returned promise to the string id.
    const tabId = await state.mainWindow?.webContents.executeJavaScript(`
      (async function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var prev = store.getState().activeTabId;
        var id = await store.getState().${storeMethod}(${args});
        store.setState({ activeTabId: prev });
        return id;
      })()
    `)
    return tabId || null
  } catch (err) {
    log('store_method error', { error: (err as Error).message })
    return null
  }
}

// Idempotency for the iOS confirm-or-resend loop. iOS attaches a `clientCmdId`
// to each create command and resends it if no `desktop_tab_created` echo comes
// back (its transport can silently wedge after a background/resume cycle, so a
// locally-successful send is not proof of delivery). Without dedup a resend of
// a create that actually landed would spawn a duplicate tab. We remember the
// clientCmdId→tabId mapping and, on a repeat, re-emit the existing tab instead
// of creating another. Bounded FIFO so the map can't grow unbounded across a
// long-lived desktop session.
const recentCreatesByClientCmdId = new Map<string, string>()
const RECENT_CREATES_CAP = 256

function rememberCreate(clientCmdId: string, tabId: string): void {
  recentCreatesByClientCmdId.set(clientCmdId, tabId)
  while (recentCreatesByClientCmdId.size > RECENT_CREATES_CAP) {
    const oldest = recentCreatesByClientCmdId.keys().next().value
    if (oldest === undefined) break
    recentCreatesByClientCmdId.delete(oldest)
  }
}

// Returns true if this is a duplicate delivery of a create we already served.
// On a duplicate we re-emit the created tab (the client's confirmation was
// lost, not its request) and the caller returns without creating a new tab.
function handleDuplicateCreate(clientCmdId: string | undefined): boolean {
  if (!clientCmdId) return false
  const existing = recentCreatesByClientCmdId.get(clientCmdId)
  if (!existing) return false
  log('handle_create_tab: duplicate clientCmdId, re-emitting existing tab', { client_cmd_id: clientCmdId, tab_id: existing })
  // Fire-and-forget: this is the dedup path for a client that already timed out
  // waiting, and the caller returns a synchronous boolean. notifyTabCreated
  // never rejects (it logs and returns false), so there is no rejection to
  // handle here.
  void notifyTabCreated(existing, clientCmdId)
  return true
}

export async function handleCreateTab(cmd: Extract<RemoteCommand, { type: 'desktop_create_tab' }>): Promise<void> {
  // Idempotency: a resend of a create we already served re-emits the existing
  // tab rather than making a duplicate. See handleDuplicateCreate.
  if (handleDuplicateCreate(cmd.clientCmdId)) return

  // When profileId is present the iOS client wants an extension-hosted
  // conversation. Route through createConversationTab with profileId in opts.
  // When absent, create a plain CLI tab.
  if (cmd.profileId) {
    let dir = cmd.workingDirectory
    if (!dir) {
      const s = readSettings()
      dir = s.defaultBaseDirectory || homedir() || ''
    }
    if (!dir) return
    try {
      const escaped = dir.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const profileArg = `'${cmd.profileId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
      log('handle_create_tab: extension tab', { profile_id: cmd.profileId })
      // createConversationTab is async; await it INSIDE the IIFE so the
      // activeTabId restore runs AFTER the real tab id is minted, not before
      // the promise resolves. executeJavaScript resolves the returned promise.
      const tabId = await state.mainWindow?.webContents.executeJavaScript(`
        (async function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var prev = store.getState().activeTabId;
          var id = await store.getState().createConversationTab('${escaped}', { profileId: ${profileArg} });
          store.setState({ activeTabId: prev });
          return id;
        })()
      `)
      if (tabId) {
        if (cmd.clientCmdId) rememberCreate(cmd.clientCmdId, tabId)
        await notifyTabCreated(tabId, cmd.clientCmdId)
      }
    } catch (err) {
      log('handle_create_tab: engine error', { error: (err as Error).message })
    }
    return
  }

  // Plain CLI tab (legacy path).
  // When the iOS client requests pinning into a specific group (e.g. the
  // per-group "+" button next to a group header), forward the group id as
  // the 4th positional argument to createTabInDirectory. The renderer-side
  // store action treats this as an explicit pin and sets groupPinned=true
  // from the start so the first sendMessage's auto-movement skips this tab.
  // We single-quote the group id (matching how `dir` is escaped above) so
  // the value flows safely through executeJavaScript.
  const defaultArgs: string[] = ['false', 'true']
  if (cmd.pinToGroupId) {
    const escaped = cmd.pinToGroupId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    defaultArgs.push("'" + escaped + "'")
    log('handle_create_tab: pinToGroupId, forwarding as explicit-pin', { pin_to_group: cmd.pinToGroupId })
  } else {
    log('handleCreateTab: no pinToGroupId (default-group placement)')
  }
  const tabId = await createTabFromCommand(cmd, 'createTabInDirectory', defaultArgs)
  if (tabId) {
    if (cmd.clientCmdId) rememberCreate(cmd.clientCmdId, tabId)
    await notifyTabCreated(tabId, cmd.clientCmdId)
  }
}

export async function handleCreateTerminalTab(cmd: Extract<RemoteCommand, { type: 'desktop_create_terminal_tab' }>): Promise<void> {
  // Idempotency: a resend re-emits the existing terminal tab, not a duplicate.
  if (handleDuplicateCreate(cmd.clientCmdId)) return
  const tabId = await createTabFromCommand(cmd, 'createTerminalTab')
  if (tabId) {
    // Eagerly create a terminal instance + PTY so remote clients can use it
    // without waiting for the desktop renderer to navigate to this tab.
    try {
      const escaped = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const instance = await state.mainWindow?.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var id = store.getState().addTerminalInstance('${escaped}', 'user');
          var pane = store.getState().terminalPanes.get('${escaped}');
          if (!pane) return null;
          var inst = pane.instances.find(function(i) { return i.id === id; });
          if (!inst) return null;
          return { id: inst.id, label: inst.label, kind: inst.kind, cwd: inst.cwd || '' };
        })()
      `)
      if (instance) {
        const key = `${tabId}:${instance.id}`
        terminalManager.create(key, instance.cwd || cmd.workingDirectory || '~')
        state.remoteTransport?.send({
          type: 'desktop_terminal_instance_added',
          tabId,
          instance: { id: instance.id, label: instance.label || 'Shell', kind: instance.kind || 'user', readOnly: false, cwd: instance.cwd || '' },
        })
      }
    } catch (err) {
      log('create_terminal_tab: instance creation error', { error: (err as Error).message })
    }
    if (cmd.clientCmdId) rememberCreate(cmd.clientCmdId, tabId)
    await notifyTabCreated(tabId, cmd.clientCmdId)
  }
}
