import React, { useState, useRef, useEffect, useCallback } from "react";
import { useViewportClamp } from "../hooks/useViewportClamp";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { CaretDown, Check, Brain } from "@phosphor-icons/react";
import { useSessionStore } from "../stores/sessionStore";
import { usePreferencesStore } from "../preferences";
import { useModelStore } from "../stores/model-store";
import { usePopoverLayer } from "./PopoverLayer";
import { useColors } from "../theme";
import {
  useInteractiveState,
  interactiveBg,
} from "../hooks/useInteractiveState";
import { activeInstance } from "../stores/conversation-instance";
import {
  resolveThinkingControlState,
  thinkingTriggerLabel,
} from "./thinking-control-state";
import type { ThinkingEffort } from "../../shared/types-session";

/* ─── Thinking Effort Picker ─── */

/**
 * Per-conversation extended-thinking control rendered in the unified
 * `StatusBar` left cluster.
 *
 * Read path: `instance.thinkingEffort` on the active conversation instance
 * for EVERY tab type. `TabState.thinkingEffort` is gone (WI-002). Both
 * default to 'off'.
 *
 * The control ALWAYS renders. It is never hidden when the active model declares
 * no reasoning support (or is not in `availableModels`). In those cases it
 * renders DISABLED with a title naming the reason, preserving status-bar layout.
 *
 * The rows themselves come from `resolveThinkingControlState`: the 'off' row
 * reads "Adaptive" for a model that thinks by default and cannot be turned off,
 * "Off" otherwise, and only the override levels the model actually declares are
 * offered. Wire values are unchanged ('off' | 'low' | 'medium' | 'high').
 *
 * The selected level is applied LIVE on the next prompt — there is no engine
 * call here; the prompt-submit path reads the level and rides it on
 * send_prompt as `thinkingEffort`.
 */

/** One row in the effort popover. A separate component so each row owns its
 * own useInteractiveState hook (rules-of-hooks: no hooks inside the
 * levels.map loop). */
function ThinkingLevelRow({
  colors,
  selected,
  level,
  onSelect,
}: {
  colors: ReturnType<typeof useColors>;
  selected: boolean;
  level: { value: ThinkingEffort; label: string };
  onSelect: () => void;
}) {
  const { hover, pressed, handlers } = useInteractiveState();
  return (
    <button
      onClick={onSelect}
      {...handlers}
      className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] ion-focusable"
      style={{
        color: selected ? colors.textPrimary : colors.textSecondary,
        fontWeight: selected ? 500 : 400,
        background: interactiveBg(colors, { hover, pressed, selected }),
      }}
    >
      <span className="flex items-center gap-1.5">
        <Brain size={12} weight={level.value === "off" ? "regular" : "fill"} />
        {level.label}
      </span>
      {selected && <Check size={12} style={{ color: colors.accent }} />}
    </button>
  );
}

export function ThinkingPicker() {
  // Per-conversation effort (default 'off') read from the active instance for
  // EVERY tab type — the unified home for the per-conversation thinking effort
  // (matches the unified submit, which reads it from the instance). No
  // engine-vs-plain fork.
  const effort = useSessionStore((s): ThinkingEffort => {
    const inst = activeInstance(s.conversationPanes, s.activeTabId);
    return inst?.thinkingEffort ?? "off";
  });

  // Resolve the active model to read its allowed thinking efforts — from the
  // same active instance (modelOverride / sessionModel), else preferred model.
  const preferredModel = usePreferencesStore((s) => s.preferredModel);
  const activeModelId = useSessionStore((s) => {
    const inst = activeInstance(s.conversationPanes, s.activeTabId);
    return inst?.modelOverride || inst?.sessionModel || preferredModel;
  });
  const findModel = useModelStore((s) => s.findModel);
  const modelEntry = activeModelId ? findModel(activeModelId) : undefined;
  // Resolver owns the rendering rules (off-row label, offered levels, enabled).
  // A model missing from availableModels resolves to a disabled control.
  const controlState = resolveThinkingControlState(
    modelEntry?.thinkingMode,
    modelEntry?.thinkingEfforts,
  );
  // The global preference gates INTERACTION, not visibility: with the feature
  // switched off the control still renders, disabled.
  const interactive = controlState.enabled;

  const setThinkingEffort = useSessionStore((s) => s.setThinkingEffort);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const popoverLayer = usePopoverLayer();
  const colors = useColors();

  const [open, setOpen] = useState(false);
  // Trigger pointer state (handlers are gated off while the control is
  // disabled — disabled elements do not respond to hover/pressed).
  const triggerState = useInteractiveState();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Keep the portaled popover inside the window (ATV top-anchored strip).
  useViewportClamp(popoverRef, open);
  const [pos, setPos] = useState({ bottom: 0, left: 0 });

  useEffect(() => {
    setOpen(false);
  }, [activeTabId]);

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left });
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleToggle = () => {
    if (!interactive) return;
    if (!open) updatePos();
    setOpen((o) => !o);
  };

  const isActive = effort !== "off";
  const label = thinkingTriggerLabel(controlState, effort);
  const color = isActive ? colors.modeThinking : colors.textTertiary;

  const title = controlState.enabled
    ? "Extended thinking (this conversation)"
    : "This model does not support extended thinking";

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        disabled={!interactive}
        {...(interactive ? triggerState.handlers : {})}
        className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 ion-focusable"
        style={{
          color: interactive ? color : colors.textTertiary,
          background: interactive
            ? interactiveBg(colors, triggerState)
            : "transparent",
          opacity: interactive ? 1 : 0.45,
          cursor: interactive ? "pointer" : "default",
        }}
        title={title}
      >
        <Brain size={11} weight={isActive ? "fill" : "regular"} />
        {`Think: ${label}`}
        {interactive && <CaretDown size={10} style={{ opacity: 0.6 }} />}
      </button>

      {interactive &&
        popoverLayer &&
        open &&
        createPortal(
          <motion.div
            ref={popoverRef}
            data-ion-ui
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className="rounded-xl"
            style={{
              position: "fixed",
              bottom: pos.bottom,
              left: pos.left,
              width: 180,
              pointerEvents: "auto",
              background: colors.popoverBg,
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
              boxShadow: colors.popoverShadow,
              border: `1px solid ${colors.popoverBorder}`,
            }}
          >
            <div className="py-1">
              {controlState.levels.map((lvl, i) => {
                // The resolver already dropped the levels this model does not
                // declare, and already labelled the 'off' row ("Adaptive" for a
                // model that always thinks). Render what it returned.
                const selected = effort === lvl.value;
                return (
                  <React.Fragment key={lvl.value}>
                    {i > 0 && (
                      <div
                        className="mx-2 my-0.5"
                        style={{ height: 1, background: colors.popoverBorder }}
                      />
                    )}
                    <ThinkingLevelRow
                      colors={colors}
                      selected={selected}
                      level={lvl}
                      onSelect={() => {
                        setThinkingEffort(lvl.value);
                        setOpen(false);
                      }}
                    />
                  </React.Fragment>
                );
              })}
            </div>
          </motion.div>,
          popoverLayer,
        )}
    </>
  );
}
