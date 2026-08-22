/**
 * StudioTitleBar — themed native-window title bar for Studio.
 *
 * The main process leaves macOS traffic lights and non-macOS window controls
 * native, while this renderer-owned surface provides matching themed chrome.
 * Drag only empty title-bar space. Every actionable child opts out.
 */
import React, { useMemo, useRef, useState } from "react";
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
import { ProjectPicker } from "./inbox/ProjectPicker";
import { useColors } from "../theme";
import { rError } from "../rendererLogger";
import { Tooltip } from "../components/git/Tooltip";
import { ShortcutHint } from "../shortcuts/ShortcutHint";
import { useRevealedShortcuts } from "../shortcuts/useShortcutHints";
import { useStudioWindowChrome } from "./chrome/useStudioWindowChrome";

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
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  onToggleSurface: () => void;
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
  const [pickerAnchor, setPickerAnchor] = useState<{ x: number; y: number } | null>(
    null,
  );
  const dirButtonRef = useRef<HTMLButtonElement>(null);
  // Held-modifier reveal for the pane toggles. Each entry is present only
  // while its own chord's modifiers are held, so ⌘ reveals the sidebar and
  // canvas toggles while ⌃ reveals the terminal toggle.
  const revealed = useRevealedShortcuts("studio", PANE_COMMANDS);

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
          flexShrink: 0,
          width: leftPanelHeaderWidth,
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
                ref={dirButtonRef}
                onClick={() => {
                  const rect = dirButtonRef.current?.getBoundingClientRect();
                  setPickerAnchor({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
                }}
                aria-label="Start a new conversation in this directory"
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
        <PaneToggle
          label="Toggle terminal"
          chord={revealed.get(TERMINAL_COMMAND)}
          active={panes.terminalVisible}
          onClick={panes.onToggleTerminal}
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
      {pickerAnchor && (
        <ProjectPicker
          x={pickerAnchor.x}
          y={pickerAnchor.y}
          onPick={(directory) => {
            void useSessionStore
              .getState()
              .createTabInDirectory(directory)
              .catch((error) =>
                rError("studio.titlebar", "create in directory failed", {
                  directory,
                  error: String(error),
                }),
              );
          }}
          onClose={() => setPickerAnchor(null)}
        />
      )}
    </div>
  );
}

function PaneToggle({
  label,
  chord,
  active,
  onClick,
  icon,
}: {
  label: string;
  /** The live chord, present only while its own modifiers are held. */
  chord?: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}): React.JSX.Element {
  const colors = useColors();
  // The tooltip always names the chord when one is bound; the inline badge is
  // what appears and disappears with the held modifier.
  return (
    <Tooltip text={chord ? `${label} (${chord})` : label}>
      <button
        onClick={onClick}
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
