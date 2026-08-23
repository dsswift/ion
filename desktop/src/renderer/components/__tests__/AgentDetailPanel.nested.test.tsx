// @vitest-environment jsdom
//
// Nested-dispatch tests for AgentDetailPanel, split from AgentDetailPanel.test.tsx
// to stay under the file-size cap. This file covers the DURABLE-source child
// sourcing (agent-state pills vs one-shot dispatchTelemetry) and the drilled-in
// header meta resolution. The mock block mirrors AgentDetailPanel.test.tsx —
// vi.mock calls are file-scoped and hoisted, so each test file carries its own.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentStateUpdate } from "../../../shared/types";
import type { DispatchTelemetryEntry } from "../../../shared/types-engine";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// ── Mocks ──

vi.mock("../../theme", () => ({
  useColors: () => new Proxy({}, { get: () => "#000" }),
}));

vi.mock("../../preferences", () => ({
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ unifiedTurnView: false, agentPanelDefaultOpen: false }),
}));

const mockGetConversation = vi.fn();
(globalThis as any).window = globalThis.window ?? {};
(globalThis as any).window.ion = { getConversation: mockGetConversation };

vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      agentDetailGeometry: { x: 60, y: 80, w: 600, h: 500 },
      setAgentDetailGeometry: vi.fn(),
      incOpenFloatingPanelCount: vi.fn(),
      decOpenFloatingPanelCount: vi.fn(),
      dispatchActivity: {},
    }),
}));

// Mock FloatingPanel as a passthrough
vi.mock("../FloatingPanel", () => ({
  FloatingPanel: ({ children, title }: any) =>
    React.createElement(
      "div",
      { "data-testid": "floating-panel", "data-title": title },
      children,
    ),
}));

const dispatchStopProps: Array<Record<string, unknown>> = [];
vi.mock("../DispatchStopControl", () => ({
  DispatchStopControl: (props: Record<string, unknown>) => {
    dispatchStopProps.push(props);
    return React.createElement(
      "button",
      { "data-testid": `dispatch-stop-${String(props.dispatchId)}` },
      "Stop",
    );
  },
}));

// Mock Transcript to emit one drill-in button per child agent.
vi.mock("../conversation/Transcript", () => ({
  Transcript: ({ messages, pinnedPrompt, onOpenDispatch, agents }: any) =>
    React.createElement(
      "div",
      { "data-testid": "transcript" },
      pinnedPrompt &&
        React.createElement(
          "div",
          { "data-testid": "pinned-prompt" },
          pinnedPrompt,
        ),
      React.createElement("div", null, `${messages?.length ?? 0} messages`),
      agents?.map((a: any, i: number) =>
        React.createElement(
          "button",
          {
            key: i,
            "data-testid": `open-child-${a.name}`,
            onClick: () => {
              const dispatch = a.metadata?.dispatches?.[0];
              if (dispatch && onOpenDispatch) onOpenDispatch(dispatch, a);
            },
          },
          a.name,
        ),
      ),
    ),
}));

vi.mock("../agent-conversation-mapper", () => ({
  mapConversationMessages: (msgs: any[]) =>
    msgs.map((m: any, i: number) => ({
      id: `mapped-${i}`,
      role: m.role || "assistant",
      content: m.content || "",
      timestamp: 0,
    })),
}));

import { AgentDetailPanel } from "../AgentDetailPanel";
import type { BreadcrumbFrame } from "../agent-panel-helpers";

function makeAgent(name: string): AgentStateUpdate {
  return { name, status: "done", metadata: { displayName: name } };
}

function makeDispatch(
  id: string,
  conversationId: string,
  model = "claude-sonnet-4-20250514",
  elapsed = 10,
) {
  return { id, task: "test", model, conversationId, status: "done", elapsed };
}

function entry(
  overrides: Partial<DispatchTelemetryEntry>,
): DispatchTelemetryEntry {
  return {
    dispatchAgent: "agent",
    dispatchSessionId: "ss",
    dispatchModel: "claude-sonnet-4-20250514",
    dispatchTask: "task",
    dispatchDepth: 0,
    dispatchParentId: "",
    dispatchId: "did",
    ...overrides,
  };
}

function renderPanel(props: Parameters<typeof AgentDetailPanel>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(AgentDetailPanel, props));
  });
  return {
    container,
    unmount() {
      act(() => {
        root.unmount();
      });
      document.body.removeChild(container);
    },
  };
}

