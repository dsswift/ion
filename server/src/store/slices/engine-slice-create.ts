import type { TabState } from '@ion/shared/types'
import { usePreferencesStore } from '../../persistence/preferences'
import type { StoreSet, StoreGet } from '../session-store-types'
import { makeLocalTab, nextMsgId, initialModelOverride, initialPermissionMode, initialThinkingEffort } from '../session-store-helpers'
import { makeMainPane } from '../conversation-instance'
import { registerTabOwner } from '../../protocol/tabs-index'
import { formatSessionStartDivider } from '@ion/shared/clear-divider'
import { rError, rInfo, rWarn } from '../rendererLogger'
import { setTabStatus } from './tab-status-transition'
import { resolveWorktreeForNewTab } from './tab-slice-worktree-resolve'
import { resolveRegisteredWorktree } from '../worktree-registration'
import { adoptTab, createTab, engineStart, ensureEngineSession, fsExists, gitWorktreeSetEphemeralOwner, setPermissionMode } from '../host-api'
import { isAbsolutePath } from '@ion/shared/paths'

/**
 * Options for createConversationTab.
 *
 * - `extensions`: resolved extension list. Non-empty => engine tab.
 *   Empty/absent => plain conversation tab.
 * - `profileId`: engine profile id. Extensions are resolved from the
 *   matching profile unless `extensions` is explicitly supplied.
 * - `setActive`: if false, do not switch the active tab to the new one.
 *   Defaults to true.
 */
export interface CreateConversationTabOpts {
  extensions?: string[]
  /** Source Project policy root; defaults to the final working directory. */
  projectDirectory?: string
  profileId?: string
  setActive?: boolean
  /**
   * Restore-only: reuse a persisted, durable tabId instead of minting a new
   * one. When set, the tab is registered in the engine control plane under this
   * exact id (via adoptTab), so the session key stays invariant
   * across restarts and the engine's key→conversationId binding store hits.
   * Brand-new tabs leave this unset and mint a fresh id via createTab.
   */
  reuseTabId?: string
  /** Request a new worktree before the tab and session are created. */
  useWorktree?: boolean
  /** Explicit branch for a requested worktree. Overrides the saved branch default. */
  sourceBranch?: string
  /**
   * Make the requested worktree ephemeral: removed when this conversation
   * closes with nothing unlanded. Absent means the project's `ephemeralDefault`.
   */
  ephemeralWorktree?: boolean
  /** Restore-only identity already resolved from persisted state/registry. */
  worktree?: import('@ion/shared/types').WorktreeInfo | null
  /**
   * Restore-only: this directory came from persisted state, not from a
   * client naming a path. It exempts the tab from the does-this-machine-have-
   * it check below, because a conversation that already existed keeps its
   * recorded directory even after that directory is gone. `reuseTabId` says
   * the same thing for a tab that also keeps its id; a sessionless restore
   * mints a fresh id and needs this instead.
   */
  restoring?: boolean
}

/**
 * createConversationTab — unified tab + instance creation entry point.
 *
 * Phase 2 of conversation unification (#256). Unified path for all tab kinds
 * (was split: extension-specific sync entry point + async createTabInDirectory
 * for plain). Both tab kinds now receive:
 *   - A real engine-backed tab ID from createTab() (async)
 *   - A single seeded `main` conversationPane instance (MAIN_INSTANCE_ID)
 *   - A session-start divider as the first message
 *
 * The extension list is the ONLY variable between plain and extension tabs:
 *   opts.profileId  => resolve from that profile's extensions
 *   empty/absent    => plain tab (engineProfileId=null)
 *   non-empty       => extension tab (engineProfileId set, tabHasExtensions=true)
 *
 * Extension presence is derived on read via `tabHasExtensions(tab)`,
 * which checks `tab.engineProfileId != null`.
 *
 * Session key for ALL tabs: the bare `tabId` (Phase 4b).
 * This eliminates the old engine-tab random instance-id segment.
 */
