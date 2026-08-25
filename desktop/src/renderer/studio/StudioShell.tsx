/**
 * StudioShell — layout root of the Ion Studio window.
 *
 * Boots the session store in MIRROR mode (forwarded actions, owner tab
 * sync, full event stream — see shared/studio-mirror-actions.ts and
 * ADR-021), then composes the IDE-style shell:
 *
 *   column: StudioTitleBar
 *           TabStrip
 *           row[ StudioLeftSidebar? | StudioCenter(flex:1) | StudioSurface? ]
 *           StatusBar
 *
 * The conversation is the center surface; the visualizer canvas lives in
 * the right surface pane (v1: hardcoded tab — the surface-store workstream
 * makes it a real tab). Pane geometry persists as `studioLayout` via
 * useStudioLayout (one debounced write per gesture).
 *
 * Overlay↔Studio parity mechanism 1: shared surfaces are the SAME component
 * reading the same store — never a bespoke Studio widget.
 */
import React, { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useEngineEvents } from "../hooks/useEngineEvents";
import { PopoverLayerProvider } from "../components/PopoverLayer";
import { TabStrip } from "../components/TabStrip";
import { useColors } from "../theme";
import { usePreferencesStore } from "../preferences";
import { rDebug, rInfo } from "../rendererLogger";
import { contentRouter } from "../lib/file-open-router";
import { IPC } from "../../shared/types";
import { getDispatches, meta, mostRecentDispatch } from "../components/agent-panel-helpers";
import { toggleActivePermissionMode } from "../shortcuts/shared-command-handlers";
import { handleNewConversationShortcut, isEditorZoomTarget, isPreviewZoomTarget } from "../hooks/useKeyboardShortcuts"
import { SETTINGS_DEFAULTS } from "../preferences-types";
import {
  applyMirrorOverrides,
  initTabsSync,
  initWorktreeSync,
  initPermissionResolutionSync,
  initUserMessageEcho,
  initHistoryReplace,
  consumeStudioActiveTab,
} from "./state/secondary-store";
import { initDispatchSplitConversationGuard } from "./dispatch-split-state";
import { registerStudioFileRouter } from "./surface/studio-file-router";
import { StudioLeftSidebar } from "./StudioLeftSidebar";
import { StudioTitleBar } from "./StudioTitleBar";
import { StudioCenter } from "./StudioCenter";
import { StudioSurface } from "./StudioSurface";
import { useStudioLayout } from "./layout/useStudioLayout";
import { revealDockView } from "./layout/dock-view-reveal";
import type { StudioSidebarView } from "../../shared/types-studio";
import { useStudioBootstrap } from "./useStudioBootstrap";
import { useCommandShortcuts } from "./keymap/useStudioKeymap";
import { useSurfaceStore } from "./surface/surface-store";
import { canvasTabHandlers } from "./surface/canvas-tab-handlers";
import { initSurfaceConversationSync } from "./surface/surface-conversation-sync";
import { initQuestionsSurfaceSync } from "./surface/questions-surface-sync";
import { hydrateQuestions } from "../stores/questions-store";
import { ControlsPopover } from "./visualizer/ControlsPopover";
import { useStudioControlsBus } from "./state/controls-bus";
import { GIT_PANEL_WIDTH } from "../components/panelGeometry";
import { useWindowWidth } from '../hooks/useWindowGeometry'
import { resolveStudioResponsiveLayout } from '../responsive-layout'
import { useResourceBootstrap } from "../hooks/useResourceBootstrap";
import { CommandPalette } from "../components/CommandPalette";
import { DeepLinkConfirmDialog } from "../components/DeepLinkConfirmDialog";
import { CloseTabConfirmDialog } from "../components/CloseTabConfirmDialog";
import { SettingsDialog } from "../components/SettingsDialog";
import { UpdateDialog } from "../components/UpdateDialog";
import { useUpdateEvents } from "../hooks/useUpdateEvents";
import type { PaletteEntry } from "../components/command-palette-rank";

