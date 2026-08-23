import React, { useCallback, useRef, useState } from "react";
import { CaretDown, Square } from "@phosphor-icons/react";
import { useColors } from "../theme";
import { useInteractiveState } from "../hooks/useInteractiveState";
import { DispatchStopMenu } from "./DispatchStopMenu";

interface DispatchStopControlProps {
  /** Dispatch currently represented by the row/preview. Stop targets this ID. */
  dispatchId: string;
  /** Every running dispatch instance represented by this agent row. */
  runningDispatchIds: string[];
  onStop(dispatchId: string): void;
  onStopAll(dispatchIds: string[]): void;
  /** Compact row chrome or transcript-corner chrome. */
  compact?: boolean;
}

/**
 * Shared dispatch-level split Stop control.
 *
 * Mounted in every running AgentRow and in the bottom-right corner of every
 * open dispatch transcript. Primary Stop recalls the selected dispatch ID;
 * engine RecallByID cascades through that dispatch's descendants. The caret
 * offers Stop all when the row represents more than one running dispatch,
 * recalling every running instance in that row while leaving the orchestrator
 * and other agent rows untouched.
 *
 * Actions stop propagation so clicking Stop never also opens/collapses the row.
 */
export function DispatchStopControl({
  dispatchId,
  runningDispatchIds,
  onStop,
  onStopAll,
  compact = false,
}: DispatchStopControlProps): React.JSX.Element | null {
  const colors = useColors();
  const primary = useInteractiveState();
  const caret = useInteractiveState();
  const caretRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const uniqueRunningIds = Array.from(
    new Set(runningDispatchIds.filter(Boolean)),
  );
  const currentRunning = uniqueRunningIds.includes(dispatchId);

  const openMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const rect = caretRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ x: rect.right, y: rect.bottom });
  }, []);

  const stopCurrent = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onStop(dispatchId);
  };

  if (!dispatchId || !currentRunning) return null;

  const fontSize = compact ? 9 : 10;
  const iconSize = compact ? 7 : 8;

  return (
    <div
      data-ion-ui
      onClick={(event) => event.stopPropagation()}
      className="inline-flex items-center flex-shrink-0"
      style={{ borderRadius: 5, overflow: "hidden" }}
    >
      <button
        onClick={stopCurrent}
        {...primary.handlers}
        className="ion-focusable inline-flex items-center gap-1 px-1.5 py-0.5 cursor-pointer"
        style={{
          background: primary.pressed
            ? colors.permissionDenyHoverBg
            : primary.hover
              ? colors.statusErrorBg
              : "transparent",
          color: colors.statusError,
          border: "none",
          fontSize,
        }}
        aria-label="Stop this dispatch"
      >
        <Square size={iconSize} weight="fill" />
        <span>Stop</span>
      </button>
      {uniqueRunningIds.length > 1 && (
        <button
          ref={caretRef}
          onClick={openMenu}
          {...caret.handlers}
          className="ion-focusable inline-flex items-center px-1 py-0.5 cursor-pointer"
          style={{
            background: caret.pressed
              ? colors.permissionDenyHoverBg
              : caret.hover
                ? colors.statusErrorBg
                : "transparent",
            color: colors.statusError,
            border: "none",
            borderLeft: `1px solid ${colors.statusErrorBg}`,
          }}
          aria-label="More dispatch stop options"
        >
          <CaretDown size={iconSize} weight="bold" />
        </button>
      )}
      {anchor && (
        <DispatchStopMenu
          anchor={anchor}
          runningCount={uniqueRunningIds.length}
          onStopCurrent={() => onStop(dispatchId)}
          onStopAll={() => onStopAll(uniqueRunningIds)}
          onClose={() => setAnchor(null)}
        />
      )}
    </div>
  );
}