// Build an agent-state pill carrying the same nesting attribution the engine
// stamps (dispatchParentId + a dispatches[] entry). This survives
// engine_agent_state heartbeat replay, unlike the dispatchTelemetry stream.
function makeChildPill(
  name: string,
  parentDispatchId: string,
  dispatchId: string,
  conversationId: string,
  visibility?: string,
  status: AgentStateUpdate["status"] = "done",
  model = "m",
): AgentStateUpdate {
  return {
    name,
    status,
    metadata: {
      displayName: name,
      ...(visibility ? { visibility } : {}),
      dispatchParentId: parentDispatchId,
      dispatchDepth: 2,
      dispatches: [
        {
          id: dispatchId,
          task: "t",
          model,
          conversationId,
          status,
          elapsed: 5,
        },
      ],
    },
  };
}

describe("AgentDetailPanel nested dispatches", () => {
  beforeEach(() => {
    dispatchStopProps.length = 0;
    mockGetConversation.mockReset();
    mockGetConversation.mockResolvedValue({
      messages: [
        { role: "user", content: "Do this task" },
        { role: "assistant", content: "Done" },
      ],
    });
  });

  // ── Durable-source regression: nested child renders from agent-state even
  //    when the one-shot dispatchTelemetry was never observed (late attach).

  it("renders nested child from agent-state when dispatchTelemetry is EMPTY (late-attach regression)", () => {
    // The exact failed scenario: the dev-lead's preview is opened on a dispatch
    // whose engine-dev child completed before the desktop saw the live
    // dispatch_start. dispatchTelemetry is empty; only the durable agent-state
    // pill survives (heartbeat-replayed). engine-dev must still render.
    const engineDevPill = makeChildPill("engine-dev", "d1", "d2", "conv-2");

    const { container, unmount } = renderPanel({
      agent: makeAgent("dev-lead"),
      loadedMessages: [
        { id: "u1", role: "user", content: "Root msg", timestamp: 0 },
      ],
      loading: false,
      dispatches: [makeDispatch("d1", "conv-1")],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: [], // one-shot stream missed entirely
      allAgents: [makeAgent("dev-lead"), engineDevPill],
    });

    // engine-dev renders as a child row (the mocked Transcript emits one button
    // per agent in `agents`). Reverting to telemetry-only sourcing makes this
    // button absent -> red.
    const childBtn = container.querySelector(
      '[data-testid="open-child-engine-dev"]',
    );
    expect(childBtn).toBeTruthy();
    expect(container.textContent).toContain("engine-dev");
    unmount();
  });

  it("renders an ephemeral, done child (visibility is ignored for nested dispatches)", () => {
    // Nested dispatches must always show regardless of visibility metadata. A
    // done + ephemeral child would be filtered by the top-level visibility
    // rule, but the sub-dispatch panel bypasses it and sources from agent-state.
    const ephemeralChild = makeChildPill(
      "engine-dev",
      "d1",
      "d2",
      "conv-2",
      "ephemeral",
      "done",
    );

    const { container, unmount } = renderPanel({
      agent: makeAgent("dev-lead"),
      loadedMessages: [
        { id: "u1", role: "user", content: "Root msg", timestamp: 0 },
      ],
      loading: false,
      dispatches: [makeDispatch("d1", "conv-1")],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: [],
      allAgents: [makeAgent("dev-lead"), ephemeralChild],
    });

    expect(
      container.querySelector('[data-testid="open-child-engine-dev"]'),
    ).toBeTruthy();
    unmount();
  });

  it("does not duplicate a child present in both agent-state and telemetry (union by dispatch id)", () => {
    // The live path can deliver both a dispatch_start (telemetry) and an
    // agent-state pill for the same child. The rendered set must contain ONE
    // engine-dev row (agent-state wins), not two.
    const engineDevPill = makeChildPill("engine-dev", "d1", "d2", "conv-2");

    const { container, unmount } = renderPanel({
      agent: makeAgent("dev-lead"),
      loadedMessages: [
        { id: "u1", role: "user", content: "Root msg", timestamp: 0 },
      ],
      loading: false,
      dispatches: [makeDispatch("d1", "conv-1")],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: [
        entry({
          dispatchId: "d2",
          dispatchParentId: "d1",
          dispatchAgent: "engine-dev",
          conversationId: "conv-2",
        }),
      ],
      allAgents: [makeAgent("dev-lead"), engineDevPill],
    });

    const childButtons = container.querySelectorAll(
      '[data-testid="open-child-engine-dev"]',
    );
    expect(childButtons.length).toBe(1);
    unmount();
  });

  // ── Drilled-in header meta regression: the child frame's Model/Duration row
  //    must reflect the CHILD dispatch, never the parent's (the "Sonnet
  //    specialist labeled with the dev-lead's Opus id" bug).

  it("shows the child dispatch's model from the durable pill when telemetry is empty (parent-model leak regression)", () => {
    // The exact failed scenario: dev-lead (Opus) dispatched ios-dev (Sonnet);
    // the one-shot dispatch_start telemetry was missed (late attach / tab
    // reopen), only the heartbeat-replayed agent-state pill survives. Drilling
    // into ios-dev must show the pill's Sonnet id — falling back to the root
    // frame's dispatch shows the dev-lead's Opus id and duration -> red.
    const iosDevPill = makeChildPill(
      "ios-dev",
      "d1",
      "d2",
      "conv-2",
      undefined,
      "running",
      "claude-sonnet-4-6",
    );

    const { container, unmount } = renderPanel({
      agent: makeAgent("dev-lead"),
      loadedMessages: [
        { id: "u1", role: "user", content: "Root msg", timestamp: 0 },
      ],
      loading: false,
      dispatches: [makeDispatch("d1", "conv-1", "claude-opus-4-8", 68)],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: [], // one-shot stream missed entirely
      allAgents: [makeAgent("dev-lead"), iosDevPill],
    });

    const childBtn = container.querySelector(
      '[data-testid="open-child-ios-dev"]',
    ) as HTMLButtonElement;
    expect(childBtn).toBeTruthy();
    act(() => {
      childBtn.click();
    });

    const text = container.textContent || "";
    expect(text).toContain("claude-sonnet-4-6");
    expect(text).not.toContain("claude-opus-4-8");
    unmount();
  });

  it("puts the Stop corner on the drilled-into child and preserves owning tab", () => {
    const child = makeChildPill(
      "ios-dev",
      "d1",
      "d2",
      "conv-2",
      undefined,
      "running",
    );
    const { container, unmount } = renderPanel({
      agent: makeAgent("dev-lead"),
      loadedMessages: [
        { id: "u1", role: "user", content: "Root msg", timestamp: 0 },
      ],
      loading: false,
      dispatches: [makeDispatch("d1", "conv-1", "parent-model", 20)],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: [],
      allAgents: [makeAgent("dev-lead"), child],
      tabId: "tab-owning-tree",
    });

    const childBtn = container.querySelector(
      '[data-testid="open-child-ios-dev"]',
    ) as HTMLButtonElement;
    act(() => {
      childBtn.click();
    });

    const childControl = dispatchStopProps.at(-1);
    expect(childControl?.dispatchId).toBe("d2");
    expect(childControl?.runningDispatchIds).toEqual(["d2"]);
    expect(
      container.querySelector('[data-testid="dispatch-stop-d2"]'),
    ).toBeTruthy();
    unmount();
  });

  it("shows the child dispatch's model from telemetry when no pill owns the dispatch yet", () => {
    // Live path: dispatch_start arrived but the child's first agent-state
    // snapshot has not landed. The telemetry stub supplies the meta row.
    const telemetry: DispatchTelemetryEntry[] = [
      entry({
        dispatchId: "d2",
        dispatchParentId: "d1",
        dispatchAgent: "ios-dev",
        conversationId: "conv-2",
        dispatchModel: "claude-sonnet-4-6",
      }),
    ];

    const { container, unmount } = renderPanel({
      agent: makeAgent("dev-lead"),
      loadedMessages: [
        { id: "u1", role: "user", content: "Root msg", timestamp: 0 },
      ],
      loading: false,
      dispatches: [makeDispatch("d1", "conv-1", "claude-opus-4-8", 68)],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: telemetry,
      allAgents: [makeAgent("dev-lead")],
    });

    const childBtn = container.querySelector(
      '[data-testid="open-child-ios-dev"]',
    ) as HTMLButtonElement;
    expect(childBtn).toBeTruthy();
    act(() => {
      childBtn.click();
    });

    const text = container.textContent || "";
    expect(text).toContain("claude-sonnet-4-6");
    expect(text).not.toContain("claude-opus-4-8");
    unmount();
  });

  it("renders no meta row for a drilled-in dispatch neither pills nor telemetry know", () => {
    // Deep-link entry to a child frame with no durable pill and no telemetry:
    // the header must omit the Model/Duration row entirely rather than borrow
    // the parent frame's dispatch meta.
    const initialStack: BreadcrumbFrame[] = [
      {
        dispatchId: "d1",
        conversationId: "conv-1",
        agentDisplayName: "dev-lead",
      },
      {
        dispatchId: "d-unknown",
        conversationId: "conv-x",
        agentDisplayName: "ios-dev",
      },
    ];

    const { container, unmount } = renderPanel({
      agent: makeAgent("dev-lead"),
      loadedMessages: [
        { id: "u1", role: "user", content: "Root msg", timestamp: 0 },
      ],
      loading: false,
      dispatches: [makeDispatch("d1", "conv-1", "claude-opus-4-8", 68)],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      onClose: () => {},
      dispatchTelemetry: [],
      allAgents: [makeAgent("dev-lead")],
      initialStack,
    });

    const text = container.textContent || "";
    expect(text).not.toContain("Model:");
    expect(text).not.toContain("claude-opus-4-8");
    unmount();
  });
});
