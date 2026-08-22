import { describe, it, expect, beforeEach } from "vitest";
import {
  STUDIO_EVENT_TYPES,
  STUDIO_EVENT_RING_CAP,
  studioWantsEvent,
  updateStudioCache,
  getStudioState,
  evictStudioTab,
  clearStudioCache,
  resolveStudioPermission,
} from "../studio-state-cache";
import type { NormalizedEvent } from "../../shared/types";
import type { AgentStateUpdate } from "../../shared/types-engine";

function agent(name: string): AgentStateUpdate {
  return { name, status: "running", metadata: {} } as AgentStateUpdate;
}

function agentStateEvent(agents: AgentStateUpdate[]): NormalizedEvent {
  return { type: "agent_state", agents } as NormalizedEvent;
}

function dispatchStart(id: string): NormalizedEvent {
  return {
    type: "dispatch_start",
    dispatchAgent: "dev-lead",
    dispatchTask: "task",
    dispatchModel: "m",
    dispatchSessionId: "s",
    dispatchDepth: 1,
    dispatchParentId: "",
    dispatchId: id,
  } as NormalizedEvent;
}

describe("studio-state-cache", () => {
  beforeEach(() => clearStudioCache());

  it("replaces agents wholesale on agent_state (snapshot semantics)", () => {
    updateStudioCache("tab1", agentStateEvent([agent("a"), agent("b")]));
    updateStudioCache("tab1", agentStateEvent([agent("c")]));
    const state = getStudioState("tab1");
    expect(state.agents.map((a) => a.name)).toEqual(["c"]);
  });

  it("normalizes compound keys to the bare tabId (no state splitting)", () => {
    updateStudioCache("tab1:instanceA", agentStateEvent([agent("a")]));
    updateStudioCache("tab1", dispatchStart("d1"));
    const state = getStudioState("tab1");
    expect(state.agents).toHaveLength(1);
    expect(state.events).toHaveLength(1);
    // Reads through a compound key hit the same entry.
    expect(getStudioState("tab1:instanceA").agents).toHaveLength(1);
  });

  it("caps the event ring and drops the oldest entries", () => {
    for (let i = 0; i < STUDIO_EVENT_RING_CAP + 25; i++) {
      updateStudioCache("tab1", dispatchStart(`d${i}`));
    }
    const state = getStudioState("tab1");
    expect(state.events).toHaveLength(STUDIO_EVENT_RING_CAP);
    const first = state.events[0] as { dispatchId: string };
    expect(first.dispatchId).toBe("d25");
  });

  it("stores the latest status fields snapshot", () => {
    updateStudioCache("tab1", {
      type: "status",
      fields: { state: "running" },
    } as NormalizedEvent);
    updateStudioCache("tab1", {
      type: "status",
      fields: { state: "idle" },
    } as NormalizedEvent);
    expect(getStudioState("tab1").statusFields).toEqual({ state: "idle" });
  });

  it("ignores event types outside the Studio window allowlist", () => {
    updateStudioCache("tab1", {
      type: "text_chunk",
      text: "x",
    } as unknown as NormalizedEvent);
    const state = getStudioState("tab1");
    expect(state.agents).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });

  it("evicts a tab (including via compound key)", () => {
    updateStudioCache("tab1", agentStateEvent([agent("a")]));
    evictStudioTab("tab1:whatever");
    expect(getStudioState("tab1").agents).toHaveLength(0);
  });

  it("allowlist covers exactly the Studio window-relevant event types", () => {
    expect([...STUDIO_EVENT_TYPES].sort()).toEqual([
      "agent_state",
      "background_task_complete",
      "dispatch_activity",
      "dispatch_end",
      "dispatch_start",
      "permission_request",
      "status",
    ]);
  });

  it("dispatch_activity: tool events pass the filter, text deltas do not, none ring-cache", () => {
    const base = {
      type: "dispatch_activity",
      dispatchAgentId: "da-1",
      dispatchConversationId: "c",
      dispatchSeq: 1,
    };
    const toolStart = {
      ...base,
      dispatchActivityKind: "tool_start",
      toolName: "Bash",
    } as unknown as NormalizedEvent;
    const text = {
      ...base,
      dispatchActivityKind: "text",
      dispatchTextDelta: "x",
    } as unknown as NormalizedEvent;
    expect(studioWantsEvent(toolStart)).toBe(true);
    expect(studioWantsEvent(text)).toBe(false);
    updateStudioCache("tab1", toolStart);
    expect(getStudioState("tab1").events).toHaveLength(0);
  });
});

describe("pending permissions (cross-surface reconcile)", () => {
  it("adds on permission_request, clears on clearing status, survives non-clearing", () => {
    const perm = {
      type: "permission_request",
      questionId: "q1",
      toolName: "Bash",
      options: [],
    } as unknown as NormalizedEvent;
    updateStudioCache("ptab", perm);
    expect(getStudioState("ptab").pendingPermissions).toHaveLength(1);
    updateStudioCache("ptab", {
      type: "status",
      fields: { state: "connecting" },
    } as unknown as NormalizedEvent);
    expect(getStudioState("ptab").pendingPermissions).toHaveLength(1);
    updateStudioCache("ptab", {
      type: "status",
      fields: { state: "running" },
    } as unknown as NormalizedEvent);
    expect(getStudioState("ptab").pendingPermissions).toHaveLength(0);
  });

  it("resolveStudioPermission removes by questionId, idempotently, and normalizes keys", () => {
    const perm = {
      type: "permission_request",
      questionId: "q2",
      toolName: "Bash",
      options: [],
    } as unknown as NormalizedEvent;
    updateStudioCache("rtab:instance-1", perm);
    expect(resolveStudioPermission("rtab", "q2")).toBe(true);
    expect(resolveStudioPermission("rtab", "q2")).toBe(false);
    expect(getStudioState("rtab").pendingPermissions).toHaveLength(0);
  });
});