export function createConversationTabAction(set: StoreSet, get: StoreGet) {
  return async function createConversationTab(
    dir: string,
    opts: CreateConversationTabOpts = {},
  ): Promise<string> {
    const s = get()
    const homeDir = s.staticInfo?.homePath || '~'
    const prefs = usePreferencesStore.getState()
    const defaultProjectDirectory = Object.keys(prefs.projects ?? {}).find((path) => prefs.projects?.[path]?.isDefault) ?? ''
    const baseWorkingDirectory = dir || defaultProjectDirectory || homeDir
    // A caller names a directory on THIS server's machine. A client that is
    // connected to several servers can send one server a path that only
    // exists on another; accepting it would bind a conversation to a folder
    // this machine does not have and file it under a project that is not
    // here. A restored tab keeps its recorded directory even when that
    // directory has since been removed, so only a new tab is checked --
    // `reuseTabId` and `restoring` are the two ways a caller says so.
    if (dir && !opts.reuseTabId && !opts.restoring && isAbsolutePath(dir)) {
      const { exists } = await fsExists(dir)
      if (!exists) {
        rError('engine.create', 'conversation creation refused: directory does not exist on this machine', { directory: dir })
        throw new Error(`This machine does not have ${dir}. Open the conversation on the machine that has it.`)
      }
    }
    // A new worktree must be resolved before state creation or engine startup.
    // Starting first would bind the session to the source checkout while the UI
    // claimed it lived in the worktree.
    const resolution = await resolveWorktreeForNewTab(
      baseWorkingDirectory,
      opts.useWorktree,
      opts.sourceBranch,
      { ephemeral: opts.ephemeralWorktree },
    )
    const workingDirectory = resolution.dir
    // Restoration supplies already-known metadata. New tabs resolve either the
    // newly-created worktree or a registered identity for their final directory.
    const worktree = opts.worktree ?? (resolution.worktree ?? await resolveRegisteredWorktree(workingDirectory))
    if (worktree?.landedAt && !opts.reuseTabId) {
      rError('engine.create', 'conversation creation refused: worktree has landed', {
        worktree_path: worktree.worktreePath,
      })
      throw new Error('This worktree has already landed and is sealed for review. Retire it when review is complete.')
    }

    // Record the use against the PROJECT, not the worktree the conversation
    // may end up in: the project is what the new-conversation picker lists and
    // orders by most used, and a worktree is a workspace inside one.
    // `addRecentBaseDirectory` refuses an ephemeral worktree path itself, so a
    // conversation started from a worktree row records nothing rather than
    // inventing a project.
    //
    // This is the one place every new conversation passes through, whichever
    // client asked for it, which is why it is here and not at a call site: the
    // picker used to call straight past `createTabInDirectory` and so ordered
    // by a count its own creations never fed. A restore is not a use -- it
    // reopens what was already counted.
    if (!opts.reuseTabId) {
      const projectDirectory = opts.projectDirectory || baseWorkingDirectory
      prefs.addRecentBaseDirectory(projectDirectory)
      rInfo('engine.create', 'project use recorded', { project_directory: projectDirectory, working_directory: workingDirectory })
    }

    // Resolve extensions: explicit list > profile lookup > empty (plain tab)
    const { engineProfiles } = prefs
    const profile = opts.profileId ? engineProfiles.find((p) => p.id === opts.profileId) : null
    const extensions: string[] = opts.extensions ?? profile?.extensions ?? []
    const isEngine = extensions.length > 0

    // Every conversation tab — plain or extension-backed — is born with the same
    // neutral placeholder title. Seeding the profile name here would diverge the
    // two tab kinds at birth and break unified titling: the send-time fallback in
    // send-slice keys off this placeholder to write the first prompt as the title
    // (literal /command for slash, truncated prose otherwise), and the
    // task_complete AI-titling path (event-slice-titling) keys off it too. An
    // extension tab seeded with the profile name never matched that placeholder,
    // so its title never changed. Harness identity is surfaced independently and
    // live from tab.engineProfileId as the harness badge (InboxRow), so the
    // profile name is not lost — it was redundant on the title.
    const title = 'New Tab'

    // Obtain a real engine-backed tab ID. Falls back to a local UUID on IPC
    // failure (offline / startup race) — matches createTabInDirectory behaviour.
    // Restore path: when reuseTabId is supplied, adopt that persisted, durable id
    // instead of minting — this keeps the session key invariant across restarts so
    // the engine binding store resumes the same conversation (root-cause fix for
    // restart fragmentation). On adopt failure, fall back to the supplied id
    // directly (the renderer pane is the source of truth for the tab identity).
    let tabId: string
    if (opts.reuseTabId) {
      try {
        const res = await adoptTab(opts.reuseTabId)
        tabId = res.tabId
      } catch {
        tabId = opts.reuseTabId
      }
    } else {
      try {
        const res = await createTab()
        tabId = res.tabId
      } catch {
        tabId = crypto.randomUUID()
      }
    }

    // The worktree was cut before this id existed. Bind it before the tab is
    // visible, so no close can reach the tab while its worktree has no owner.
    if (resolution.ephemeral && resolution.worktree) {
      const bound = await gitWorktreeSetEphemeralOwner(resolution.worktree.worktreePath, tabId)
      if (!bound.ok) {
        rWarn('engine.create', 'ephemeral worktree owner not bound; it will not close with this conversation', {
          tab_id: tabId.slice(0, 8), worktree_path: resolution.worktree.worktreePath,
        })
      }
    }

    // Initial model for the main instance. Engine tabs seed from engineDefaultModel
    // (or preferredModel); plain tabs apply the plan-model split if in plan mode.
    const initialModel = isEngine
      ? (prefs.engineDefaultModel || prefs.preferredModel || null)
      : initialModelOverride()

    // Session-start divider is the canonical first message on every tab.
    // On tab restoration, createConversationTab is NOT called (the
    // restoration path re-hydrates the pane directly), so no duplicate is
    // produced across app restarts.
    const startDivider = {
      id: nextMsgId(),
      role: 'system' as const,
      content: formatSessionStartDivider(new Date()),
      timestamp: Date.now(),
    }

    const tab: TabState = {
      ...makeLocalTab(),
      id: tabId,
      title,
      workingDirectory,
      hasChosenDirectory: true,
      worktree,
      pendingWorktreeSetup: resolution.pendingSetup,
      inputLockReason: worktree?.landedAt ? 'landed-worktree' : null,
      inputLocked: !!worktree?.landedAt,
      // engineProfileId is the derivation source for tabHasExtensions(). Set it
      // only when the tab actually runs with extensions (isEngine=true). When
      // extensions are provided without a profileId (direct extension list), use
      // a synthetic sentinel so the tab still derives as "has extensions."
      engineProfileId: isEngine ? (opts.profileId || '__direct__') : null,
      // permissionMode is not a tab-level field — it lives on the
      // conversation instance (WI-002).
    }
    if (tab.principalSubject) registerTabOwner(tab.id, tab.principalSubject)

    // Single main instance. Both plain and engine tabs use the bare tabId
    // as the session key (Phase 4b collapsed the compound key).
    // Engine tabs start in auto mode (extensions control plan mode); plain
    // tabs start with the user's default permission mode.
    const initMode: 'auto' | 'plan' = isEngine ? (profile?.defaultMode ?? 'auto') : initialPermissionMode()
    const pane = makeMainPane(
      { modelOverride: initialModel, modelOverrideSource: initialModel ? 'automatic' : null, messages: [startDivider], messageCount: 1, permissionMode: initMode, thinkingEffort: initialThinkingEffort(initialModel) },
      'main',
    )

    set((state) => ({
      tabs: [...state.tabs, tab],
      conversationPanes: new Map(state.conversationPanes).set(tabId, pane),
      ...(opts.setActive !== false
        ? {
            activeTabId: tabId,
            // One tall-default for every conversation tab (data-driven creation;
            // the engine-specific tall default was collapsed away).
            tallViewTabId: null,
            terminalTallTabId: null,
          }
        : {}),
    }))

    // A persisted tab opened for landed-worktree review keeps its history but
    // must never start or wake an engine session again.
    if (worktree?.landedAt) return tabId

    // Start the engine session for both tab kinds so the engine mints+binds the
    // conversation id at creation time (it is returned by start_session and
    // captured below). Pre-starting is the root-cause fix for "Copy session id is
    // empty on a fresh tab": the id no longer waits for the first prompt's
    // session_init. Both calls are fire-and-forget for the returned tabId (the
    // pane is already in state); the id is applied asynchronously when it lands.
    if (isEngine) {
      // Engine: start the session keyed by the bare tabId. A NEW tab moves to
      // 'connecting' so EngineView shows the connecting indicator. A restored
      // tab (reuseTabId) is reattaching in the background, not doing work:
      // marking it 'connecting' made every restored conversation read as
      // working, so collapsed Inbox groups flashed each one in and out at boot.
      // EngineView's auto-create effect (addEngineInstance) will find the
      // pane already populated and skip, so there is no duplicate start.
      if (!opts.reuseTabId) {
        set((state) => ({
          tabs: setTabStatus(state.tabs, tabId, 'connecting', 'engine.create-connecting'),
        }))
      }
      engineStart(tabId, {
        profileId: profile?.id || '',
        extensions,
        workingDirectory,
        ...(opts.projectDirectory ? { projectDirectory: opts.projectDirectory } : {}),
      }).then((result) => {
        if (result && !result.ok) {
          rError('engine.create', 'engine start failed', { error: result.error })
          _onEngineStartError(set, tabId, tabId, result.error || 'unknown')
          return
        }
        if (result?.conversationId) {
          _captureMintedConversationId(set, tabId, result.conversationId)
        }
        if (initMode === 'plan') {
          setPermissionMode(tabId, 'plan', 'session_start')
        }
      }).catch((err: { message?: string }) => {
        rError('engine.create', 'engine start threw', { error: err.message })
        _onEngineStartError(set, tabId, tabId, err.message || 'error')
      })
    } else {
      // Plain tab: pre-start the engine session through the control plane so the
      // engine mints the conversation id now (rather than on the first prompt).
      // ensureSession is idempotent and applies the permission mode (it sends
      // set_plan_mode when initMode==='plan'), so this replaces the prior
      // setPermissionMode-only call without losing plan-mode behavior, and the
      // later submitPrompt→ensureSession no-ops on engineSessionStarted.
      ensureEngineSession({
        tabId,
        workingDirectory,
        permissionMode: initMode,
      }).then((result) => {
        if (result && !result.ok) {
          rError('engine.create', 'ensureEngineSession failed', { error: result.error })
          return
        }
        if (result?.conversationId) {
          _captureMintedConversationId(set, tabId, result.conversationId)
        }
      }).catch((err: { message?: string }) => {
        rError('engine.create', 'ensureEngineSession threw', { error: err.message })
      })
    }

    return tabId
  }
}

