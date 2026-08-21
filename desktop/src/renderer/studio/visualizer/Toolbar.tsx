/**
 * Studio control bar: canvas actions only — zoom/fit, campus, replay, exports,
 * heat, and the side-dock toggle. Window-level controls live elsewhere by
 * design: pin is a Window-menu item (main process), and sound + the office
 * generator (seed/theme) sit behind the TabStrip's Studio button popover
 * (ControlsPopover). Conversation switching lives in the real TabStrip
 * mounted by StudioShell — never a bespoke picker here (parity mechanism 1).
 * Chrome colors come from the active application theme. Canvas colors stay
 * theme-pack-driven.
 */
import React from "react";
import {
  Buildings,
  Camera,
  ClockCounterClockwise,
  FilmSlate,
  MagnifyingGlassPlus,
  MagnifyingGlassMinus,
  ArrowsIn,
  GearSix,
} from "@phosphor-icons/react";
import { useColors } from "../../theme";

export interface ToolbarProps {
  /** Side-dock toggle (conversation/files drawer on the right). */
  /** Campus view toggle (all conversations as buildings). */
  campus: boolean;
  onToggleCampus(): void;
  /** Session replay toggle (enter/exit). */
  replaying: boolean;
  onToggleReplay(): void;
  /** Save an office-snapshot postcard PNG. */
  onExportPostcard(): void;
  /** Clip recording: 0 = idle, >0 = seconds left, -1 = saving. */
  clipSecondsLeft: number;
  onRecordClip(): void;
  /** Footstep-heat overlay state + toggle. */
  heatOn: boolean;
  onToggleHeat(): void;
  /** 0 = fit-to-window mode; 1..6 = manual zoom. */
  zoom: number;
  /** Non-empty when the loader skipped assets or generation reported issues. */
  problems: string[];
  onZoom(delta: number): void;
  /** Snap back to fit-to-window (whole office visible, rescales on resize). */
  onZoomFit(): void;
  /** Open visualizer sound/theme/seed settings at this button's viewport anchor. */
  onOpenSettings(anchor: { x: number; y: number }): void;
}

export function Toolbar(props: ToolbarProps): React.JSX.Element {
  const colors = useColors();
  const bar: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    background: colors.containerBg,
    borderBottom: `1px solid ${colors.containerBorder}`,
    color: colors.textPrimary,
    fontFamily: "system-ui, sans-serif",
    fontSize: 12,
    userSelect: "none",
  };
  const buttonStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    borderRadius: 6,
    border: "none",
    background: "transparent",
    color: colors.textTertiary,
    cursor: "pointer",
  };
  return (
    <div style={bar}>
      <div style={{ flex: 1 }} />

      {props.problems.length > 0 && (
        <span
          title={props.problems.join("\n")}
          style={{ color: colors.statusWaitingChildren }}
        >
          {props.problems.length} asset issue
          {props.problems.length === 1 ? "" : "s"}
        </span>
      )}

      <button
        style={buttonStyle}
        title="Zoom out"
        onClick={() => props.onZoom(-1)}
      >
        <MagnifyingGlassMinus size={14} />
      </button>
      <span
        style={{
          color: colors.textTertiary,
          minWidth: 24,
          textAlign: "center",
        }}
      >
        {/* Display scale: a comfortable 2:1 pixel ratio reads as "1x", so the
            internal 1..6 render scale shows as 0.5x..3x. */}
        {props.zoom === 0 ? "fit" : `${props.zoom / 2}x`}
      </span>
      <button
        style={buttonStyle}
        title="Zoom in"
        onClick={() => props.onZoom(1)}
      >
        <MagnifyingGlassPlus size={14} />
      </button>
      <button
        style={{
          ...buttonStyle,
          color: props.zoom === 0 ? colors.accent : colors.textTertiary,
        }}
        title="Fit office to window"
        onClick={props.onZoomFit}
      >
        <ArrowsIn size={14} />
      </button>

      <button
        style={{
          ...buttonStyle,
          color: props.campus ? colors.accent : colors.textTertiary,
        }}
        title={
          props.campus
            ? "Back to the office"
            : "Campus view (all conversations)"
        }
        onClick={props.onToggleCampus}
      >
        <Buildings size={14} weight={props.campus ? "fill" : "regular"} />
      </button>
      <button
        style={{
          ...buttonStyle,
          color: props.replaying
            ? colors.statusWaitingChildren
            : colors.textTertiary,
        }}
        title={
          props.replaying
            ? "Exit replay (return to live)"
            : "Replay this session"
        }
        onClick={props.onToggleReplay}
      >
        <ClockCounterClockwise
          size={14}
          weight={props.replaying ? "fill" : "regular"}
        />
      </button>
      <button
        style={buttonStyle}
        title="Export office postcard (PNG)"
        onClick={props.onExportPostcard}
      >
        <Camera size={14} />
      </button>
      <button
        style={{
          ...buttonStyle,
          color:
            props.clipSecondsLeft !== 0
              ? colors.statusRunning
              : colors.textTertiary,
          width: props.clipSecondsLeft > 0 ? 34 : 24,
        }}
        title="Record a 10s office clip (webm)"
        onClick={props.onRecordClip}
        disabled={props.clipSecondsLeft !== 0}
      >
        <FilmSlate
          size={14}
          weight={props.clipSecondsLeft !== 0 ? "fill" : "regular"}
        />
        {props.clipSecondsLeft > 0 && (
          <span style={{ fontSize: 9, marginLeft: 2 }}>
            {props.clipSecondsLeft}
          </span>
        )}
      </button>
      <button
        style={buttonStyle}
        title="Visualizer settings"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          props.onOpenSettings({ x: rect.right, y: rect.bottom });
        }}
      >
        <GearSix size={14} />
      </button>
    </div>
  );
}
