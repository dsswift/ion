/**
 * StudioShell — layout root of the Ion Studio window.
 *
 * Boots the session store in MIRROR mode (forwarded actions, owner tab
 * sync, full event stream — see shared/studio-mirror-actions.ts and
 * ADR-021), then composes the IDE-style shell:
 *
 *   column: StudioTitleBar
 *           row[ StudioLeftSidebar? | StudioCenter(flex:1) | StudioSurface? ]
 *           StatusBar
 *
 * The conversation is the center surface; the visualizer canvas lives in
 * the right surface pane (v1: hardcoded tab — the surface-store workstream
 * makes it a real tab). Left-sidebar and terminal geometry persist as
 * `studioLayout` via useStudioLayout (one debounced write per gesture); the
 * surface pane's width persists per-conversation on the surface store
 * instead (`SurfaceConversationPersisted.width`), since two conversations
 * legitimately want different surface widths — `studioLayout.surfaceWidth`
 * remains only as the default for a conversation that has never been resized.
 *
 * Shared surfaces are the SAME component
 * reading the same store — never a bespoke Studio widget.
 */
import React, { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@ion/server/store/sessionStore";
import { useEngineEvents } from "../hooks/useEngineEvents";
import { useHealthReconciliation } from "../hooks/useHealthReconciliation";
import { useEnginePermissionDenialBackfill } from "../hooks/useEnginePermissionDenialBackfill";
import { useWorktreeRendererListeners } from "../hooks/useWorktreeRendererListeners";
import { PopoverLayerProvider } from "../components/PopoverLayer";
import { SavePathPromptHost } from "../host/save-path-prompt";
import { useColors } from "../theme";
import { rDebug } from "../rendererLogger";
import { contentRouter } from "../lib/file-open-router";
import { openDispatchPreview } from "./open-dispatch-preview";
import { toggleActivePermissionMode, handleNewConversationShortcut, adjustZoom, resetZoom } from "../shortcuts/shared-command-handlers";
import { bootMirror } from "./state/boot-mirror";
import { registerStudioFileRouter } from "./surface/studio-file-router";
import { StudioLeftSidebar } from "./StudioLeftSidebar";
import { StudioTitleBar } from "./StudioTitleBar";
import { StudioCenter } from "./StudioCenter";
import { StudioSurface } from "./StudioSurface";
import { StudioBrowserHost } from "./surface/SurfacePanel";
import { ScratchCloseDialog } from "./surface/ScratchCloseDialog";
import { useStudioLayout } from "./layout/useStudioLayout";
import { revealDockView } from "./layout/dock-view-reveal";
import type { StudioSidebarView } from "@ion/shared/types-studio";
import { useStudioBootstrap } from "./useStudioBootstrap";
import { addActiveConversationShell, toggleActiveConversationTerminal } from "./studio-conversation-terminal-commands";
import { useCommandShortcuts } from "./keymap/useStudioKeymap";
import { useSurfaceStore } from "./surface/surface-store";
import { useSurfacePersistOnUnload } from "./surface/surface-persist";
import { useStudioBrowserCommands } from "./surface/studio-browser-commands";
import { useStudioGraphCommands } from "./graph/studio-graph-commands";
import { canvasTabHandlers } from "./surface/canvas-tab-handlers";
import { dispatchPaneFind, paneFindTarget, type PaneFindAction } from "./find/pane-find";
import { useWorkspaceSearchStore } from "./search/workspace-search-store";
import { initSurfaceConversationSync } from "./surface/surface-conversation-sync";
import { initQuestionsSurfaceSync } from "./surface/questions-surface-sync";
import { hydrateQuestions } from "../stores/questions-store";
import { ControlsPopover } from "./visualizer/ControlsPopover";
import { useStudioControlsBus } from "./state/controls-bus";
import { GIT_PANEL_WIDTH } from "../components/panelGeometry";
import { useWindowWidth } from '../hooks/useWindowGeometry'
import { useGraphStore } from "./graph/graph-store";
import { resolveStudioResponsiveLayout } from '../responsive-layout'
import { useResourceBootstrap } from "../hooks/useResourceBootstrap";
import { CommandPalette } from "../components/CommandPalette";
import { DeepLinkConfirmDialog } from "../components/DeepLinkConfirmDialog";
import { ProviderSubscriptionPrompt } from "./ProviderSubscriptionPrompt";
import { CloseTabConfirmDialog } from "../components/CloseTabConfirmDialog";
import { RemoteDirectoryPicker } from "../components/RemoteDirectoryPicker";
import { SettingsDialog } from "../components/SettingsDialog";
import { NewConversationPickerHost } from "../components/NewConversationPickerHost";
import { TransferDialogHost } from "./transfer/TransferDialogHost";
import { useTrayMenuListeners } from "../hooks/useTrayMenuListeners";
import { UpdateDialog } from "../components/UpdateDialog";
import { BuildNoticeDialog } from "./BuildNoticeDialog";
import { useUpdateEvents } from "../hooks/useUpdateEvents";
import type { PaletteEntry } from "../components/command-palette-rank";
import { host } from '../host/host-instance'
import { COMPOSER_ATTACH_EVENT, COMPOSER_QUICK_TOOLS_EVENT, COMPOSER_SCREENSHOT_EVENT } from '../components/composer/composer-events'

/** Step the active conversation ±1 through the tabs array (wraps). */
function stepConversation(delta: number): void {
  const s = useSessionStore.getState();
  if (s.tabs.length === 0) return;
  const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
  const next = s.tabs[(idx + delta + s.tabs.length) % s.tabs.length];
  if (next) s.selectTab(next.id);
}

export function StudioShell(): React.JSX.Element {
  useUpdateEvents()
  bootMirror();
  const colors = useColors();
  // useEngineEvents is window-agnostic by construction: it registers the
  // full listener set, but only the channels main forwards to this window
  // (normalized events, tab status, errors, settings) ever fire here.
  useEngineEvents();
  useTrayMenuListeners();
  useResourceBootstrap();
  // Orphaned when App.tsx (their only prior mount site) was deleted in the
  // spec 17 Overlay removal and never re-added here. Every host.shell call
  // they make is bridged on every host, so mounting is safe everywhere.
  useHealthReconciliation();
  useEnginePermissionDenialBackfill();
  useWorktreeRendererListeners();
  useEffect(() => initSurfaceConversationSync(), []);
  // Guided Questions: hydrate the window-local cache, then keep the transient
  // questions Canvas tab aligned with open workflows.
  useEffect(() => hydrateQuestions(), []);
  useEffect(() => initQuestionsSurfaceSync(), []);

  // Graph View "+" menu availability: resolve config.corpusRoots.length > 0
  // for the active conversation's project whenever it changes. This is a
  // config-only probe (checkAvailability), not a corpus subscribe — the
  // menu must reflect availability before the surface is ever opened.
  // '~' is a real path (the home directory) and must be expanded before
  // probing — checkAvailability skips bare '~' on the assumption it is a
  // placeholder, so we resolve it here.
  const activeWorkingDirectory = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.workingDirectory ?? null,
  );
  const homePath = useSessionStore((s) => s.staticInfo?.homePath ?? null);
  useEffect(() => {
    if (!activeWorkingDirectory) return;
    const resolved = activeWorkingDirectory === '~' ? (homePath ?? null) : activeWorkingDirectory;
    if (!resolved) return;
    void useGraphStore.getState().checkAvailability(resolved);
  }, [activeWorkingDirectory, homePath]);

  const { layout, hydrated, patch, onSelectLeftSidebarView } = useStudioLayout();
  useEffect(() => {
    // A paired device's request to open a terminal's web application as a
    // Studio Browser Surface tab. Only a client that can host that surface
    // takes it (see StudioHost.ts's 'webApplicationOpen' doc).
    if (!host.capabilities().includes('webApplicationOpen')) return
    return host.shell.onStudioOpenWebApplication((payload) => {
      if (!payload || typeof payload !== 'object') return
      const { tabId, url } = payload as { tabId?: unknown; url?: unknown }
      if (typeof tabId !== 'string' || typeof url !== 'string') return
      const router = contentRouter()
      if (!router?.openWebApplication) {
        rDebug('studio', 'web application request ignored: router unavailable', { tab_id: tabId, url })
        return
      }
      rDebug('studio', 'web application request opened', { tab_id: tabId, url })
      router.openWebApplication(tabId, url)
    })
  }, [])
  const surfaceVisible = useSurfaceStore((s) => s.visible);
  const surfaceMaximized = useSurfaceStore((s) => s.maximized && s.visible);
  // Per-conversation width, or null when this conversation has never been
  // resized — falls back to the global default below.
  const conversationSurfaceWidth = useSurfaceStore((s) => s.surfaceWidth);
  const startupReady = useStudioBootstrap(hydrated);
  const closeIntent = useSessionStore((s) => s.closeIntent);
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  const settingsInitialTab = useSessionStore((s) => s.settingsInitialTab);
  const terminalVisible = useSessionStore((s) =>
    s.terminalOpenTabIds.has(s.activeTabId),
  );
  // Main drives browser tab creation, closing, reveal, and emulation through a
  // correlated command channel, answered exactly once per command.
  useStudioBrowserCommands();
  useStudioGraphCommands();

  // Surface state is written on a debounce, which a quit can outrun.
  useSurfacePersistOnUnload();

  const windowWidth = useWindowWidth();

  // Live pane sizes during a drag (React state only; committed to the
  // layout — and thereby disk — once per gesture).
  const [liveSurfaceWidth, setLiveSurfaceWidth] = useState<number | null>(null);
  const [liveTerminalHeight, setLiveTerminalHeight] = useState<number | null>(
    null,
  );
  const [lastFocusedColumn, setLastFocusedColumn] = useState<
    "conversation" | "surface"
  >("conversation");
  const [paletteOpen, setPaletteOpen] = useState(false);

  const requestedLeftVisible = layout.leftSidebarVisible;
  const responsive = resolveStudioResponsiveLayout({
    width: windowWidth,
    leftRequested: requestedLeftVisible,
    surfaceRequested: surfaceVisible,
    preferredLeftWidth: GIT_PANEL_WIDTH,
    preferredSurfaceWidth: liveSurfaceWidth ?? conversationSurfaceWidth ?? layout.surfaceWidth,
  });
  // A maximised surface is the whole shell: the sidebar and the conversation
  // step aside until it is restored. That is the ONLY case that hides a pane.
  // Shrinking the window never does — `resolveStudioResponsiveLayout` answers
  // with a width for every requested pane at any viewport size (see its doc),
  // matching the desktop, which resizes panes on resize and never drops one.
  const showLeft = !surfaceMaximized && requestedLeftVisible;
  const showCenter = !surfaceMaximized;
  const showSurface = surfaceVisible;

  // The owner's active tab is authoritative; mirror-store highlight follows
  // the same push the canvas retargets on.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // This window owns its own selection via the forwarded selectTab action;
    // there is no other window's active-tab push to follow.
    // Consider the shell ready once tabs hydrate (initTabsSyncFromWire sets
    // tabsReady).
    const unsub = useSessionStore.subscribe((s) => {
      if (s.tabsReady) setReady(true);
    });
    if (useSessionStore.getState().tabsReady) setReady(true);
    return () => {
      unsub();
    };
  }, []);

  // Studio owns command handlers while shared shortcut dispatch owns event
  // capture. Commands read mirror-safe store actions only.
  useCommandShortcuts({
    view: "studio",
    phase: "capture",
    handlers: {
      "studio.layout.sidebar": () => {
        patchRef.current({ leftSidebarVisible: !layoutRef.current.leftSidebarVisible });
      },
      "terminal.toggle": toggleActiveConversationTerminal,
      // Cmd+4 toggles the canvas/surface pane without choosing content. The
      // current surface tab remains active; an empty surface stays empty.
      "panel.statusDrawer": () => {
        useSurfaceStore.getState().toggleVisible();
      },
      "studio.layout.surface": () => {
        useSurfaceStore.getState().toggleVisible();
      },
      "studio.layout.surfaceMaximize": () => useSurfaceStore.getState().toggleMaximized(),
      // Every canvas tab's toggle, one rule, from the surface module that owns
      // the tab↔command map the tab pills also read.
      ...canvasTabHandlers(),
      "permission.togglePlanAuto": toggleActivePermissionMode,
      // The composer owns these actions; the keymap only rings the bell.
      "composer.attach": () => window.dispatchEvent(new CustomEvent(COMPOSER_ATTACH_EVENT)),
      "composer.screenshot": () => window.dispatchEvent(new CustomEvent(COMPOSER_SCREENSHOT_EVENT)),
      "composer.quickTools": () => window.dispatchEvent(new CustomEvent(COMPOSER_QUICK_TOOLS_EVENT)),
      "settings.open": () => {
        const state = useSessionStore.getState();
        if (state.settingsOpen) state.closeSettings();
        else state.openSettings();
      },
      "conversation.find": () => routeFind("open"),
      "conversation.findNext": () => routeFind("next"),
      "conversation.findPrev": () => routeFind("prev"),
      "zoom.in": () => adjustZoom(1),
      "zoom.inShifted": () => adjustZoom(1),
      "zoom.out": () => adjustZoom(-1),
      "zoom.reset": () => resetZoom(),
      "layout.tall": () => {
        const state = useSessionStore.getState();
        const id = state.activeTabId;
        if (state.terminalTallTabId === id) state.toggleTerminalTall(id);
        else if (state.tallViewTabId === id) state.toggleTallView(id);
        else if (document.activeElement?.closest(".xterm") && state.terminalOpenTabIds.has(id)) state.toggleTerminalTall(id);
        else state.toggleTallView(id);
      },
      "app.commandPalette": () => setPaletteOpen((open) => !open),
      "tab.recentDirs": () => window.dispatchEvent(new CustomEvent("ion:open-recent-dirs")),
      "tab.new": () => {
        handleNewConversationShortcut("", "Cmd+T");
      },
      "tab.scratch": () => {
        useSurfaceStore.getState().createScratch();
      },
      "tab.newPicker": () => {
        handleNewConversationShortcut("", "Cmd+Opt+T", undefined, true);
      },
      // Spec 16 row: the Overlay-only `tab.newHere` shortcut, landed in
      // Studio. Opens in the active tab's directory (its environment is
      // always local today — remote tabs have no store presence yet, see
      // spec 13's supervisor note).
      "tab.newHere": () => {
        const state = useSessionStore.getState();
        const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
        handleNewConversationShortcut(tab?.workingDirectory || "", "Cmd+Shift+T");
      },
      "terminal.addShell": addActiveConversationShell,
      "tab.close": () => {
        if (lastFocusedColumn === "surface") {
          const s = useSurfaceStore.getState();
          if (s.activeTabId) s.closeTab(s.activeTabId);
          return;
        }
        const tabId = useSessionStore.getState().activeTabId;
        if (tabId) void useSessionStore.getState().requestCloseTab(tabId);
      },
      "tab.prev": () => stepConversation(-1),
      "tab.next": () => stepConversation(1),
      // Mod+1/2/3: reveal the left dock ON a view. Never closes it — only the
      // sidebar toggle does that.
      "panel.inbox": () => selectDockView("inbox"),
      "panel.explorer": () => selectDockView("explorer"),
      "panel.search": () => {
        selectDockView("search");
        useWorkspaceSearchStore.getState().requestFocus();
      },
      "panel.git": () => selectDockView("git"),
      "studio.tab.slot1": () => selectConversationSlot(0),
      "studio.tab.slot2": () => selectConversationSlot(1),
      "studio.tab.slot3": () => selectConversationSlot(2),
      "studio.tab.slot4": () => selectConversationSlot(3),
      "studio.tab.slot5": () => selectConversationSlot(4),
      "studio.tab.slot6": () => selectConversationSlot(5),
      "studio.tab.slot7": () => selectConversationSlot(6),
      "studio.tab.slot8": () => selectConversationSlot(7),
      "studio.tab.slot9": () => selectConversationSlot(8),
    },
  });

  /** Find acts on the pane that holds focus. */
  function routeFind(action: PaneFindAction): void {
    const target = paneFindTarget(lastFocusedColumn, showSurface);
    rDebug("studio.find", "find routed to focused pane", { action, target, last_focused: lastFocusedColumn });
    dispatchPaneFind(target, action);
  }

  function selectConversationSlot(index: number): void {
    const tab = useSessionStore.getState().tabs[index];
    if (tab) useSessionStore.getState().selectTab(tab.id);
  }

  /**
   * Reveal one dock view. Deliberately NOT a toggle: a chord that names a
   * destination is idempotent, so pressing it twice leaves that view on screen
   * rather than pulling the sidebar out from under the operator. Closing the
   * sidebar is the sole job of the sidebar toggle (studio.layout.sidebar),
   * which keeps one state chord for one piece of state.
   *
   * This also matches the sidebar header, where clicking the current view's
   * tab selects it and never closes the panel — the keyboard and the mouse now
   * agree on what the chord means.
   */
  function selectDockView(view: StudioSidebarView): void {
    const outcome = revealDockView(layoutRef.current, view);
    patchRef.current(outcome.patch);
    rDebug("studio.layout", "dock view selected by shortcut", {
      view,
      revealed_sidebar: outcome.revealedSidebar,
      already_active: outcome.alreadyActive,
    });
  }

  // Visualizer settings open from its own toolbar; controls bus owns state.
  useEffect(() => {
    function onToggle(e: Event): void {
      const detail = (e as CustomEvent<{ x: number; y: number }>).detail;
      useStudioControlsBus.getState().toggle(detail);
    }
    window.addEventListener("ion:studio-controls-toggle", onToggle);
    return () =>
      window.removeEventListener("ion:studio-controls-toggle", onToggle);
  }, []);

  const paletteActions = useRef<PaletteEntry[]>([
    {
      id: "act:sidebar",
      label: "Toggle Left Sidebar",
      keywords: "explorer git files dock",
      section: "Actions",
      run: () =>
        patchRef.current({
          leftSidebarVisible: !layoutRef.current.leftSidebarVisible,
        }),
    },
    {
      id: "act:surface",
      label: "Toggle Surface Panel",
      keywords: "visualizer diff plan right",
      section: "Actions",
      run: () =>
        useSurfaceStore.getState().toggleVisible(),
    },
    {
      id: "act:search",
      label: "Search in Files",
      keywords: "find grep text workspace",
      section: "Actions",
      run: () => {
        patchRef.current(revealDockView(layoutRef.current, "search").patch);
        useWorkspaceSearchStore.getState().requestFocus();
      },
    },
    {
      id: "act:terminal",
      label: "Toggle Terminal",
      keywords: "shell pty bottom",
      section: "Actions",
      run: toggleActiveConversationTerminal,
    },
  ]);
  // Palette entries are created once; refs keep them reading fresh state.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const patchRef = useRef(patch);
  patchRef.current = patch;
  registerStudioFileRouter(() => {
    if (!useSurfaceStore.getState().visible)
      useSurfaceStore.getState().setVisible(true);
  });

  const onAgentClick = (_tabId: string, agentName: string): void => openDispatchPreview(agentName);

  // Render nothing until the persisted layout is read: flashing default
  // geometry and then snapping to the restored one reads as a glitch.
  if (!hydrated || !startupReady) {
    return <PopoverLayerProvider><div style={{ height: "100%", background: colors.containerBg }} /></PopoverLayerProvider>;
  }

  return (
    <PopoverLayerProvider>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          background: colors.containerBg,
        }}
      >
        <StudioTitleBar
          panes={{
            leftSidebarVisible: showLeft,
            leftSidebarWidth: responsive.leftWidth || GIT_PANEL_WIDTH,
            terminalVisible,
            surfaceVisible,
            onToggleSidebar: () => {
              patch({ leftSidebarVisible: !layout.leftSidebarVisible });
            },
            onToggleTerminal: () => toggleActiveConversationTerminal(),
            onToggleSurface: () => {
              useSurfaceStore.getState().toggleVisible();
            },
          }}
        />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            display: "flex",
            position: "relative",
          }}
        >
          {showLeft && (
            <StudioLeftSidebar
              layout={layout}
              width={responsive.leftWidth}
              onSelectView={onSelectLeftSidebarView}
              onFocusCapture={() => { setLastFocusedColumn("conversation") }}
              onMouseDownCapture={() => { setLastFocusedColumn("conversation") }}
              onClose={() => patch({ leftSidebarVisible: false })}
            />
          )}
          {showCenter && <StudioCenter
            onFocusCapture={() => { setLastFocusedColumn("conversation") }}
            onMouseDownCapture={() => { setLastFocusedColumn("conversation") }}
            layout={layout}
            liveTerminalHeight={liveTerminalHeight ?? layout.terminalHeight}
            onLiveTerminalResize={setLiveTerminalHeight}
            onCommitTerminalHeight={(h) => {
              setLiveTerminalHeight(null);
              patch({ terminalHeight: h });
            }}
          />}
          {/* Browser guests live outside the gated column: a closed Surface
              must still let a background agent drive its own tab. */}
          <StudioBrowserHost />
          {showSurface && (
            <StudioSurface
              onFocusCapture={() => { setLastFocusedColumn("surface") }}
              onMouseDownCapture={() => { setLastFocusedColumn("surface") }}
              liveWidth={surfaceMaximized ? windowWidth : responsive.surfaceWidth}
              maximized={surfaceMaximized}
              onToggleMaximized={() => useSurfaceStore.getState().toggleMaximized()}
              onLiveResize={setLiveSurfaceWidth}
              onCommitWidth={(w) => {
                setLiveSurfaceWidth(null);
                useSurfaceStore.getState().setWidth(w);
              }}
              onClose={() => useSurfaceStore.getState().setVisible(false)}
              onAgentClick={onAgentClick}
            />
          )}
          {!ready && (
            <div
              style={{
                position: "absolute",
                top: 8,
                left: 12,
                color: colors.textTertiary,
                fontSize: 11,
                fontFamily: "system-ui, sans-serif",
              }}
            >
              syncing tabs…
            </div>
          )}
        </div>
        <NewConversationPickerHost />
        <TransferDialogHost />
        {settingsOpen && (
          <SettingsDialog
            initialTab={settingsInitialTab}
            onClose={() => useSessionStore.getState().closeSettings()}
          />
        )}
        {closeIntent && (
          <CloseTabConfirmDialog
            title={closeIntent.title}
            directory={closeIntent.directory}
            warning={closeIntent.warning}
            onConfirm={() => useSessionStore.getState().confirmCloseTab()}
            onCancel={() => useSessionStore.getState().cancelCloseTab()}
          />
        )}
        <ControlsPopover />
        <CommandPalette
          actions={paletteActions.current}
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
        />
        <ScratchCloseDialog />
        <DeepLinkConfirmDialog />
        <ProviderSubscriptionPrompt />
        <RemoteDirectoryPicker />
        <SavePathPromptHost />
        <UpdateDialog />
        <BuildNoticeDialog />
      </div>
    </PopoverLayerProvider>
  );
}
