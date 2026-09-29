import type { TabState, TerminalInstance } from '@ion/shared/types'
import { usePreferencesStore } from '../../persistence/preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { PROJECT_QUICK_TOOL_ID_PREFIX } from '@ion/shared/project-studio-config'
import { makeLocalTab, isReusableBlankTerminalTab, editorDirForTab } from '../session-store-helpers'
import { rDebug, rWarn } from '../rendererLogger'
import { resolveRegisteredWorktree } from '../worktree-registration'
import { gitChanges, resolveProjectQuickTool, terminalAttach, terminalCreate, terminalDestroy, terminalRelaunch, terminalWrite } from '../host-api'

// ─── Tall-suspend helpers ─────────────────────────────────────────────────────

/**
 * Returns the tall-suspend patch to merge when a terminal opens on `tabId`.
 * If conversation-tall is currently ON for that tab, clear it and record the
 * marker. Otherwise returns nothing.
 */
function tallSuspendOnOpen(s: { tallViewTabId: string | null }, tabId: string) {
  if (s.tallViewTabId === tabId) {
    return { tallViewTabId: null as string | null, suspendedTallTabId: tabId }
  }
  return {}
}

/**
 * Returns the tall-restore patch to merge when a terminal closes for `tabId`.
 * Restores tall only if the marker still points at this tab; clears the marker
 * either way so we don't fight a future manual toggle.
 */
function tallRestoreOnClose(s: { suspendedTallTabId: string | null }, tabId: string) {
  if (s.suspendedTallTabId === tabId) {
    return { tallViewTabId: tabId, suspendedTallTabId: null as string | null }
  }
  return {}
}

// ─────────────────────────────────────────────────────────────────────────────

/** Per-conversation shell creation under way through `ensureTerminalInstance`. */
const ensureInFlight = new Map<string, Promise<string>>()

/** How long `ensureTerminalInstance` waits for boot restoration before deciding anyway. */
const TABS_READY_WAIT_MS = 15_000

/** Resolves once the store has finished restoring tabs (their saved shells included), or after the bounded wait. */
function whenTabsReady(get: StoreGet): Promise<void> {
  if (get().tabsReady) return Promise.resolve()
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (get().tabsReady) { clearInterval(timer); resolve(); return }
      if (Date.now() - started >= TABS_READY_WAIT_MS) {
        clearInterval(timer)
        rWarn('terminal', 'ensure shell: restore did not finish in time; deciding on current state', { waited_ms: TABS_READY_WAIT_MS })
        resolve()
      }
    }, 50)
  })
}

