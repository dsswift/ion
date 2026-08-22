/**
 * StudioSurface — the right-hand surface pane shell: visibility + width.
 *
 * Owns pane GEOMETRY only (width, the resize seam, the close affordance);
 * the tab system inside is SurfacePanel over the window-local surface
 * store. The surface state supplies pinned Plan and conversation-local tabs;
 * this shell only owns geometry and chrome.
 */
import React from "react";
import { SurfacePanel } from "./surface/SurfacePanel";
import { useResizablePane } from "../hooks/useResizablePane";
import { useColors } from "../theme";
import { STUDIO_LAYOUT_BOUNDS } from "../../shared/types-studio";

export interface StudioSurfaceProps {
  /** Live width during a drag. */
  liveWidth: number;
  onLiveResize: (w: number) => void;
  onCommitWidth: (w: number) => void;
  onClose: () => void;
  onFocusCapture?: () => void;
  onMouseDownCapture?: () => void;
  onAgentClick?: (tabId: string, agentName: string) => void;
}

export function StudioSurface(props: StudioSurfaceProps): React.JSX.Element {
  const colors = useColors();
  const bounds = STUDIO_LAYOUT_BOUNDS.surfaceWidth;
  const { handleProps, dragging } = useResizablePane({
    axis: "x",
    edge: "start", // handle on the surface's left edge; dragging left grows it
    min: bounds.min,
    max: bounds.max,
    size: props.liveWidth,
    onResize: props.onLiveResize,
    onCommit: props.onCommitWidth,
  });

  return (
    <div
      onFocusCapture={props.onFocusCapture}
      onMouseDownCapture={props.onMouseDownCapture}
      style={{
        width: props.liveWidth,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderLeft: `1px solid ${colors.containerBorder}`,
        background: colors.containerBg,
        position: "relative",
        minHeight: 0,
      }}
    >
      {/* Left-edge resize handle. */}
      <div
        {...handleProps}
        style={{
          ...handleProps.style,
          position: "absolute",
          left: -3,
          top: 0,
          bottom: 0,
          width: 6,
          zIndex: 2,
          background: dragging ? colors.accent : "transparent",
          opacity: dragging ? 0.4 : 1,
        }}
      />
      {/* Pane chrome: close button rides above the tab strip's right edge. */}
      <button
        onClick={props.onClose}
        style={{
          position: "absolute",
          top: 6,
          right: 8,
          zIndex: 3,
          border: "none",
          background: "transparent",
          color: colors.textTertiary,
          cursor: "pointer",
          fontSize: 14,
          lineHeight: 1,
        }}
        aria-label="Close surface panel"
      >
        ×
      </button>
      <SurfacePanel onAgentClick={props.onAgentClick} />
    </div>
  );
}
