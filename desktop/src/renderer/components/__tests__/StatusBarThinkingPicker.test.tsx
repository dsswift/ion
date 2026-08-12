// @vitest-environment jsdom
/**
 * Two things are pinned here.
 *
 * 1. `resolveThinkingControlState` — the pure rendering rules. Four cases:
 *    adaptive floor, efforts without an adaptive floor, no efforts at all, and
 *    a model absent from `availableModels` entirely.
 *
 * 2. THE CONTROL IS NEVER HIDDEN. This is the defect the change fixes. The
 *    pre-fix file DOCUMENTED a two-condition force-hide but implemented only
 *    one of them: `if (!thinkingEnabled) return null` really did remove the
 *    slot, while the model condition already rendered the trigger disabled.
 *    So the regression assertions below go red on the pre-fix code in the
 *    adaptive-label case
 *    (trigger read "Think: Off" for a model that always thinks), and the
 *    model-support cases pin the disabled behavior that must not regress.
 */

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";

import {
  resolveThinkingControlState,
  thinkingTriggerLabel,
} from "../thinking-control-state";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/* ─── Resolver ─── */

describe("resolveThinkingControlState", () => {
  it('adaptive floor: adaptive row reads "Adaptive", control enabled', () => {
    const s = resolveThinkingControlState("adaptive", [
      "low",
      "medium",
      "high",
    ]);
    expect(s.offLabel).toBe("Adaptive");
    expect(s.enabled).toBe(true);
    expect(s.levels.map((l) => l.value)).toEqual([
      "adaptive",
      "low",
      "medium",
      "high",
    ]);
    // "Adaptive" REPLACES "Off" — it is not a fifth entry.
    expect(s.levels.filter((l) => l.value === "adaptive")).toHaveLength(1);
    expect(s.levels.map((l) => l.label)).not.toContain("Off");
  });

  it('efforts without an adaptive floor: off row reads "Off", control enabled', () => {
    const s = resolveThinkingControlState("reasoning_effort", ["low", "high"]);
    expect(s.offLabel).toBe("Off");
    expect(s.enabled).toBe(true);
    // Only the levels the model declares — medium is absent here.
    expect(s.levels.map((l) => l.value)).toEqual(["off", "low", "high"]);
  });

  it("no efforts: control disabled, off row still labelled", () => {
    const s = resolveThinkingControlState("none", []);
    expect(s.enabled).toBe(false);
    expect(s.offLabel).toBe("Off");
    expect(s.levels.map((l) => l.value)).toEqual(["off"]);
  });

  it("model absent from availableModels: disabled, no crash", () => {
    const s = resolveThinkingControlState(undefined, undefined);
    expect(s.enabled).toBe(false);
    expect(s.offLabel).toBe("Off");
    expect(s.levels.map((l) => l.value)).toEqual(["off"]);
  });

  it("adaptive with no declared override levels is still disabled", () => {
    // Nothing to choose between, so there is no menu to open — but the trigger
    // reports the honest floor.
    const s = resolveThinkingControlState("adaptive", []);
    expect(s.enabled).toBe(false);
    expect(s.offLabel).toBe("Adaptive");
  });

  it("trigger label follows the selected effort, falling back to the off row", () => {
    const adaptive = resolveThinkingControlState("adaptive", ["low", "high"]);
    expect(thinkingTriggerLabel(adaptive, "adaptive")).toBe("Adaptive");
    expect(thinkingTriggerLabel(adaptive, "high")).toBe("High");
    // 'medium' is not declared by this model: fall back to the off row rather
    // than rendering an empty label.
    expect(thinkingTriggerLabel(adaptive, "medium")).toBe("Adaptive");
  });
});

/* ─── Never hidden ─── */

let mockModel:
  { thinkingMode?: string; thinkingEfforts?: string[] } | undefined;

vi.mock("../../hooks/useViewportClamp", () => ({ useViewportClamp: () => {} }));
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children }: { children?: React.ReactNode }) => (
      <div>{children}</div>
    ),
  },
}));
vi.mock("@phosphor-icons/react", () => ({
  CaretDown: () => null,
  Check: () => null,
  Brain: () => null,
}));
vi.mock("../../theme", () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `token-${String(key)}` }),
}));
vi.mock("../../hooks/useInteractiveState", () => ({
  useInteractiveState: () => ({ hover: false, pressed: false, handlers: {} }),
  interactiveBg: () => "token-bg",
}));
vi.mock("../PopoverLayer", () => ({ usePopoverLayer: () => null }));
vi.mock("../../stores/conversation-instance", () => ({
  activeInstance: () => ({ thinkingEffort: "off" }),
}));
vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: (sel: (s: unknown) => unknown) =>
    sel({
      conversationPanes: new Map(),
      activeTabId: "t1",
      setThinkingEffort: () => {},
    }),
}));
vi.mock("../../preferences", () => ({
  usePreferencesStore: (sel: (s: unknown) => unknown) =>
    sel({ preferredModel: "m1" }),
}));
vi.mock("../../stores/model-store", () => ({
  useModelStore: (sel: (s: unknown) => unknown) =>
    sel({ findModel: () => mockModel }),
}));

import { ThinkingPicker } from "../StatusBarThinkingPicker";

function renderPicker(): { html: string; disabled: boolean | undefined } {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => {
      root.render(<ThinkingPicker />);
    });
    const button = container.querySelector("button");
    return { html: container.innerHTML, disabled: button?.disabled };
  } finally {
    act(() => {
      root.unmount();
    });
  }
}

describe("ThinkingPicker is never hidden", () => {
  it("renders DISABLED for a model that supports no thinking", () => {
    mockModel = { thinkingMode: "none", thinkingEfforts: [] };
    const { html, disabled } = renderPicker();
    expect(html).not.toBe("");
    expect(html).toContain("Think: Off");
    expect(disabled).toBe(true);
  });

  it("renders DISABLED for a model absent from availableModels", () => {
    mockModel = undefined;
    const { html, disabled } = renderPicker();
    expect(html).not.toBe("");
    expect(html).toContain("Think: Off");
    expect(disabled).toBe(true);
  });

  it('renders ENABLED and reads "Adaptive" for an adaptive model', () => {
    mockModel = {
      thinkingMode: "adaptive",
      thinkingEfforts: ["low", "medium", "high"],
    };
    const { html, disabled } = renderPicker();
    expect(html).toContain("Think: Adaptive");
    expect(disabled).toBe(false);
  });
});
