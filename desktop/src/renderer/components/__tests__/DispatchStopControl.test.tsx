// @vitest-environment jsdom
/**
 * DispatchStopControl behavior.
 *
 * Pins precise ID semantics: current stop addresses the displayed dispatch;
 * row stop-all receives every running ID in that row; duplicate/blank IDs are
 * removed; and neither action bubbles into the AgentRow click handler.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@phosphor-icons/react", () => ({
  Square: () => null,
  CaretDown: () => null,
}));
vi.mock("../../theme", () => ({
  useColors: () => new Proxy({}, { get: () => "#000000" }),
}));
vi.mock("../../hooks/useInteractiveState", () => ({
  useInteractiveState: () => ({ hover: false, pressed: false, handlers: {} }),
}));
vi.mock("../DispatchStopMenu", () => ({
  DispatchStopMenu: ({ onStopAll }: { onStopAll(): void }) => (
    <button data-testid="stop-all" onClick={onStopAll}>
      Stop all in this row
    </button>
  ),
}));

import { DispatchStopControl } from "../DispatchStopControl";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: React.ComponentProps<typeof DispatchStopControl>) {
  act(() => root.render(<DispatchStopControl {...props} />));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent?.trim() === label,
  );
  if (!match) throw new Error(`button ${label} not found`);
  return match as HTMLButtonElement;
}

describe("DispatchStopControl", () => {
  it("stops the selected dispatch ID", () => {
    const onStop = vi.fn();
    render({
      dispatchId: "dispatch-selected",
      runningDispatchIds: ["dispatch-selected", "dispatch-peer"],
      onStop,
      onStopAll: vi.fn(),
    });

    act(() => button("Stop").click());
    expect(onStop).toHaveBeenCalledWith("dispatch-selected");
  });

  it("stops every unique running dispatch represented by this row", () => {
    const onStopAll = vi.fn();
    render({
      dispatchId: "dispatch-selected",
      runningDispatchIds: [
        "dispatch-selected",
        "dispatch-peer",
        "dispatch-peer",
        "",
      ],
      onStop: vi.fn(),
      onStopAll,
    });

    // Open caret, then invoke the mocked menu's Stop all action.
    const more = container.querySelector(
      '[aria-label="More dispatch stop options"]',
    ) as HTMLButtonElement;
    act(() => more.click());
    act(() => button("Stop all in this row").click());
    expect(onStopAll).toHaveBeenCalledWith([
      "dispatch-selected",
      "dispatch-peer",
    ]);
  });

  it("does not render when selected dispatch is not running", () => {
    render({
      dispatchId: "dispatch-done",
      runningDispatchIds: ["dispatch-other"],
      onStop: vi.fn(),
      onStopAll: vi.fn(),
    });
    expect(container.querySelector("button")).toBeNull();
  });

  it("does not bubble Stop into the row click handler", () => {
    const parentClick = vi.fn();
    const onStop = vi.fn();
    act(() =>
      root.render(
        <div onClick={parentClick}>
          <DispatchStopControl
            dispatchId="dispatch-selected"
            runningDispatchIds={["dispatch-selected"]}
            onStop={onStop}
            onStopAll={vi.fn()}
          />
        </div>,
      ),
    );
    act(() => button("Stop").click());
    expect(onStop).toHaveBeenCalledOnce();
    expect(parentClick).not.toHaveBeenCalled();
  });
});
