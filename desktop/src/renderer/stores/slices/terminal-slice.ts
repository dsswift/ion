import type { TabState, TerminalInstance } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import { destroyTerminalInstance } from '../../components/TerminalPanel'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, isBlankTerminalTab } from '../session-store-helpers'

export function createTerminalSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    toggleTerminal: (tabId) => {
      set((s) => {
        const next = new Set(s.terminalOpenTabIds)
        const closing = next.has(tabId)
        if (closing) {
          next.delete(tabId)
        } else {
          next.add(tabId)
        }
        return {
          terminalOpenTabIds: next,
          ...(closing && s.terminalTallTabId === tabId ? { terminalTallTabId: null } : {}),
          ...(closing && s.terminalBigScreenTabId === tabId ? { terminalBigScreenTabId: null } : {}),
        }
      })
    },

    addTerminalInstance: (tabId, kind, cwd?) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      const resolvedCwd = cwd || tab?.workingDirectory || '~'
      const panes = new Map(get().terminalPanes)
      const pane = panes.get(tabId) || { instances: [], activeInstanceId: null }
      let labelBase = kind === 'commit' ? 'Commit' : kind === 'cli' ? 'CLI' : kind === 'user' ? 'Shell' : 'Shell'
      if (kind.startsWith('tool:')) {
        const toolId = kind.slice(5)
        const tool = usePreferencesStore.getState().quickTools.find((t) => t.id === toolId)
        labelBase = tool?.name || 'Tool'
      }
      let label: string
      if (kind === 'user') {
        const maxShellNum = pane.instances
          .filter((i) => i.kind === 'user')
          .reduce((max, i) => {
            const m = i.label.match(/^Shell (\d+)$/)
            return m ? Math.max(max, parseInt(m[1], 10)) : max
          }, 0)
        label = `${labelBase} ${maxShellNum + 1}`
      } else {
        label = labelBase
      }
      const id = crypto.randomUUID().slice(0, 8)
      const instance: TerminalInstance = { id, label, kind, readOnly: kind !== 'user', cwd: resolvedCwd }
      panes.set(tabId, {
        instances: [...pane.instances, instance],
        activeInstanceId: id,
      })
      set({ terminalPanes: panes })
      return id
    },

    removeTerminalInstance: (tabId, instanceId) => {
      const panes = new Map(get().terminalPanes)
      const pane = panes.get(tabId)
      if (!pane) return
      const key = `${tabId}:${instanceId}`
      window.ion.terminalDestroy(key).catch(() => {})
      destroyTerminalInstance(key)
      const remaining = pane.instances.filter((i) => i.id !== instanceId)
      const activeId = pane.activeInstanceId === instanceId
        ? (remaining[remaining.length - 1]?.id || null)
        : pane.activeInstanceId
      if (remaining.length === 0) {
        panes.delete(tabId)
        const s = get()
        const tab = s.tabs.find((t) => t.id === tabId)
        if (tab?.isTerminalOnly) {
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
        return { terminalTallTabId: tabId, tallViewTabId: null }
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

    getOrCreateDedicatedTerminal: (tabId, kind) => {
      const pane = get().terminalPanes.get(tabId)
      const existing = pane?.instances.find((i) => i.kind === kind)
      if (existing) return existing.id
      return get().addTerminalInstance(tabId, kind)
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

    createTerminalTab: async (dir?: string) => {
      const homeDir = get().staticInfo?.homePath || '~'
      const defaultBase = usePreferencesStore.getState().defaultBaseDirectory
      const startDir = dir || defaultBase || homeDir

      const existingBlank = get().tabs.find((t) => isBlankTerminalTab(t, startDir))
      if (existingBlank) {
        const tallTerm = usePreferencesStore.getState().defaultTallTerminal
        set({
          activeTabId: existingBlank.id,
          terminalTallTabId: tallTerm ? existingBlank.id : null,
          tallViewTabId: null,
        })
        return existingBlank.id
      }

      const { tabGroupMode, tabGroups } = usePreferencesStore.getState()
      const groupId = tabGroupMode === 'manual'
        ? (tabGroups.find((g) => g.isDefault)?.id || tabGroups[0]?.id || null)
        : null

      const tab: TabState = {
        ...makeLocalTab(),
        title: 'New Terminal',
        isTerminalOnly: true,
        workingDirectory: startDir,
        hasChosenDirectory: !!(dir || defaultBase),
        pillIcon: 'Terminal',
        groupId,
      }

      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        terminalOpenTabIds: new Set([...s.terminalOpenTabIds, tab.id]),
        terminalTallTabId: usePreferencesStore.getState().defaultTallTerminal ? tab.id : null,
        tallViewTabId: null,
      }))

      return tab.id
    },

    runInTerminal: (tabId, cmd) => {
      const instanceId = get().getOrCreateDedicatedTerminal(tabId, 'commit')
      get().selectTerminalInstance(tabId, instanceId)
      const key = `${tabId}:${instanceId}`
      set((s) => {
        const nextOpen = new Set(s.terminalOpenTabIds)
        const nextPending = new Map(s.terminalPendingCommands)
        nextPending.set(key, cmd)
        if (nextOpen.has(tabId)) {
          window.ion.terminalWrite(key, cmd + '\n')
          nextPending.delete(key)
        } else {
          nextOpen.add(tabId)
        }
        return { terminalOpenTabIds: nextOpen, terminalPendingCommands: nextPending }
      })
    },

    runQuickTool: (tabId, toolId) => {
      const tool = usePreferencesStore.getState().quickTools.find((t) => t.id === toolId)
      if (!tool) return
      const tab = get().tabs.find((t) => t.id === tabId)
      const cwd = tab?.workingDirectory || '~'
      const kind = `tool:${toolId}`
      const instanceId = get().getOrCreateDedicatedTerminal(tabId, kind)
      get().selectTerminalInstance(tabId, instanceId)
      const resolveAndRun = async () => {
        let branch = 'main'
        try {
          const result = await window.ion.gitChanges(cwd)
          if (result?.branch) branch = result.branch
        } catch { /* fall back to 'main' */ }
        const cmd = tool.command.replace(/\{cwd\}/g, cwd).replace(/\{branch\}/g, branch)
        const key = `${tabId}:${instanceId}`
        const s = get()
        const nextOpen = new Set(s.terminalOpenTabIds)
        const nextPending = new Map(s.terminalPendingCommands)
        nextPending.set(key, cmd)
        if (nextOpen.has(tabId)) {
          window.ion.terminalWrite(key, cmd + '\n')
          nextPending.delete(key)
        } else {
          nextOpen.add(tabId)
        }
        set({ terminalOpenTabIds: nextOpen, terminalPendingCommands: nextPending })
      }
      resolveAndRun()
    },

    consumeTerminalPendingCommand: (key) => {
      const cmd = get().terminalPendingCommands.get(key)
      if (cmd) {
        set((s) => {
          const next = new Map(s.terminalPendingCommands)
          next.delete(key)
          return { terminalPendingCommands: next }
        })
      }
      return cmd
    },
  }
}
