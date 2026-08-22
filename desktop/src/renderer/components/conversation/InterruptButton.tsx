import React, { useCallback, useRef, useState } from "react";
import { motion } from "framer-motion";
import { CaretDown, Square } from "@phosphor-icons/react";
import { useColors } from "../../theme";
import { useInteractiveState } from "../../hooks/useInteractiveState";
import { InterruptMenu } from "./InterruptMenu";

interface InterruptButtonProps {
  /** Primary action: stop the orchestrator, leaving background dispatches up. */
  onInterrupt: () => void;
  /** Menu action: stop the run AND every background dispatch. */
  onStopAll: () => void;
  /** Whether the orchestrator itself has an active run. */
  isRunning: boolean;
  /** Running dispatched agents, for the menu's labels and the primary hint. */
  runningChildCount: number;
  /** Running session-owned Bash tasks. */
  backgroundTaskCount: number;
}

/**
 * The conversation's Stop control: a split button.
 *
 * The primary click is the RECOVERABLE stop — it ends the orchestrator's run
 * and leaves background dispatches working, so a stuck orchestrator can be
 * cleared without discarding a tree of in-flight agent work. The caret opens
 * the menu holding Stop all, the destructive peer.
 *
 * When the orchestrator is idle and only background work remains, the primary
 * action becomes Stop all. This keeps the direct action useful while preserving
 * the recoverable orchestrator-only action during an active run.
 */
export function InterruptButton({
  onInterrupt,
  onStopAll,
  isRunning,
  runningChildCount,
  backgroundTaskCount,
}: InterruptButtonProps) {
  const colors = useColors();
  // Danger-family cascade: hover → statusErrorBg tint, pressed → the deeper
  // permissionDenyHoverBg tint. Keyboard focus rides `.ion-focusable`, whose
  // class transition covers the background shift.
  const { hover, pressed, handlers } = useInteractiveState();
  const caretState = useInteractiveState();
  const caretRef = useRef<HTMLButtonElement>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(
    null,
  );

  const openMenu = useCallback(() => {
    const rect = caretRef.current?.getBoundingClientRect();
    if (!rect) return;
    // useAnchoredPopover measures and right-clamps the menu, so this is the
    // trigger point only — never a guessed menu width.
    setMenuAnchor({ x: rect.right, y: rect.bottom });
  }, []);

  const background = pressed
    ? colors.permissionDenyHoverBg
    : hover
      ? colors.statusErrorBg
      : "transparent";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="inline-flex items-center flex-shrink-0"
      style={{ borderRadius: 6, overflow: "hidden" }}
    >
      <button
        onClick={onInterrupt}
        disabled={false}
        {...handlers}
        className="ion-focusable inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] cursor-pointer"
        style={{
          background,
          color: colors.statusError,
          border: "none",
          opacity: 1,
          cursor: "pointer",
        }}
        title={
          isRunning
            ? runningChildCount > 0
              ? `Stop the orchestrator (keeps ${runningChildCount} background agent${runningChildCount === 1 ? "" : "s"} running)`
              : "Stop the orchestrator"
            : `Stop all background work (${runningChildCount + backgroundTaskCount} active)`
        }
      >
        <Square size={9} weight="fill" />
        <span>Stop</span>
      </button>
      <button
        ref={caretRef}
        onClick={openMenu}
        {...caretState.handlers}
        className="ion-focusable inline-flex items-center px-1 py-0.5 cursor-pointer"
        style={{
          background: caretState.pressed
            ? colors.permissionDenyHoverBg
            : caretState.hover
              ? colors.statusErrorBg
              : "transparent",
          color: colors.statusError,
          border: "none",
          borderLeft: `1px solid ${colors.statusErrorBg}`,
        }}
        title="More stop options"
        aria-label="More stop options"
      >
        <CaretDown size={9} weight="bold" />
      </button>

      {menuAnchor && (
        <InterruptMenu
          anchor={menuAnchor}
          runningChildCount={runningChildCount}
          backgroundTaskCount={backgroundTaskCount}
          isRunning={isRunning}
          onStopOrchestrator={onInterrupt}
          onStopAll={onStopAll}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </motion.div>
  );
}
