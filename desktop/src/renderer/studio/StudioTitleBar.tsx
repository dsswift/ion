/**
 * StudioTitleBar — themed native-window title bar for Studio.
 *
 * The main process leaves macOS traffic lights and non-macOS window controls
 * native, while this renderer-owned surface provides matching themed chrome.
 * Drag only empty title-bar space. Every actionable child opts out.
 */
import React, { useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import {
  CaretRight,
  FolderSimple,
  SidebarSimple,
  SquareSplitHorizontal,
  Terminal as TerminalIcon,
} from "@phosphor-icons/react";
import { useSessionStore } from "../stores/sessionStore";
import { usePreferencesStore } from "../preferences";
import { orderedProjects } from "../../shared/project-registry";
import { STUDIO_TITLE_BAR_HEIGHT } from "../../shared/studio-chrome";
import { useColors } from "../theme";
import { Tooltip } from "../components/git/Tooltip";
import { ShortcutHint } from "../shortcuts/ShortcutHint";
import { useRevealedShortcuts } from "../shortcuts/useShortcutHints";
import { useStudioWindowChrome } from "./chrome/useStudioWindowChrome";
import { UpdateButton } from "../components/UpdateButton";
import { NotificationsBell } from "../components/NotificationsPanel";
import { DirectoryPicker } from "../components/TabStripDirectoryPicker";
import { zoomRect } from "../viewport-zoom";
import { rDebug, rError } from "../rendererLogger";

const STUDIO_BRAND = "Ion Studio";

/**
 * The command each pane toggle performs. The hint beside a toggle is the live
 * binding of the command the button itself invokes — never a second chord that
 * happens to reach the same pane by a different route.
 */
const SIDEBAR_COMMAND = "studio.layout.sidebar";
const TERMINAL_COMMAND = "terminal.toggle";
const SURFACE_COMMAND = "studio.layout.surface";
const PANE_COMMANDS = [SIDEBAR_COMMAND, TERMINAL_COMMAND, SURFACE_COMMAND] as const;

export interface StudioTitleBarPanes {
  leftSidebarVisible: boolean;
  leftSidebarWidth: number;
  terminalVisible: boolean;
  surfaceVisible: boolean;
  onToggleSidebar: (event?: React.MouseEvent<HTMLButtonElement>) => void;
  onToggleTerminal: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onToggleSurface: (event?: React.MouseEvent<HTMLButtonElement>) => void;
}

export function StudioTitleBar({
  panes,
}: {
  panes: StudioTitleBarPanes;
}): React.JSX.Element {
  const colors = useColors();
  const controls = useStudioWindowChrome(colors);
  const tab = useSessionStore(
    (state) => state.tabs.find((item) => item.id === state.activeTabId) ?? null,
  );
  const registry = usePreferencesStore((state) => state.projects);
  // Held-modifier reveal for the pane toggles. Each entry is present only
  // while its own chord's modifiers are held, so ⌘ reveals the sidebar and
  // canvas toggles while ⌃ reveals the terminal toggle.
  const revealed = useRevealedShortcuts("studio", PANE_COMMANDS);
  const [terminalPickerAnchor, setTerminalPickerAnchor] = useState<{ x: number; y: number; bottom: number } | null>(null);
  const terminalPickerGestureUntil = React.useRef(0);

  const openTerminalPicker = (button: HTMLButtonElement): void => {
    const rect = zoomRect(button.getBoundingClientRect());
    setTerminalPickerAnchor({ x: rect.left, y: rect.top, bottom: rect.bottom });
    rDebug("studio.terminal", "terminal directory picker opened", { source: "title_bar" });
  };

  const handleTerminalMouseDown = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (!event.ctrlKey || !event.altKey) return;
    // macOS converts Control-click into a context click and can strip ctrlKey
    // before React receives the final click. Capture the real gesture here.
    event.preventDefault();
    event.stopPropagation();
    terminalPickerGestureUntil.current = event.timeStamp + 1000;
    openTerminalPicker(event.currentTarget);
  };

  const handleTerminalClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (event.timeStamp <= terminalPickerGestureUntil.current) {
      terminalPickerGestureUntil.current = 0;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.ctrlKey && event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      openTerminalPicker(event.currentTarget);
      return;
    }
    panes.onToggleTerminal(event);
  };

  const handleTerminalContextMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (event.timeStamp > terminalPickerGestureUntil.current && !(event.ctrlKey && event.altKey)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const projectLabel = useMemo(() => {
    const directory = tab?.workingDirectory;
    if (!directory || directory === "~") return null;
    const match = orderedProjects(registry).find((project) => project.dir === directory);
    return match?.displayName ?? directory.split("/").filter(Boolean).pop() ?? directory;
  }, [tab?.workingDirectory, registry]);

  // Pane controls remain reachable in an empty workspace, when they are the
  // only visible route to create or inspect a conversation.
  const title = tab ? tab.customTitle || tab.title || "Untitled" : "";
  const leftPanelHeaderWidth = panes.leftSidebarVisible
    ? Math.max(0, panes.leftSidebarWidth - 12 - controls.left)
    : undefined;

  return (
    <div
      data-testid="studio-title-bar"
      data-drag-region="drag"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        height: STUDIO_TITLE_BAR_HEIGHT,
        boxSizing: "border-box",
        padding: `0px ${12 + controls.right}px 0px ${12 + controls.left}px`,
        background: colors.containerBgCollapsed,
        borderBottom: `1px solid ${colors.containerBorder}`,
        color: colors.textPrimary,
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        flexShrink: 0,
        minWidth: 0,
        WebkitAppRegion: "drag",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          flexShrink: 1,
          minWidth: 32,
          maxWidth: leftPanelHeaderWidth,
          overflow: "hidden",
        }}
      >
        <PaneToggle
          label="Toggle sidebar"
          chord={revealed.get(SIDEBAR_COMMAND)}
          active={panes.leftSidebarVisible}
          onClick={panes.onToggleSidebar}
          icon={<SidebarSimple size={13} />}
        />
        <span
          style={{
            color: colors.textPrimary,
            fontWeight: 600,
            padding: "0 6px 0 2px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {STUDIO_BRAND}
        </span>
      </div>
      <div
        data-testid="studio-title-bar-center"
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {tab && projectLabel && (
          <>
            <Tooltip text={`${tab.workingDirectory} — start a new conversation`}>
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('ion:open-new-conversation-picker'))}
                aria-label="Start a new conversation"
                data-drag-region="no-drag"
                style={breadcrumbButtonStyle(colors)}
              >
                <FolderSimple size={11} />
                <span style={ellipsisStyle}>{projectLabel}</span>
              </button>
            </Tooltip>
            <CaretRight
              size={8}
              style={{ color: colors.textTertiary, opacity: 0.5, flexShrink: 0 }}
            />
          </>
        )}
        <span style={{ ...ellipsisStyle, color: colors.textPrimary, fontWeight: 600 }}>
          {title}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
        <UpdateButton />
        <div data-drag-region="no-drag" style={{ WebkitAppRegion: "no-drag" }}>
          <NotificationsBell />
        </div>
        <PaneToggle
          label="Toggle terminal"
          chord={revealed.get(TERMINAL_COMMAND)}
          active={panes.terminalVisible}
          onClick={handleTerminalClick}
          onMouseDown={handleTerminalMouseDown}
          onContextMenu={handleTerminalContextMenu}
          icon={<TerminalIcon size={13} />}
        />
        <PaneToggle
          label="Toggle canvas panel"
          chord={revealed.get(SURFACE_COMMAND)}
          active={panes.surfaceVisible}
          onClick={panes.onToggleSurface}
          icon={<SquareSplitHorizontal size={13} />}
        />
      </div>
      <AnimatePresence>
        {terminalPickerAnchor && (
          <DirectoryPicker
            anchor={terminalPickerAnchor}
            onSelectDir={(directory) => {
              usePreferencesStore.getState().addRecentBaseDirectory(directory);
              void useSessionStore.getState().createTerminalTab(directory)
                .then(() => {
                  rDebug("studio.terminal", "terminal tab created", { directory });
                  setTerminalPickerAnchor(null);
                })
                .catch((error) => rError("studio.terminal", "terminal tab creation failed", { directory, error: String(error) }));
            }}
            onClose={() => setTerminalPickerAnchor(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function PaneToggle({
  label,
  chord,
  active,
  onClick,
  onMouseDown,
  onContextMenu,
  icon,
}: {
  label: string;
  /** The live chord, present only while its own modifiers are held. */
  chord?: string;
  active: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseDown?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  icon: React.ReactNode;
}): React.JSX.Element {
  const colors = useColors();
  // The tooltip always names the chord when one is bound; the inline badge is
  // what appears and disappears with the held modifier.
  return (
    <Tooltip text={chord ? `${label} (${chord})` : label}>
      <button
        onClick={onClick}
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
        aria-label={label}
        aria-keyshortcuts={chord}
        data-drag-region="no-drag"
        style={{
          border: "none",
          background: active ? colors.accentLight : "transparent",
          color: active ? colors.accent : colors.textTertiary,
          cursor: "pointer",
          padding: "2px 5px",
          borderRadius: 4,
          display: "flex",
          alignItems: "center",
          gap: 3,
          flexShrink: 0,
          WebkitAppRegion: "no-drag",
        }}
      >
        {icon}
        {chord && <ShortcutHint chord={chord} dimmed={!active} />}
      </button>
    </Tooltip>
  );
}

const ellipsisStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

function breadcrumbButtonStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 4,
    border: "none",
    background: "transparent",
    color: colors.textTertiary,
    cursor: "pointer",
    padding: "1px 4px",
    borderRadius: 4,
    fontSize: 11,
    maxWidth: 240,
    minWidth: 0,
    WebkitAppRegion: "no-drag",
  };
}
