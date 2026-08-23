import React, { useRef } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useColors } from "../../theme";
import { useAnchoredPopover } from "../../hooks/useAnchoredPopover";
import { usePopoverLayer } from "../PopoverLayer";
import { useOutsideDismiss } from "../../hooks/useOutsideDismiss";

interface InterruptMenuProps {
  /** Viewport coordinates to anchor the menu at (the caret's bottom-left). */
  anchor: { x: number; y: number };
  /** How many dispatched agents are currently running, for the Stop-all label. */
  runningChildCount: number;
  backgroundTaskCount: number;
  /** Whether the orchestrator itself has an active run. */
  isRunning: boolean;
  onStopOrchestrator(): void;
  onStopAll(): void;
  onClose(): void;
}

/**
 * The Stop button's overflow menu: the two scopes the primary click does not
 * cover.
 *
 * The primary button stops the orchestrator, which is the recoverable action —
 * background dispatches keep working and the conversation tree survives. Stop
 * all is the destructive peer, so it lives one deliberate click away rather
 * than under the cursor's default target.
 *
 * Portaled into PopoverLayer, which is `pointerEvents: 'none'`, so the root
 * sets `pointerEvents: 'auto'` or every click passes straight through it.
 */
export function InterruptMenu({
  anchor,
  runningChildCount,
  backgroundTaskCount,
  isRunning,
  onStopOrchestrator,
  onStopAll,
  onClose,
}: InterruptMenuProps): React.JSX.Element | null {
  const colors = useColors();
  const popoverLayer = usePopoverLayer();
  const ref = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPopover(anchor, {
    prefer: "below",
    offsetY: 4,
    deps: [runningChildCount, backgroundTaskCount, isRunning],
  });
  useOutsideDismiss([ref], onClose);

  if (!popoverLayer) return null;

  const hasChildren = runningChildCount > 0;
  const workParts = [
    hasChildren ? `${runningChildCount} background agent${runningChildCount === 1 ? "" : "s"}` : "",
    backgroundTaskCount > 0 ? `${backgroundTaskCount} background shell${backgroundTaskCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  const items = [
    {
      label: "Stop orchestrator",
      // Naming what SURVIVES is the whole point of the scope; a user picking
      // between two stops needs to know what each one spares.
      hint: hasChildren
        ? `Keeps ${runningChildCount} background agent${runningChildCount === 1 ? "" : "s"} running`
        : "Leaves background agents running",
      // Nothing to stop when the orchestrator is idle and only children remain.
      disabled: !isRunning,
      disabledHint: "No active orchestrator run",
      danger: false,
      run: onStopOrchestrator,
    },
    {
      label: "Stop all",
      hint: workParts.length > 0
        ? `Also stops ${workParts.join(" and ")}`
        : "Stops the run and all background work",
      disabled: false,
      disabledHint: "",
      danger: true,
      run: onStopAll,
    },
  ];

  return createPortal(
    <motion.div
      ref={(node) => {
        ref.current = node;
        pos.ref(node);
      }}
      data-ion-ui
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12 }}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? "visible" : "hidden",
        pointerEvents: "auto",
        background: colors.popoverBg,
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        boxShadow: colors.popoverShadow,
        padding: "4px 0",
        minWidth: 210,
        zIndex: 1000,
      }}
    >
      {items.map((item) => (
        <div
          key={item.label}
          data-ion-ui
          onClick={() => {
            if (item.disabled) return;
            item.run();
            onClose();
          }}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            padding: "5px 12px",
            cursor: item.disabled ? "default" : "pointer",
            opacity: item.disabled ? 0.45 : 1,
            userSelect: "none",
          }}
          onMouseEnter={(e) => {
            if (item.disabled) return;
            (e.currentTarget as HTMLDivElement).style.background =
              colors.surfaceHover;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLDivElement).style.background =
              "transparent";
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: item.danger ? colors.statusError : colors.textPrimary,
            }}
          >
            {item.label}
          </span>
          <span style={{ fontSize: 10, color: colors.textTertiary }}>
            {item.disabled ? item.disabledHint : item.hint}
          </span>
        </div>
      ))}
    </motion.div>,
    popoverLayer,
  );
}