export function createTerminalSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    toggleTerminal: async (tabId) => {
      const closing = get().terminalOpenTabIds.has(tabId)
      if (!closing && !get().terminalPanes.get(tabId)?.instances.length) {
        await get().addTerminalInstance(tabId, 'user')
        rDebug('terminal', 'conversation terminal panel toggled', {
          tab_id: tabId,
          open: true,
        })
        return
      }
      set((s) => {
        const next = new Set(s.terminalOpenTabIds)
        if (closing) next.delete(tabId)
        else next.add(tabId)
        return {
          terminalOpenTabIds: next,
          ...(closing ? tallRestoreOnClose(s, tabId) : tallSuspendOnOpen(s, tabId)),
          ...(closing && s.terminalTallTabId === tabId ? { terminalTallTabId: null } : {}),
          ...(closing && s.terminalBigScreenTabId === tabId ? { terminalBigScreenTabId: null } : {}),
        }
      })
      rDebug('terminal', 'conversation terminal panel toggled', {
        tab_id: tabId,
        open: !closing,
      })
    },

    ensureTerminalInstance: (tabId, cwd?) => {
      // Decided HERE, by the owner, never by a client. A client's terminal
      // panel mounts before this server's terminal state reaches it, so
      // "this conversation has no shell" read from a client is a guess: on
      // every launch the panel saw an empty pane, asked for a shell, and
      // the conversation gained one more beside the shells restored from
      // disk. The owner also waits for its own restore to finish, because
      // a restored tab exists for a moment before its saved shells are put
      // back. Concurrent callers (two windows mounting at once) share one
      // creation.
      const inFlight = ensureInFlight.get(tabId)
      if (inFlight) {
        rDebug('terminal', 'ensure shell: joining the creation already under way', { tab_id: tabId })
        return inFlight
      }
      const run = (async (): Promise<string> => {
        await whenTabsReady(get)
        const pane = get().terminalPanes.get(tabId)
        if (pane && pane.instances.length > 0) {
          const id = pane.activeInstanceId ?? pane.instances[0].id
          rDebug('terminal', 'ensure shell: conversation already has one; nothing created', { tab_id: tabId, instance_count: pane.instances.length })
          return id
        }
        rDebug('terminal', 'ensure shell: conversation has none; creating the first', { tab_id: tabId })
        return get().addTerminalInstance(tabId, 'user', cwd)
      })().finally(() => ensureInFlight.delete(tabId))
      ensureInFlight.set(tabId, run)
      return run
    },

    addTerminalInstance: async (tabId, kind, cwd?, requestedLabel?, launchKey?) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) {
        rWarn('terminal', 'terminal creation refused: conversation not found', { tab_id: tabId, kind })
        throw new Error(`Conversation ${tabId} is not open.`)
      }
      let labelBase = kind === 'commit' ? 'Commit' : kind === 'cli' ? 'CLI' : kind === 'user' ? 'Shell' : 'Shell'
      if (kind.startsWith('tool:')) {
        const toolId = kind.slice(5)
        const tool = usePreferencesStore.getState().quickTools.find((t) => t.id === toolId)
        labelBase = tool?.name || 'Tool'
      }
      const id = crypto.randomUUID().slice(0, 8)
      const resolvedCwd = cwd || tab.workingDirectory || '~'
      const key = `${tabId}:${id}`
      try {
        await terminalCreate(key, resolvedCwd)
      } catch (error) {
        rWarn('terminal', 'conversation terminal create failed', {
          key,
          tab_id: tabId,
          instance_id: id,
          kind,
          cwd: resolvedCwd,
          error: String(error),
        })
        throw error
      }
      let committedLabel = labelBase
      set((s) => {
        const latestPanes = new Map(s.terminalPanes)
        const latestPane = latestPanes.get(tabId) || { instances: [], activeInstanceId: null }
        let label = labelBase
        if (kind === 'user' && requestedLabel?.trim()) {
          label = requestedLabel.trim()
        } else if (kind === 'user') {
          const maxShellNum = latestPane.instances
            .filter((candidate) => candidate.kind === 'user')
            .reduce((max, candidate) => {
              const match = candidate.label.match(/^Shell (\d+)$/)
              return match ? Math.max(max, parseInt(match[1], 10)) : max
            }, 0)
          label = `${labelBase} ${maxShellNum + 1}`
        }
        committedLabel = label
        const instance: TerminalInstance = { id, label, kind, readOnly: kind !== 'user', cwd: resolvedCwd, ...(launchKey ? { launchKey } : {}) }
        latestPanes.set(tabId, {
          instances: [...latestPane.instances, instance],
          activeInstanceId: id,
        })
        const terminalOpenTabIds = new Set(s.terminalOpenTabIds)
        const wasOpen = terminalOpenTabIds.has(tabId)
        terminalOpenTabIds.add(tabId)
        return {
          terminalPanes: latestPanes,
          terminalOpenTabIds,
          ...(!wasOpen ? tallSuspendOnOpen(s, tabId) : {}),
        }
      })
      rDebug('terminal', 'conversation terminal created', {
        key,
        tab_id: tabId,
        instance_id: id,
        label: committedLabel,
        kind,
        cwd: resolvedCwd,
        launch_key: launchKey ?? '',
      })
      return id
    },

    relaunchTerminalInstance: async (tabId, instanceId, cwd?, label?) => {
      const existing = get().terminalPanes.get(tabId)?.instances.find((i) => i.id === instanceId)
      if (!existing) {
        rWarn('terminal', 'terminal relaunch refused: instance not found', { tab_id: tabId, instance_id: instanceId })
        throw new Error(`Terminal ${instanceId} is not open in conversation ${tabId}.`)
      }
      const key = `${tabId}:${instanceId}`
      const resolvedCwd = cwd || existing.cwd || '~'
      const nextLabel = label?.trim() || existing.label
      // Metadata first: the pane shows the new name and directory while the
      // previous processes are being stopped, and stays that way if the new
      // shell fails to start (the failure is on the terminal itself).
      set((s) => {
        const panes = new Map(s.terminalPanes)
        const pane = panes.get(tabId)
        if (!pane) return {}
        panes.set(tabId, {
          instances: pane.instances.map((i) => (i.id === instanceId ? { ...i, cwd: resolvedCwd, label: nextLabel } : i)),
          activeInstanceId: instanceId,
        })
        const terminalOpenTabIds = new Set(s.terminalOpenTabIds)
        const wasOpen = terminalOpenTabIds.has(tabId)
        terminalOpenTabIds.add(tabId)
        return { terminalPanes: panes, terminalOpenTabIds, ...(!wasOpen ? tallSuspendOnOpen(s, tabId) : {}) }
      })
      try {
        await terminalRelaunch(key, resolvedCwd)
      } catch (error) {
        rWarn('terminal', 'conversation terminal relaunch failed', { key, tab_id: tabId, instance_id: instanceId, cwd: resolvedCwd, error: String(error) })
        throw error
      }
      rDebug('terminal', 'conversation terminal relaunched', { key, tab_id: tabId, instance_id: instanceId, label: nextLabel, cwd: resolvedCwd })
    },

    removeTerminalInstance: async (tabId, instanceId) => {
      const pane = get().terminalPanes.get(tabId)
      if (!pane) return
      const key = `${tabId}:${instanceId}`
      try {
        await terminalDestroy(key)
        rDebug('terminal', 'conversation terminal destroyed', {
          key,
          tab_id: tabId,
          instance_id: instanceId,
        })
      } catch (error) {
        rWarn('terminal', 'terminalDestroy IPC failed', { key, error: String(error) })
        throw error
      }
      const panes = new Map(get().terminalPanes)
      const current = panes.get(tabId)
      if (!current) return
      const remaining = current.instances.filter((i) => i.id !== instanceId)
      const activeId = current.activeInstanceId === instanceId
        ? (remaining[remaining.length - 1]?.id || null)
        : current.activeInstanceId
      if (remaining.length === 0) {
        panes.delete(tabId)
        const s = get()
        const tab = s.tabs.find((t) => t.id === tabId)
        if (tab?.isTerminalOnly) {
          // isTerminalOnly tabs are closed entirely; clear any suspend marker so
          // the dead tab is never restored to tall by tab-slice's closeTab path.
          if (s.suspendedTallTabId === tabId) {
            set({ suspendedTallTabId: null })
          }
          get().closeTab(tabId)
          set({ terminalPanes: panes })
        } else {
          const nextOpen = new Set(s.terminalOpenTabIds)
          nextOpen.delete(tabId)
          set({
            terminalPanes: panes,
            terminalOpenTabIds: nextOpen,
            ...(s.terminalTallTabId === tabId ? { terminalTallTabId: null } : {}),
            ...(s.terminalBigScreenTabId === tabId ? { terminalBigScreenTabId: null } : {}),
            ...tallRestoreOnClose(s, tabId),
          })
        }
      } else {
        panes.set(tabId, { instances: remaining, activeInstanceId: activeId })
        set({ terminalPanes: panes })
      }
    },

    selectTerminalInstance: (tabId, instanceId) => {
      const panes = new Map(get().terminalPanes)
      const pane = panes.get(tabId)
      if (!pane) return
      panes.set(tabId, { ...pane, activeInstanceId: instanceId })
      set({ terminalPanes: panes })
    },

    toggleTerminalReadOnly: (tabId, instanceId) => {
      const panes = new Map(get().terminalPanes)
      const pane = panes.get(tabId)
      if (!pane) return
      panes.set(tabId, {
        ...pane,
        instances: pane.instances.map((i) =>
          i.id === instanceId ? { ...i, readOnly: !i.readOnly } : i
        ),
      })
      set({ terminalPanes: panes })
    },

    toggleTerminalTall: (tabId) => {
      set((s) => {
        if (s.terminalTallTabId === tabId) {
          return { terminalTallTabId: null }
        }
        // Entering terminal-tall: clear both conversation-tall and the suspend
        // marker so we never fight a later manual state change.
        return {
          terminalTallTabId: tabId,
          tallViewTabId: null,
          suspendedTallTabId: null,
        }
      })
    },

    toggleTerminalBigScreen: (tabId) => {
      set((s) => {
        if (s.terminalBigScreenTabId === tabId) {
          return { terminalBigScreenTabId: null, terminalTallTabId: null }
        }
        return { terminalBigScreenTabId: tabId }
      })
    },

    getOrCreateDedicatedTerminal: async (tabId, kind) => {
      const pane = get().terminalPanes.get(tabId)
      const existing = pane?.instances.find((i) => i.kind === kind)
      if (existing) {
        const key = `${tabId}:${existing.id}`
        const info = await terminalAttach(key, {
          restartIfNotRunning: true,
          cwd: existing.cwd,
        })
        rDebug('terminal', 'dedicated conversation terminal ready', {
          key,
          tab_id: tabId,
          instance_id: existing.id,
          kind,
          running: info.running,
        })
        return existing.id
      }
      return await get().addTerminalInstance(tabId, kind)
    },

    renameTerminalInstance: (tabId, instanceId, label) => {
      const panes = new Map(get().terminalPanes)
      const pane = panes.get(tabId)
      if (!pane) return
      panes.set(tabId, {
        ...pane,
        instances: pane.instances.map((i) =>
          i.id === instanceId ? { ...i, label } : i
        ),
      })
      set({ terminalPanes: panes })
    },

    createTerminalTab: async (dir?: string, adoptTabId?: string) => {
      const homeDir = get().staticInfo?.homePath || '~'
      const defaultBase = usePreferencesStore.getState().defaultBaseDirectory
      const startDir = dir || defaultBase || homeDir
      const worktree = await resolveRegisteredWorktree(startDir)
      if (worktree?.landedAt) {
        rWarn('terminal', 'terminal creation refused: worktree has landed', {
          worktree_path: worktree.worktreePath,
        })
        throw new Error('This worktree has already landed and is sealed for review. Retire it when review is complete.')
      }

      // Restore supplies the persisted id, and must never fold into an
      // existing blank terminal: that would merge two distinct tabs and drop
      // whatever is keyed by the id being restored.
      const existingBlank = adoptTabId ? undefined : get().tabs.find((t) => isReusableBlankTerminalTab(t, startDir))
      if (existingBlank) {
        set({
          activeTabId: existingBlank.id,
          terminalTallTabId: null,
          tallViewTabId: null,
        })
        return existingBlank.id
      }

      const tab: TabState = {
        ...makeLocalTab(),
        // Adopt the persisted id on restore so per-conversation state keyed by
        // it (Studio Surface descriptors, saved terminal buffers) still
        // resolves after a restart.
        ...(adoptTabId ? { id: adoptTabId } : {}),
        title: 'New Terminal',
        isTerminalOnly: true,
        workingDirectory: startDir,
        hasChosenDirectory: !!(dir || defaultBase),
      }

      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        terminalOpenTabIds: new Set([...s.terminalOpenTabIds, tab.id]),
        terminalTallTabId: null,
        tallViewTabId: null,
      }))

      return tab.id
    },

    runInTerminal: async (tabId, cmd) => {
      const instanceId = await get().getOrCreateDedicatedTerminal(tabId, 'commit')
      get().selectTerminalInstance(tabId, instanceId)
      const key = `${tabId}:${instanceId}`
      set((s) => {
        const nextOpen = new Set(s.terminalOpenTabIds)
        const wasOpen = nextOpen.has(tabId)
        nextOpen.add(tabId)
        return {
          terminalOpenTabIds: nextOpen,
          ...(!wasOpen ? tallSuspendOnOpen(s, tabId) : {}),
        }
      })
      terminalWrite(key, cmd + '\n')
      rDebug('terminal', 'command sent to conversation terminal', {
        key,
        tab_id: tabId,
        instance_id: instanceId,
        command_length: cmd.length,
      })
    },

    runQuickTool: async (tabId, toolId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      const cwd = tab?.workingDirectory || '~'
      // A `project:` id names a tool the project ships. Its command is read
      // here, from the project's own file, and only while the operator trusts
      // that exact list: a client never supplies the command.
      const tool = toolId.startsWith(PROJECT_QUICK_TOOL_ID_PREFIX)
        ? await resolveProjectQuickTool(tab ? editorDirForTab(tab) : cwd, toolId)
        : usePreferencesStore.getState().quickTools.find((t) => t.id === toolId)
      if (!tool) {
        rWarn('terminal', 'quick tool launch refused: tool not found or not trusted', { tab_id: tabId, tool_id: toolId })
        return
      }
      const kind = `tool:${toolId}`
      const instanceId = await get().getOrCreateDedicatedTerminal(tabId, kind)
      get().selectTerminalInstance(tabId, instanceId)
      let branch = 'main'
      try {
        const result = await gitChanges(cwd)
        if (result?.branch) branch = result.branch
      } catch (error) {
        rDebug('terminal', 'quick tool branch lookup failed; using main', {
          tab_id: tabId,
          tool_id: toolId,
          cwd,
          error: String(error),
        })
      }
      const cmd = tool.command.replace(/\{cwd\}/g, cwd).replace(/\{branch\}/g, branch)
      const key = `${tabId}:${instanceId}`
      set((s) => {
        const nextOpen = new Set(s.terminalOpenTabIds)
        const wasOpen = nextOpen.has(tabId)
        nextOpen.add(tabId)
        return {
          terminalOpenTabIds: nextOpen,
          ...(!wasOpen ? tallSuspendOnOpen(s, tabId) : {}),
        }
      })
      terminalWrite(key, cmd + '\n')
      rDebug('terminal', 'quick tool sent to conversation terminal', {
        key,
        tab_id: tabId,
        instance_id: instanceId,
        tool_id: toolId,
        command_length: cmd.length,
      })
    },
  }
}