/** Write an error message onto the main instance and reset tab status. */
function _onEngineStartError(
  set: StoreSet,
  _key: string,
  tabId: string,
  errorMsg: string,
): void {
  set((state) => {
    const conversationPanes = new Map(state.conversationPanes)
    const pane = conversationPanes.get(tabId)
    if (pane) {
      const idx = pane.instances.findIndex((i) => i.id === 'main')
      if (idx !== -1) {
        const instances = pane.instances.slice()
        instances[idx] = {
          ...instances[idx],
          messages: [
            ...instances[idx].messages,
            { id: nextMsgId(), role: 'system' as const, content: `Engine start failed: ${errorMsg}`, timestamp: Date.now() },
          ],
        }
        conversationPanes.set(tabId, { ...pane, instances })
      }
    }
    const tabs = setTabStatus(state.tabs, tabId, 'idle', 'engine.create-online')
    return { conversationPanes, tabs }
  })
}

/**
 * Capture the engine-minted conversation id onto the tab and its main instance
 * at tab-creation time.
 *
 * The engine binds the conversation id inside StartSession and returns it in the
 * start_session result (see engine/internal/session/start_session.go and the
 * desktop bridge in engine-bridge-start-session.ts). That id is available before
 * any run emits session_init/engine_status, so recording it here makes "Copy
 * session ID" controls work on a fresh
 * tab — without it those affordances have nothing to copy until the first prompt.
 *
 * Idempotent and additive: writes the tab-level conversationId/lastKnownSessionId
 * only when unset, and unions the id into the main instance's conversationIds.
 * The steady-state session_init capture (event-slice.ts) and engine_status
 * capture (engine-control-plane-events.ts) set the same fields with the same id,
 * so this never conflicts — it only fills the pre-first-run gap.
 */
export function _captureMintedConversationId(
  set: StoreSet,
  tabId: string,
  conversationId: string,
): void {
  set((state) => {
    const tabs = state.tabs.map((t) => {
      if (t.id !== tabId) return t
      if (t.conversationId) return t
      return { ...t, conversationId, lastKnownSessionId: conversationId }
    })
    const conversationPanes = new Map(state.conversationPanes)
    const pane = conversationPanes.get(tabId)
    if (pane) {
      const idx = pane.instances.findIndex((i) => i.id === 'main')
      if (idx !== -1) {
        const inst = pane.instances[idx]
        if (!inst.conversationIds.includes(conversationId)) {
          const instances = pane.instances.slice()
          instances[idx] = { ...inst, conversationIds: [...inst.conversationIds, conversationId] }
          conversationPanes.set(tabId, { ...pane, instances })
        }
      }
    }
    return { tabs, conversationPanes }
  })
}
