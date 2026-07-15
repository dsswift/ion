/**
 * AtvShell — layout root of the ATV window's premium chrome.
 *
 * Boots the session store in MIRROR mode (forwarded actions, owner tab
 * sync, full event stream — see shared/atv-mirror-actions.ts and the ATV
 * shell ADR), then wraps the office canvas (AtvApp) with the same
 * first-class components the overlay uses: the real TabStrip, side dock,
 * and status bar. (No separate state banner — the status bar is the one
 * conversation-state surface, same as the overlay.)
 *
 * Overlay↔ATV parity mechanism 1: shared surfaces are the SAME component
 * reading the same store — never a bespoke ATV widget.
 */
import React, { useEffect, useRef, useState } from 'react'
import { useSessionStore, editorDirForTab } from '../stores/sessionStore'
import { activeInstance } from '../stores/conversation-instance'
import { FileEditor } from '../components/FileEditor'
import { StatusBar } from '../components/StatusBar'
import { useEngineEvents } from '../hooks/useEngineEvents'
import { PopoverLayerProvider } from '../components/PopoverLayer'
import { TabStrip } from '../components/TabStrip'
import { useColors } from '../theme'
import { rInfo } from '../rendererLogger'
import { applyMirrorOverrides, initTabsSync, initPermissionResolutionSync, initUserMessageEcho } from './state/secondary-store'
import { AtvSideDock } from './AtvSideDock'
import { AtvApp } from './AtvApp'
import { AtvControlsPopover } from './AtvControlsPopover'
import { useAtvControlsBus } from './state/controls-bus'
import { CommandPalette } from '../components/CommandPalette'
import type { PaletteEntry } from '../components/command-palette-rank'

/** One-time mirror boot, before the first render reads the store. */
let booted = false
function bootMirror(): void {
  if (booted) return
  booted = true
  const swapped = applyMirrorOverrides()
  initTabsSync()
  initPermissionResolutionSync()
  initUserMessageEcho()
  rInfo('atv', 'mirror booted', { forwarded_actions: swapped.length })
}

