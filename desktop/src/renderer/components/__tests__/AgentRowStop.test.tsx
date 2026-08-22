// @vitest-environment jsdom
/**
 * AgentRow dispatch Stop mounting.
 *
 * Regression pin for the reported UI gap: rows showed running status dots but
 * no Stop control. This test asserts the row itself mounts the shared control
 * with every running instance ID, not merely that the control works in
 * isolation.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStateUpdate } from "../../../shared/types";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const stopProps: Array<Record<string, unknown>> = [];
vi.mock("../DispatchStopControl", () => ({
  DispatchStopControl: (props: Record<string, unknown>) => {
    stopProps.push(props);
    return <button data-testid="row-stop">Stop</button>;
  },
}));
vi.mock("../AgentExpandedView", () => ({
  AgentExpandedView: () => null,
  DurationDisplay: () => null,
}));
vi.mock("@phosphor-icons/react", () => ({
  Diamond: () => null,
  CaretRight: () => null,
  StarFour: () => null,
  Square: () => null,
  Triangle: () => null,
  Heart: () => null,
  Hexagon: () => null,
  Lightning: () => null,
  Terminal: () => null,
  DeviceMobile: () => null,
  Monitor: () => null,
  Gear: () => null,
}));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));
vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      abortDispatch: vi.fn(),
      abortDispatches: vi.fn(),
    }),
}));

import { AgentRow } from "../AgentRow";

const colors = new Proxy({}, { get: () => "#000000" }) as Parameters<
  typeof AgentRow
>[0]["colors"];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  stopProps.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function agent(
  dispatches: Array<{ id: string; status: string }>,
  status: AgentStateUpdate["status"] = "running",
): AgentStateUpdate {
  return {
    name: "dev-lead",
    status,
    metadata: {
      displayName: "Dev Lead",
      dispatches: dispatches.map((dispatch) => ({
        ...dispatch,
        task: "task",
        model: "model",
        conversationId: `conv-${dispatch.id}`,
      })),
    },
  };
}

function renderRow(value: AgentStateUpdate, dispIdx: number) {
  const dispatches = (value.metadata?.dispatches ?? []) as Parameters<
    typeof AgentRow
  >[0]["dispatches"];
  act(() =>
    root.render(
      <AgentRow
        agent={value}
        allAgents={[value]}
        colors={colors}
        dispatches={dispatches}
        dispIdx={dispIdx}
        nestIndent={0}
        tabId="tab-tree"
        onToggle={vi.fn()}
      />,
    ),
  );
}

describe("AgentRow Stop control", () => {
  it("mounts Stop on a running row with the selected dispatch id", () => {
    renderRow(agent([{ id: "d1", status: "running" }]), 0);
    expect(container.querySelector('[data-testid="row-stop"]')).toBeTruthy();
    expect(stopProps.at(-1)?.dispatchId).toBe("d1");
    expect(stopProps.at(-1)?.runningDispatchIds).toEqual(["d1"]);
  });

  it("passes every running instance in this row to Stop all", () => {
    renderRow(
      agent([
        { id: "d1", status: "running" },
        { id: "d2", status: "done" },
        { id: "d3", status: "running" },
      ]),
      0,
    );
    expect(stopProps.at(-1)?.runningDispatchIds).toEqual(["d1", "d3"]);
  });

  it("uses latest running instance when pager selection is completed", () => {
    renderRow(
      agent([
        { id: "d1", status: "done" },
        { id: "d2", status: "running" },
      ]),
      0,
    );
    expect(stopProps.at(-1)?.dispatchId).toBe("d2");
  });

  it("does not mount Stop when every dispatch is terminal", () => {
    renderRow(agent([{ id: "d1", status: "done" }], "done"), 0);
    expect(container.querySelector('[data-testid="row-stop"]')).toBeNull();
  });
});
