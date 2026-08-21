import React from "react";
import { useColors } from "../../theme";
import type { StudioEngine } from "./engine";
import { ReplayBar } from "./ReplayBar";
import { Campus } from "./Campus";
import type { AgentCache, StudioActiveState } from "./state/agent-cache";
import { type Tooltip, type Phase } from "./visualizer-types";

interface VisualizerCanvasProps {
  phase: Phase;
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  engineRef: React.MutableRefObject<StudioEngine | null>;
  cacheRef: React.MutableRefObject<AgentCache | null>;
  seed: string;
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  campus: boolean;
  setCampus: React.Dispatch<React.SetStateAction<boolean>>;
  replaying: boolean;
  setReplaying: React.Dispatch<React.SetStateAction<boolean>>;
  tooltip: Tooltip | null;
  setTooltip: React.Dispatch<React.SetStateAction<Tooltip | null>>;
  onMouseDown: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  onMouseMove: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  onMouseUp: () => void;
  onClick: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  rebuildScene: (state: StudioActiveState | null) => void;
}

export function VisualizerCanvas({
  phase,
  canvasRef,
  engineRef,
  cacheRef,
  seed,
  zoom,
  setZoom,
  campus,
  setCampus,
  replaying,
  setReplaying,
  tooltip,
  setTooltip,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onClick,
  rebuildScene,
}: VisualizerCanvasProps): React.JSX.Element {
  const colors = useColors();

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          display: "block",
          cursor: zoom === 0 ? "default" : "grab",
        }}
        onWheel={(event) => {
          const engine = engineRef.current;
          if (!engine) return;
          engine.wheelZoom(
            event.nativeEvent.offsetX,
            event.nativeEvent.offsetY,
            event.deltaY < 0 ? 1 : -1,
          );
          const view = engine.getView();
          setZoom((previous) =>
            previous === view.zoom ? previous : view.zoom,
          );
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onClick={onClick}
        onMouseLeave={() => {
          setTooltip(null);
        }}
      />
      {campus && (
        <Campus
          seed={seed}
          onSelect={(tabId) => {
            window.ion.studioFocusTab(tabId);
            setCampus(false);
          }}
          onExit={() => setCampus(false)}
        />
      )}
      {replaying && engineRef.current && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
          <ReplayBar
            engine={engineRef.current}
            onExit={() => {
              engineRef.current?.stopReplay();
              setReplaying(false);
              rebuildScene(cacheRef.current?.getActive() ?? null);
            }}
          />
        </div>
      )}
      {tooltip && (
        <div
          style={{
            position: "absolute",
            left: Math.min(
              tooltip.x + 12,
              (canvasRef.current?.clientWidth ?? 300) - 180,
            ),
            top: Math.max(tooltip.y - 44, 4),
            background: colors.containerBg,
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 6,
            padding: "4px 8px",
            pointerEvents: "none",
            fontFamily: "system-ui, sans-serif",
            fontSize: 11,
            color: colors.textPrimary,
            maxWidth: 220,
            zIndex: 10,
          }}
        >
          <div style={{ fontWeight: 600 }}>{tooltip.title}</div>
          {tooltip.lines.map((line, index) => (
            <div key={index} style={{ color: colors.textTertiary }}>
              {line}
            </div>
          ))}
        </div>
      )}
      {phase.kind !== "ready" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: colors.textTertiary,
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            padding: 24,
            textAlign: "center",
          }}
        >
          {phase.kind === "loading"
            ? "Loading theme…"
            : `Theme failed to load: ${phase.message}`}
        </div>
      )}
    </div>
  );
}
