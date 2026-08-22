/**
 * dispatch-abort slice — stopping ONE background dispatch.
 *
 * The behavior that matters here is negative and cannot be seen from the
 * dispatch-abort call alone: stopping a dispatch must NOT abort the tab's run,
 * which is what separates this from `interrupt`. These pin the IPC actually
 * reached, so a future refactor that routes this through `engineAbort` (which
 * would kill the orchestrator) fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createDispatchAbortSlice } from "../slices/dispatch-abort-slice";

const mockEngineAbortDispatch = vi.fn().mockResolvedValue(undefined);
const mockEngineAbort = vi.fn().mockResolvedValue(undefined);;

beforeEach(() => {
  mockEngineAbortDispatch.mockClear();
  mockEngineAbort.mockClear();;
  (globalThis as any).window = {
    ...(globalThis as any).window,
    ion: {
      engineAbortDispatch: mockEngineAbortDispatch,
      engineAbort: mockEngineAbort,
    },
  };
});

function harness(tabs: Array<{ id: string }>) {
  const state: any = { tabs };
  const get = () => state;
  const set = (fn: any) =>
    Object.assign(state, typeof fn === "function" ? fn(state) : fn);
  Object.assign(state, createDispatchAbortSlice(set as any, get as any));
  return state;
}

describe("abortDispatch", () => {
  it("addresses the engine by tab and dispatch id", () => {
    const state = harness([{ id: "tab1" }]);
    state.abortDispatch("tab1", "dispatch-code-reviewer-123-abc");
    expect(mockEngineAbortDispatch).toHaveBeenCalledWith(
      "tab1",
      "dispatch-code-reviewer-123-abc",
    );
  });

  // The whole point of the verb: the orchestrator survives. If this ever routes
  // through engineAbort, stopping one rogue agent would kill the conversation.
  it("does not abort the run or reap the subtree", () => {
    const state = harness([{ id: "tab1" }]);
    state.abortDispatch("tab1", "dispatch-a");
    expect(mockEngineAbort).not.toHaveBeenCalled();
  });

  it("is a no-op for an unknown tab", () => {
    const state = harness([{ id: "tab1" }]);
    state.abortDispatch("ghost", "dispatch-a");
    expect(mockEngineAbortDispatch).not.toHaveBeenCalled();
  });

  it("refuses an empty dispatch id rather than addressing nothing", () => {
    const state = harness([{ id: "tab1" }]);
    state.abortDispatch("tab1", "");
    expect(mockEngineAbortDispatch).not.toHaveBeenCalled();
  });

  it("stops every unique dispatch ID in one row without aborting the run", () => {
    const state = harness([{ id: "tab1" }]);
    state.abortDispatches("tab1", [
      "dispatch-a",
      "dispatch-b",
      "dispatch-a",
      "",
    ]);
    expect(mockEngineAbortDispatch.mock.calls).toEqual([
      ["tab1", "dispatch-a"],
      ["tab1", "dispatch-b"],
    ]);
    expect(mockEngineAbort).not.toHaveBeenCalled();
  });

  it("refuses row stop-all with no dispatch IDs", () => {
    const state = harness([{ id: "tab1" }]);
    state.abortDispatches("tab1", []);
    expect(mockEngineAbortDispatch).not.toHaveBeenCalled();
  });

  it("survives a rejected IPC without throwing", async () => {
    mockEngineAbortDispatch.mockRejectedValueOnce(new Error("socket down"));
    const state = harness([{ id: "tab1" }]);
    expect(() => state.abortDispatch("tab1", "dispatch-a")).not.toThrow();
    await Promise.resolve();
  });
});