export function AtvShell(): React.JSX.Element {
  bootMirror()
  const colors = useColors()
  // useEngineEvents is window-agnostic by construction: it registers the
  // full listener set, but only the channels main forwards to this window
  // (normalized events, tab status, errors, settings) ever fire here.
  useEngineEvents()

  // The owner's active tab is authoritative; mirror-store highlight follows
  // the same push the canvas retargets on.
  const [ready, setReady] = useState(false)
  const [dockOpen, setDockOpen] = useState(false)
  useEffect(() => {
    const off = window.ion.onAtvActiveTab((tabId) => {
      useSessionStore.setState({ activeTabId: tabId })
    })
    // Consider the shell ready once tabs hydrate (initTabsSync sets tabsReady).
    const unsub = useSessionStore.subscribe((s) => {
      if (s.tabsReady) setReady(true)
    })
    if (useSessionStore.getState().tabsReady) setReady(true)
    return () => {
      off()
      unsub()
    }
  }, [])

  // Auto-open the dock when the conversation starts AWAITING the user
  // (plan/question/permission) — the operator lives here; the pending card
  // must come to them. Gated by the atvAutoDrawer setting.
  const awaiting = useSessionStore((s) => {
    const inst = activeInstance(s.conversationPanes, s.activeTabId)
    return (inst?.permissionQueue.length ?? 0) > 0
  })
  const autoDrawerRef = useRef(true)
  const [dockLayout, setDockLayout] = useState<{ dockWidth: number; dockTab: 'conversation' | 'files' }>({ dockWidth: 420, dockTab: 'conversation' })
  useEffect(() => {
    void window.ion.atvGetSettings().then((s) => {
      if (!s) return
      if (typeof s.atvAutoDrawer === 'boolean') autoDrawerRef.current = s.atvAutoDrawer
      // One global layout state, restored on every open.
      if (s.atvLayout && typeof s.atvLayout === 'object') {
        setDockOpen(s.atvLayout.dockOpen === true)
        setDockLayout({
          dockWidth: typeof s.atvLayout.dockWidth === 'number' ? s.atvLayout.dockWidth : 420,
          dockTab: s.atvLayout.dockTab === 'files' ? 'files' : 'conversation',
        })
      }
    })
  }, [])

  // Persist the layout on any change (debounced — resize drags fire often).
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistLayout = (patch: Partial<{ dockOpen: boolean; dockWidth: number; dockTab: 'conversation' | 'files' }>): void => {
    if (layoutTimer.current) clearTimeout(layoutTimer.current)
    const next = { dockOpen, ...dockLayout, ...patch }
    layoutTimer.current = setTimeout(() => {
      void window.ion.atvSetSetting('atvLayout', next)
    }, 300)
  }
  useEffect(() => {
    if (awaiting && autoDrawerRef.current) setDockOpen(true)
  }, [awaiting])

  // Keyboard-first: ⌘1-9 switch tabs (forwarded select); Esc closes the
  // dock when no palette/overlay consumed it. Drag-drop attach: files
  // dropped anywhere stage on the active conversation's composer.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1
        const tab = useSessionStore.getState().tabs[idx]
        if (tab) {
          e.preventDefault()
          useSessionStore.getState().selectTab(tab.id)
        }
      } else if (e.key === 'Escape') {
        setDockOpen(false)
      }
    }
    function onDrop(e: DragEvent): void {
      e.preventDefault()
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length === 0 || !useSessionStore.getState().activeTabId) return
      const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i
      const attachments = files
        .map((f) => ({ file: f, path: window.ion.getPathForFile?.(f) ?? '' }))
        .filter((x) => x.path)
        .map(({ file, path }) => ({
          id: crypto.randomUUID(),
          type: (IMAGE.test(file.name) ? 'image' : 'file') as 'image' | 'file',
          name: file.name,
          path,
        }))
      if (attachments.length === 0) return
      // Forwarded action: stages on the OWNER's active tab (same tab by the
      // single-focus rule); chips appear via the mirror's tabs-sync.
      useSessionStore.getState().addAttachments(attachments)
      setDockOpen(true) // bring the composer into view
    }
    function onDragOver(e: DragEvent): void {
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragover', onDragOver)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragover', onDragOver)
    }
  }, [])

  // TabStrip's ATV button (mirror verb): toggles the visualizer-controls
  // popover anchored at the button. See AtvLauncherButton.
  useEffect(() => {
    function onToggle(e: Event): void {
      const detail = (e as CustomEvent<{ x: number; y: number }>).detail
      useAtvControlsBus.getState().toggle(detail)
    }
    window.addEventListener('ion:atv-controls-toggle', onToggle)
    return () => window.removeEventListener('ion:atv-controls-toggle', onToggle)
  }, [])

  const paletteActions = useRef<PaletteEntry[]>([
    { id: 'act:overlay', label: 'Open Overlay', keywords: 'glass main window', section: 'Actions', run: () => window.ion.atvShowOverlay() },
    { id: 'act:dock', label: 'Toggle Conversation Dock', keywords: 'chat transcript drawer', section: 'Actions', run: () => setDockOpen((v) => !v) },
  ])

  // Floating file editor — same gating the overlay uses: visible when the
  // active tab's editor dir has open files (per-window editor state).
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const editorState = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return null
    const dir = editorDirForTab(tab)
    const dirState = s.fileEditorStates.get(dir)
    return dirState && dirState.files.length > 0 && s.fileEditorOpenDirs.has(dir) ? { dir } : null
  })

  return (
    <PopoverLayerProvider>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: colors.containerBg }}>
        <div style={{ flexShrink: 0 }}>
          <TabStrip />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {/* overflow: hidden — backstop: the canvas pane must never paint
              outside its row (over the status bar below), whatever the
              canvas backing size does. See the sizing note in AtvApp. */}
          <div style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden' }}>
            <AtvApp
              dockOpen={dockOpen}
              onToggleDock={() =>
                setDockOpen((v) => {
                  persistLayout({ dockOpen: !v })
                  return !v
                })
              }
              onAgentClick={(_tabId, agentName) => {
                // Open the dock and route into the SAME rich dispatch
                // preview the overlay uses: the dock's ConversationView
                // mounts AgentPanel, whose useAgentDetailOpener listens for
                // this window-local event (manager = just the conversation).
                setDockOpen(true)
                if (agentName !== '__manager__') {
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('ion:open-agent-detail', { detail: { agentName } }))
                  }, 80)
                }
              }}
            />
            {!ready && (
              <div
                style={{
                  position: 'absolute',
                  top: 8,
                  left: 12,
                  color: colors.textTertiary,
                  fontSize: 11,
                  fontFamily: 'system-ui, sans-serif',
                }}
              >
                syncing tabs…
              </div>
            )}
          </div>
          <AtvSideDock
            open={dockOpen}
            width={dockLayout.dockWidth}
            tab={dockLayout.dockTab}
            onLayoutChange={(patch) => {
              setDockLayout((prev) => ({ ...prev, ...patch }))
              persistLayout(patch)
            }}
            onClose={() => {
              setDockOpen(false)
              persistLayout({ dockOpen: false })
            }}
          />
        </div>
        {/* The overlay's real StatusBar — identical surface, same store
            (parity mechanism 1). */}
        <div style={{ flexShrink: 0, borderTop: `1px solid ${colors.containerBorder}` }}>
          <StatusBar />
        </div>
        {editorState && activeTabId && <FileEditor dir={editorState.dir} tabId={activeTabId} />}
        <AtvControlsPopover />
        <CommandPalette actions={paletteActions.current} />
      </div>
    </PopoverLayerProvider>
  )
}
