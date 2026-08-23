import React, { useRef } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useColors } from "../theme";
import { useAnchoredPopover } from "../hooks/useAnchoredPopover";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { usePopoverLayer } from "./PopoverLayer";

interface DispatchStopMenuProps {
  anchor: { x: number; y: number };
  runningCount: number;
  onStopCurrent(): void;
  onStopAll(): void;
  onClose(): void;
}

/**
 * Overflow for an agent row/dispatch preview's split Stop.
 *
 * Stop current recalls the selected dispatch and its descendant chain. Stop all
 * recalls every running dispatch represented by this ONE agent row; the
 * orchestrator and other rows survive. Point-anchored and measured through
 * useAnchoredPopover, so it flips/clamps inside short or zoomed windows.
 */
export function DispatchStopMenu({
  anchor,
  runningCount,
  onStopCurrent,
  onStopAll,
  onClose,
}: DispatchStopMenuProps): React.JSX.Element | null {
  const colors = useColors();
  const popoverLayer = usePopoverLayer();
  const outsideRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPopover(anchor, {
    prefer: "below",
    offsetY: 4,
    deps: [runningCount],
  });
  useOutsideDismiss([outsideRef], onClose);

  if (!popoverLayer) return null;

  const items = [
    {
      label: "Stop this dispatch",
      hint: "Also stops its descendant chain",
      danger: false,
      run: onStopCurrent,
    },
    {
      label: "Stop all in this row",
      hint: `Stops ${runningCount} running dispatch${runningCount === 1 ? "" : "es"} for this agent`,
      danger: true,
      run: onStopAll,
    },
  ];

  return createPortal(
    <motion.div
      ref={(node) => {
        outsideRef.current = node;
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
        minWidth: 220,
        maxHeight: "calc(100vh - 16px)",
        overflowY: "auto",
        zIndex: 1000,
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          data-ion-ui
          onClick={() => {
            item.run();
            onClose();
          }}
          className="ion-focusable"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 1,
            width: "100%",
            padding: "5px 12px",
            cursor: "pointer",
            background: "transparent",
            border: "none",
            userSelect: "none",
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = colors.surfaceHover;
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = "transparent";
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
            {item.hint}
          </span>
        </button>
      ))}
    </motion.div>,
    popoverLayer,
  );
}