/** One-time mirror boot, before the first render reads the store. */
let booted = false;
function bootMirror(): void {
  if (booted) return;
  booted = true;
  const swapped = applyMirrorOverrides();
  initDispatchSplitConversationGuard();
  initTabsSync();
  initWorktreeSync();
  initPermissionResolutionSync();
  initUserMessageEcho();
  initHistoryReplace();
  // File-open routing is registered after layout refs exist in StudioShell.
  rInfo("studio", "mirror booted", { forwarded_actions: swapped.length });
}

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
  useResourceBootstrap();
  useEffect(() => initSurfaceConversationSync(), []);
  // Guided Questions: hydrate the window-local cache, then keep the transient
  // questions Canvas tab aligned with open workflows.
  useEffect(() => hydrateQuestions(), []);
  useEffect(() => initQuestionsSurfaceSync(), []);

  const { layout, hydrated, patch } = useStudioLayout();
  useEffect(() => {
    const openWebApplication = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      if (!payload || typeof payload !== 'object') return
      const { tabId, url } = payload as { tabId?: unknown; url?: unknown }
      if (typeof tabId !== 'string' || typeof url !== 'string') return
      const router = contentRouter()
      if (!router?.openWebApplication) {
        rDebug('studio', 'web application request ignored: router unavailable', { tab_id: tabId, url })
        return
      }
      router.openWebApplication(tabId, url)
    }
    window.ion.on(IPC.STUDIO_OPEN_WEB_APPLICATION, openWebApplication)
    return () => window.ion.off(IPC.STUDIO_OPEN_WEB_APPLICATION, openWebApplication)
  }, [])
  const surfaceVisible = useSurfaceStore((s) => s.visible);
  const startupReady = useStudioBootstrap(hydrated);
  const closeIntent = useSessionStore((s) => s.closeIntent);
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  const settingsInitialTab = useSessionStore((s) => s.settingsInitialTab);
  const terminalVisible = useSessionStore((s) =>
    s.terminalOpenTabIds.has(s.activeTabId),
  );
  // Inbox navigation mode (per-device): TabStrip hidden; the inbox dock is
  // the conversation switcher (forced visible). Overlay unaffected either
  // way. Flipping INTO inbox mode defaults the dock view to the inbox once;
  // the user can still switch to Explorer/Git afterwards (Explorer/Git are
  // also available as surface tabs so the inbox can stay pinned — R8).
  const conversationNav = usePreferencesStore((s) => s.conversationNav);
  const windowWidth = useWindowWidth();
  const prevNavRef = useRef(conversationNav);
  useEffect(() => {
    if (prevNavRef.current !== conversationNav) {
      prevNavRef.current = conversationNav;
      if (conversationNav === "inbox")
        patch({ leftSidebarVisible: true, leftSidebarView: "inbox" });
    }
  }, [conversationNav, patch]);

  // Live pane sizes during a drag (React state only; committed to the
  // layout — and thereby disk — once per gesture).
  const [liveSurfaceWidth, setLiveSurfaceWidth] = useState<number | null>(null);
  const [liveTerminalHeight, setLiveTerminalHeight] = useState<number | null>(
    null,
  );
  const [lastFocusedColumn, setLastFocusedColumn] = useState<
    "conversation" | "surface"
  >("conversation");
  const [narrowPane, setNarrowPane] = useState<"left" | "center" | "surface">("center");
  const [paletteOpen, setPaletteOpen] = useState(false);

  const requestedLeftVisible = layout.leftSidebarVisible || conversationNav === "inbox";
  const responsive = resolveStudioResponsiveLayout({
    width: windowWidth,
    leftRequested: requestedLeftVisible,
    surfaceRequested: surfaceVisible,
    preferredLeftWidth: GIT_PANEL_WIDTH,
    preferredSurfaceWidth: liveSurfaceWidth ?? layout.surfaceWidth,
  });
  const narrowPrimary = requestedLeftVisible && narrowPane === "left"
    ? "left"
    : surfaceVisible && narrowPane === "surface" ? "surface" : "center";
  const showLeft = requestedLeftVisible && (responsive.mode !== "narrow" || narrowPrimary === "left");
  const showCenter = responsive.mode !== "narrow" || narrowPrimary === "center";
  const showSurface = surfaceVisible && (responsive.mode !== "narrow" || narrowPrimary === "surface");

  // The owner's active tab is authoritative; mirror-store highlight follows
  // the same push the canvas retargets on.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const off = window.ion.onStudioActiveTab((tabId) => {
      consumeStudioActiveTab(tabId)
    });
    // Consider the shell ready once tabs hydrate (initTabsSync sets tabsReady).
    const unsub = useSessionStore.subscribe((s) => {
      if (s.tabsReady) setReady(true);
    });
    if (useSessionStore.getState().tabsReady) setReady(true);
    return () => {
      off();
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
        if (responsive.mode === "narrow" && requestedLeftVisible) setNarrowPane("left");
        else patchRef.current({ leftSidebarVisible: !layoutRef.current.leftSidebarVisible });
      },
      "terminal.toggle": toggleActiveTerminal,
      // Cmd+4 toggles the canvas/surface pane without choosing content. The
      // current surface tab remains active; an empty surface stays empty.
      "panel.statusDrawer": () => {
        useSurfaceStore.getState().toggleVisible();
      },
      "studio.layout.surface": () => {
        if (responsive.mode === "narrow" && surfaceVisible) setNarrowPane("surface");
        else useSurfaceStore.getState().toggleVisible();
      },
      // Every canvas tab's toggle, one rule, from the surface module that owns
      // the tab↔command map the tab pills also read.
      ...canvasTabHandlers(),
      "permission.togglePlanAuto": toggleActivePermissionMode,
      "settings.open": () => {
        const state = useSessionStore.getState();
        if (state.settingsOpen) state.closeSettings();
        else state.openSettings();
      },
      "conversation.find": () => window.dispatchEvent(new CustomEvent("ion:open-conversation-search")),
      "conversation.findNext": () => window.dispatchEvent(new CustomEvent("ion:search-next")),
      "conversation.findPrev": () => window.dispatchEvent(new CustomEvent("ion:search-prev")),
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
      "terminal.addShell": () => {
        const state = useSessionStore.getState();
        const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
        if (!tab) return;
        if (!state.terminalOpenTabIds.has(tab.id)) state.toggleTerminal(tab.id);
        const instanceId = state.addTerminalInstance(tab.id, "user", tab.workingDirectory);
        rDebug("studio.terminal", "conversation shell added", {
          tab_id: tab.id,
          instance_id: instanceId,
          cwd: tab.workingDirectory,
        });
      },
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

  function adjustZoom(delta: number): void {
    const preferences = usePreferencesStore.getState()
    if (isPreviewZoomTarget()) {
      preferences.setDataViewFontSize(preferences.dataViewFontSize + delta)
    } else if (isEditorZoomTarget()) {
      preferences.setEditorFontSize(preferences.editorFontSize + delta)
    } else {
      preferences.setDataViewFontSize(preferences.dataViewFontSize + delta)
    }
  }

  function resetZoom(): void {
    const preferences = usePreferencesStore.getState()
    if (isPreviewZoomTarget()) {
      preferences.setDataViewFontSize(SETTINGS_DEFAULTS.dataViewFontSize)
    } else if (isEditorZoomTarget()) {
      preferences.setEditorFontSize(SETTINGS_DEFAULTS.editorFontSize)
    } else {
      preferences.setDataViewFontSize(SETTINGS_DEFAULTS.dataViewFontSize)
    }
  }

  function selectConversationSlot(index: number): void {
    const tab = useSessionStore.getState().tabs[index];
    if (tab) useSessionStore.getState().selectTab(tab.id);
  }

  function toggleActiveTerminal(): void {
    const state = useSessionStore.getState();
    const tabId = state.activeTabId;
    if (!tabId) return;
    const opening = !state.terminalOpenTabIds.has(tabId);
    state.toggleTerminal(tabId);
    rDebug("studio.terminal", "conversation terminal tray toggled", {
      tab_id: tabId,
      open: opening,
    });
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
    setNarrowPane("left");
    rDebug("studio.layout", "dock view selected by shortcut", {
      view,
      revealed_sidebar: outcome.revealedSidebar,
      already_active: outcome.alreadyActive,
    });
  }

  // Drag-drop attach: files dropped anywhere stage on active composer.
  useEffect(() => {
    function onDrop(e: DragEvent): void {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0 || !useSessionStore.getState().activeTabId) return;
      const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
      const attachments = files
        .map((f) => ({ file: f, path: window.ion.getPathForFile?.(f) ?? "" }))
        .filter((x) => x.path)
        .map(({ file, path }) => ({
          id: crypto.randomUUID(),
          type: (IMAGE.test(file.name) ? "image" : "file") as "image" | "file",
          name: file.name,
          path,
        }));
      if (attachments.length === 0) return;
      // Forwarded action: stages on the OWNER's active tab (same tab by the
      // single-focus rule); chips appear via the mirror's tabs-sync.
      useSessionStore.getState().addAttachments(attachments);
    }
    function onDragOver(e: DragEvent): void {
      e.preventDefault();
    }
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragover", onDragOver);
    return () => {
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragover", onDragOver);
    };
  }, []);

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
      id: "act:overlay",
      label: "Open Overlay",
      keywords: "glass main window",
      section: "Actions",
      run: () => window.ion.studioShowOverlay(),
    },
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
      id: "act:terminal",
      label: "Toggle Terminal",
      keywords: "shell pty bottom",
      section: "Actions",
      run: toggleActiveTerminal,
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

  // A dispatch preview is one conversation-local surface tab. Reopening it
  // updates that tab's subject instead of creating another runtime panel.
  const onAgentClick = (_tabId: string, agentName: string): void => {
    if (agentName === "__manager__") return;
    const state = useSessionStore.getState();
    const pane = state.conversationPanes.get(state.activeTabId);
    const instance = pane?.instances.find((item) => item.id === pane.activeInstanceId);
    const agent = instance?.agentStates.find((item) => item.name === agentName);
    if (!agent) {
      rDebug("studio.surface", "dispatch preview agent was not found", {
        agent: agentName,
        tab_id: state.activeTabId,
      });
      return;
    }
    const dispatch = mostRecentDispatch(getDispatches(agent));
    if (!dispatch?.id) {
      rDebug("studio.surface", "dispatch preview agent has no dispatch", {
        agent: agentName,
        tab_id: state.activeTabId,
      });
      return;
    }
    const title = meta(agent, "displayName", agent.name);
    contentRouter()?.openDispatch?.(agent.name, dispatch.id, title);
  };

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
              if (responsive.mode === "narrow" && requestedLeftVisible) setNarrowPane("left");
              else patch({ leftSidebarVisible: !layout.leftSidebarVisible });
            },
            onToggleTerminal: toggleActiveTerminal,
            onToggleSurface: () => {
              if (responsive.mode === "narrow" && surfaceVisible) setNarrowPane("surface");
              else useSurfaceStore.getState().toggleVisible();
            },
          }}
        />
        <div style={{ display: conversationNav === "tabs" ? "block" : "none", flexShrink: 0 }}>
          <TabStrip />
        </div>
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
              onSelectView={(view) => patch({ leftSidebarView: view })}
              onFocusCapture={() => { setLastFocusedColumn("conversation"); setNarrowPane("left") }}
              onMouseDownCapture={() => { setLastFocusedColumn("conversation"); setNarrowPane("left") }}
              onClose={() => patch({ leftSidebarVisible: false })}
            />
          )}
          {showCenter && <StudioCenter
            onFocusCapture={() => { setLastFocusedColumn("conversation"); setNarrowPane("center") }}
            onMouseDownCapture={() => { setLastFocusedColumn("conversation"); setNarrowPane("center") }}
            layout={layout}
            liveTerminalHeight={liveTerminalHeight ?? layout.terminalHeight}
            onLiveTerminalResize={setLiveTerminalHeight}
            onCommitTerminalHeight={(h) => {
              setLiveTerminalHeight(null);
              patch({ terminalHeight: h });
            }}
          />}
          {showSurface && (
            <StudioSurface
              onFocusCapture={() => { setLastFocusedColumn("surface"); setNarrowPane("surface") }}
              onMouseDownCapture={() => { setLastFocusedColumn("surface"); setNarrowPane("surface") }}
              liveWidth={responsive.surfaceWidth}
              onLiveResize={setLiveSurfaceWidth}
              onCommitWidth={(w) => {
                setLiveSurfaceWidth(null);
                patch({ surfaceWidth: w });
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
        <DeepLinkConfirmDialog />
        <UpdateDialog />
      </div>
    </PopoverLayerProvider>
  );
}
