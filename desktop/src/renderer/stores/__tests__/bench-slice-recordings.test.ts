/**
 * Targeted member-recording store action. The main process owns the temporary
 * merge reconstruction and every durable Git mutation; the store only forwards,
 * refreshes its read model, and preserves the outcome for callers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../rendererLogger", () => ({
  rInfo: vi.fn(),
  rDebug: vi.fn(),
  rWarn: vi.fn(),
  rError: vi.fn(),
  rTrace: vi.fn(),
}));

import { createBenchSlice } from "../slices/bench-slice";
import type { State } from "../session-store-types";

const REPO = "/repo";
const BRANCH = "main";

function harness(
  result: {
    ok: boolean;
    forgottenCount: number;
    branchesWithNothingToForget: string[];
  } = { ok: true, forgottenCount: 1, branchesWithNothingToForget: [] },
) {
  let state: Record<string, unknown> = {
    benchRetired: new Map(),
    benchWorkspaces: new Map(),
    benchSourceTips: new Map(),
  };
  const set = (
    fn: (current: Record<string, unknown>) => Record<string, unknown>,
  ): void => {
    state = { ...state, ...fn(state) };
  };
  const get = (): Record<string, unknown> => state;
  const refreshBench = vi.fn(async () => {});
  const benchDiscardMemberRecordings = vi.fn(async () => result);
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    ion: { benchDiscardMemberRecordings },
  };
  const slice = createBenchSlice(
    set as unknown as Parameters<typeof createBenchSlice>[0],
    get as unknown as Parameters<typeof createBenchSlice>[1],
  ) as Partial<State>;
  state = { ...state, ...slice, refreshBench };
  return { slice, refreshBench, benchDiscardMemberRecordings, result };
}

beforeEach(() => vi.clearAllMocks());

describe("benchDiscardMemberRecordings", () => {
  it("forwards exact selected identity, refreshes, and returns recovery outcome", async () => {
    const h = harness();
    const result = await h.slice.benchDiscardMemberRecordings!(REPO, BRANCH, [
      "wt/a",
    ]);

    expect(h.benchDiscardMemberRecordings).toHaveBeenCalledWith(REPO, BRANCH, [
      "wt/a",
    ]);
    expect(h.refreshBench).toHaveBeenCalledWith(REPO);
    expect(result).toBe(h.result);
  });

  it("refreshes after a no-match result without converting it into failure", async () => {
    const h = harness({
      ok: true,
      forgottenCount: 0,
      branchesWithNothingToForget: ["wt/a"],
    });
    await expect(
      h.slice.benchDiscardMemberRecordings!(REPO, BRANCH, ["wt/a"]),
    ).resolves.toMatchObject({
      ok: true,
      branchesWithNothingToForget: ["wt/a"],
    });
    expect(h.refreshBench).toHaveBeenCalledWith(REPO);
  });
});
