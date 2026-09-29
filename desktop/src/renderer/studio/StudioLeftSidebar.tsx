/**
 * StudioLeftSidebar — the Studio shell's docked left sidebar.
 *
 * Hosts one of the dock views (inbox | explorer | search | git) behind a
 * compact view switcher. The components are the SAME
 * ones the overlay mounts (parity mechanism 1) — FileExplorer and GitPanel
 * read the mirror store and per-window git subscriptions directly.
 *
 * Fixed width at GIT_PANEL_WIDTH (440px) — every view shares the same
 * width with no horizontal resize.
 */
import React from "react";
import { useSessionStore } from "@ion/server/store/sessionStore";
import { FileExplorer } from "../components/FileExplorer";
import { GitPanel } from "../components/GitPanel";
import { InboxSidebar } from "./inbox/InboxSidebar";
import { WorkspaceSearchPanel } from "./search/WorkspaceSearchPanel";
import { useColors } from "../theme";
import { GIT_PANEL_WIDTH } from "../components/panelGeometry";
import { WorkspaceStatusIndicator } from "../components/WorkspaceStatusIndicator";
import { OpenSettingsButton } from "../components/OpenSettingsButton";
import { ShortcutHint } from "../shortcuts/ShortcutHint";
import { useShortcutHint } from "../shortcuts/useShortcutHints";
import type {
  StudioLayout,
  StudioSidebarView,
} from "@ion/shared/types-studio";
import { useActiveGitRepo } from "../hooks/useActiveGitRepo";

export interface StudioLeftSidebarProps {
  layout: StudioLayout;
  width?: number;
  onSelectView: (view: StudioSidebarView) => void;
  onClose: () => void;
  onFocusCapture?: () => void;
  onMouseDownCapture?: () => void;
}

const VIEWS: ReadonlyArray<{
  id: StudioSidebarView;
  label: string;
  /** The command that selects this view. Its live chord labels the tab. */
  command: string;
}> = [
  { id: "inbox", label: "Inbox", command: "panel.inbox" },
  { id: "explorer", label: "Explorer", command: "panel.explorer" },
  { id: "search", label: "Search", command: "panel.search" },
  { id: "git", label: "Git", command: "panel.git" },
];

export function StudioLeftSidebar(
  props: StudioLeftSidebarProps,
): React.JSX.Element {
  const colors = useColors();
  const view = props.layout.leftSidebarView;
  const activeTabId = useSessionStore((s) => s.activeTabId);
  // Git is offered only where there is a repository to show. Against a plain
  // directory the panel has nothing to display and reaching it starts a
  // 5s `git worktree list` poll that fails every time.
  const { isRepo } = useActiveGitRepo();
  const views = React.useMemo(
    () => (isRepo ? VIEWS : VIEWS.filter((v) => v.id !== "git")),
    [isRepo],
  );

  // A conversation switched from a repo to a plain directory leaves the dock
  // pointed at a view that is no longer offered. Falling back to Explorer
  // keeps the dock on something real instead of rendering an empty Git panel.
  //
  // Depends on `props.onSelectView` specifically, not the whole `props`
  // object: StudioShell passes onFocusCapture/onMouseDownCapture/onClose as
  // fresh inline closures every render, so `props` never has a stable
  // identity and this effect would re-fire (and call onSelectView again) on
  // every unrelated parent render, which is what produced React error #185.
  const { onSelectView } = props;
  React.useEffect(() => {
    if (!isRepo && view === "git") onSelectView("explorer");
  }, [isRepo, view, onSelectView]);

  return (
    <div
      onFocusCapture={props.onFocusCapture}
      onMouseDownCapture={props.onMouseDownCapture}
      style={{
        width: props.width ?? GIT_PANEL_WIDTH,
        maxWidth: '100%',
        minWidth: 0,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: `1px solid ${colors.containerBorder}`,
        background: colors.containerBg,
        position: "relative",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "4px 10px",
          borderBottom: `1px solid ${colors.containerBorder}`,
          fontFamily: "system-ui, sans-serif",
          fontSize: 12,
          gap: 8,
          flexShrink: 0,
        }}
      >
        <WorkspaceStatusIndicator />
        {views.map((v) => (
          <DockViewTab
            key={v.id}
            label={v.label}
            command={v.command}
            active={view === v.id}
            onSelect={() => props.onSelectView(v.id)}
          />
        ))}
        <div style={{ marginLeft: "auto" }}>
          <OpenSettingsButton />
        </div>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {view === "inbox" ? (
          <InboxSidebar />
        ) : !activeTabId ? (
          <div
            style={{ padding: 16, color: colors.textTertiary, fontSize: 12 }}
          >
            No active conversation.
          </div>
        ) : view === "search" ? (
          <WorkspaceSearchPanel />
        ) : view === "explorer" || !isRepo ? (
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <FileExplorer docked onClose={props.onClose} />
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <GitPanel docked onClose={props.onClose} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One dock view tab. The chord suffix is always visible here (no modifier
 * gate): these tabs are the primary navigation and their bindings are
 * worth teaching on sight. An unbound command simply renders no suffix.
 */
function DockViewTab({
  label,
  command,
  active,
  onSelect,
}: {
  label: string;
  command: string;
  active: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const colors = useColors();
  const chord = useShortcutHint("studio", command);
  return (
    <button
      onClick={onSelect}
      aria-keyshortcuts={chord ?? undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        padding: "2px 4px",
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        color: active ? colors.textPrimary : colors.textTertiary,
        borderBottom: active
          ? `2px solid ${colors.accent}`
          : "2px solid transparent",
      }}
    >
      {label}
      {chord && <ShortcutHint chord={chord} dimmed={!active} />}
    </button>
  );
}
