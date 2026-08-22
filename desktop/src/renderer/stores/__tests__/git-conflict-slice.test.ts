/**
 * Git conflict slice — the visibility layer for failed syncs.
 *
 * The defect these pin: a conflicted sync returned
 * `{ ok: false, hasConflicts: true, error: <actionable message> }` and every
 * consumer discarded it. The operator pressed Sync, saw nothing, and believed
 * it succeeded while the worktree sat mid-rebase. These tests assert the
 * signal becomes state, and that the AI-assist action sends its exact prompt.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../rendererLogger", () => ({
  rInfo: vi.fn(),
  rDebug: vi.fn(),
  rWarn: vi.fn(),
  rError: vi.fn(),
  rTrace: vi.fn(),
}));

// This file imports the worktree-inventory slice (for the refresh-driven alert
// lifecycle below), and that slice reads the aiGeneratedTitles preference. The
// real preferences module applies the theme at import time, which touches
// `document` — absent in this node-environment test, and the resulting
// ReferenceError silently reduced the whole file to "no tests" rather than
// failing a single assertion. Same mock, same reason, as
// worktree-inventory-slice.test.ts.
const preferenceState = {
  aiGeneratedTitles: false,
  aiAssistPromptOverrides: {} as Record<string, string>,
};
vi.mock("../../preferences", () => ({
  usePreferencesStore: { getState: () => preferenceState },
}));

const applyPermissionModeForTab = vi.fn();
vi.mock("../slices/tab-slice-permission-mode", () => ({
  applyPermissionModeForTab: (...args: unknown[]) =>
    applyPermissionModeForTab(...args),
}));

import {
  createGitConflictSlice,
  conflictAssistPrompt,
} from "../slices/git-conflict-slice";
import { CONFLICT_ASSIST_TIER } from "../../../shared/types-model-tiers";
import { createWorktreeInventorySlice } from "../slices/worktree-inventory-slice";
import { clearInflight } from "../slices/conflict-assist-dedupe";
import type { State, GitConflictAlert } from "../session-store-types";

const WT = "/home/dev/.ion/worktrees/proj-a1";

interface Harness {
  slice: Partial<State>;
  state: () => Record<string, unknown>;
  alerts: () => Map<string, GitConflictAlert>;
}

function harness(extra: Record<string, unknown> = {}): Harness {
  let state: Record<string, unknown> = {
    gitConflictAlerts: new Map<string, GitConflictAlert>(),
    worktreeInventory: new Map(),
    // The assist resolves bench-ness from these records, so every harness needs
    // them present — empty means "no bench", the worktree-rebase case.
    benchWorkspaces: new Map(),
    tabs: [],
    activeTabId: null,
    ...extra,
  };
  const set = (
    fn: (s: Record<string, unknown>) => Record<string, unknown>,
  ): void => {
    state = { ...state, ...fn(state) };
  };
  const get = (): Record<string, unknown> => state;
  const slice = {
    ...createGitConflictSlice(
      set as unknown as Parameters<typeof createGitConflictSlice>[0],
      get as unknown as Parameters<typeof createGitConflictSlice>[1],
    ),
    ...createWorktreeInventorySlice(
      set as unknown as Parameters<typeof createWorktreeInventorySlice>[0],
      get as unknown as Parameters<typeof createWorktreeInventorySlice>[1],
    ),
  } as Partial<State>;
  state = { ...state, ...slice, ...extra };
  return {
    slice,
    state: () => state,
    alerts: () => state.gitConflictAlerts as Map<string, GitConflictAlert>,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  preferenceState.aiAssistPromptOverrides = {};
  clearInflight(WT);
  clearInflight("/bench/other");
});

function configureAssistIon(): void {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    ion: {
      resolveModelTier: vi.fn().mockResolvedValue({
        tier: CONFLICT_ASSIST_TIER,
        model: "prov/claude-sonnet-4-6",
        fallbacks: [],
        configured: true,
      }),
    },
  };
}

describe("sync and inventory conflict state", () => {
  const entry = (
    operationState?: "rebasing" | "merging" | "cherry-picking",
  ) => ({
    worktreePath: WT,
    branchName: "wt/a1",
    label: "proj-a1",
    sourceBranch: "josh",
    head: "abc",
    lastCommitSubject: "x",
    isDirty: false,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: false,
    operationState,
  });

  it("records a failed sync conflict immediately for the Git panel resolver", async () => {
    const h = harness();
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: {
        gitWorktreeSync: vi
          .fn()
          .mockResolvedValue({ ok: false, hasConflicts: true }),
        gitWorktreeInventory: vi.fn().mockResolvedValue({ worktrees: [] }),
      },
    };

    await h.slice.syncWorktree!(WT, "josh", "/repo");

    expect(h.alerts().get(WT)).toMatchObject({
      operationState: "rebasing",
      label: "proj-a1",
      dismissed: false,
    });
    expect(h.alerts().get(WT)?.recordedAt).toEqual(expect.any(Number));
  });

  it("does not create conflict state for a dirty sync refusal", async () => {
    const h = harness();
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: {
        gitWorktreeSync: vi.fn().mockResolvedValue({
          ok: false,
          refusedDirty: true,
          error: "uncommitted changes",
        }),
        gitWorktreeInventory: vi.fn().mockResolvedValue({ worktrees: [] }),
      },
    };

    await h.slice.syncWorktree!(WT, "josh", "/repo");

    expect(h.alerts().has(WT)).toBe(false);
  });

  it("records an in-progress operation found by inventory refresh", async () => {
    const h = harness();
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: {
        gitWorktreeInventory: vi
          .fn()
          .mockResolvedValue({ worktrees: [entry("merging")] }),
      },
    };

    await h.slice.refreshWorktreeInventory!("/repo");

    expect(h.alerts().get(WT)).toMatchObject({
      operationState: "merging",
      label: "proj-a1",
      dismissed: false,
    });
    expect(h.alerts().get(WT)?.recordedAt).toEqual(expect.any(Number));
  });

  it("clears conflict state when inventory reports operation completed", async () => {
    const h = harness();
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: {
        gitWorktreeInventory: vi
          .fn()
          .mockResolvedValue({ worktrees: [entry("rebasing")] }),
      },
    };
    await h.slice.refreshWorktreeInventory!("/repo");
    expect(h.alerts().has(WT)).toBe(true);

    (
      globalThis as unknown as { window: { ion: Record<string, unknown> } }
    ).window.ion.gitWorktreeInventory = vi
      .fn()
      .mockResolvedValue({ worktrees: [entry()] });
    await h.slice.refreshWorktreeInventory!("/repo");

    expect(h.alerts().has(WT)).toBe(false);
  });

  it("clears a resolved repo-root land conflict outside worktree inventory", async () => {
    const h = harness();
    h.slice.recordConflictAlert!("/repo", {
      source: "land",
      operationState: "merging",
      label: "repo",
    });
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: {
        gitWorktreeInventory: vi.fn().mockResolvedValue({ worktrees: [] }),
        gitOpState: vi.fn().mockResolvedValue({ ok: true, state: null }),
      },
    };

    await h.slice.refreshWorktreeInventory!("/repo");

    expect(window.ion.gitOpState).toHaveBeenCalledWith("/repo");
    expect(h.alerts().has("/repo")).toBe(false);
  });
});

/**
 * A failed LAND must record conflict state at checkout where merge stopped.
 *
 * Regression direction: removing the `recordConflictAlert` call from
 * WorktreeRowMenu.doLand turns these red. They exercise same store action used
 * by component.
 */
describe("a failed land records conflict state", () => {
  const HOLDER = "/repo";

  it("keys state on holder checkout where merge conflicted", () => {
    const h = harness();

    h.slice.recordConflictAlert!(HOLDER, {
      source: "land",
      operationState: "merging",
      label: "repo",
    });

    expect(h.alerts().get(HOLDER)).toMatchObject({
      operationState: "merging",
      label: "repo",
      dismissed: false,
    });
    expect(h.alerts().get(HOLDER)?.recordedAt).toEqual(expect.any(Number));
    expect(h.alerts().has(WT)).toBe(false);
  });

  it("keys a pre-sync land conflict on worktree where it happened", () => {
    const h = harness();

    h.slice.recordConflictAlert!(WT, {
      source: "land",
      operationState: "rebasing",
      label: "proj-a1",
    });

    expect(h.alerts().get(WT)?.operationState).toBe("rebasing");
    expect(h.alerts().has(HOLDER)).toBe(false);
  });
});

/**
 * The bench arm of the assist prompt.
 *
 * The tools exist and are offered only in a bench, so the prompt names them only
 * there. Worth stating rather than trusting discovery: the measured failure was
 * an agent that HAD attribution, used it once, and then read one file out of
 * eight sibling worktrees by hand anyway.
 */
describe("conflictAssistPrompt — bench arm", () => {
  it("names all three bench tools when the conflict is in a bench", () => {
    const prompt = conflictAssistPrompt("merging", true);
    for (const tool of [
      "BenchResolutionHistory",
      "BenchMemberFile",
      "WorkspaceAttribution",
    ]) {
      expect(prompt).toContain(tool);
    }
  });

  it("tells the model to consult history BEFORE reasoning about the merge", () => {
    // Order is the point: consulting prior decisions after resolving is the
    // expensive path this exists to remove.
    const prompt = conflictAssistPrompt("merging", true);
    expect(prompt).toMatch(
      /Before reasoning about the merge, call BenchResolutionHistory/,
    );
  });

  it("warns against reading a member worktree directly, and says why", () => {
    const prompt = conflictAssistPrompt("merging", true);
    expect(prompt).toContain("rather than opening a member worktree directly");
    expect(prompt).toContain("work done since its pin");
  });

  it("names no bench tool for a worktree rebase, which is not offered them", () => {
    const prompt = conflictAssistPrompt("rebasing", false);
    for (const tool of [
      "BenchResolutionHistory",
      "BenchMemberFile",
      "WorkspaceAttribution",
    ]) {
      expect(prompt).not.toContain(tool);
    }
  });

  it("defaults to the non-bench wording, so an un-updated caller cannot mislead", () => {
    expect(conflictAssistPrompt("rebasing")).toBe(
      conflictAssistPrompt("rebasing", false),
    );
  });

  it("keeps every hard constraint in both arms", () => {
    // Each was added for a recorded defect: an aborted operation, a --continue
    // bundled with other work, a resolution left merely staged.
    for (const prompt of [
      conflictAssistPrompt("merging", true),
      conflictAssistPrompt("merging", false),
    ]) {
      expect(prompt).toContain("Do not abort the merge");
      expect(prompt).toContain("Do not combine continue with");
      expect(prompt).toContain(
        "standalone call containing only git merge --continue",
      );
      expect(prompt).toContain("no unmerged paths");
    }
  });
});

describe("openConflictAssist — resolves bench-ness from the records", () => {
  it("sends the bench prompt when the directory is a registered bench", async () => {
    configureAssistIon();
    const submit = vi.fn();
    const h = harness({
      submit,
      setTabAutomaticModel: vi.fn(),
      createTabInDirectory: vi.fn(async () => "tab-new"),
      tabs: [{ id: "tab-new", inputLocked: false }],
      benchWorkspaces: new Map([
        ["/repo", [{ benchPath: "/bench/josh", sourceBranch: "josh" }]],
      ]),
    });
    (
      globalThis as unknown as { window: { ion: Record<string, unknown> } }
    ).window.ion.gitOpState = vi.fn(async () => ({
      ok: true,
      state: "merging",
    }));

    await h.slice.openConflictAssist!("/bench/josh");

    expect(submit.mock.calls[0][1]).toContain("BenchResolutionHistory");
  });

  it("sends the plain prompt for a worktree, even mid-merge", async () => {
    configureAssistIon();
    const submit = vi.fn();
    const h = harness({
      submit,
      setTabAutomaticModel: vi.fn(),
      createTabInDirectory: vi.fn(async () => "tab-new"),
      tabs: [{ id: "tab-new", inputLocked: false }],
      benchWorkspaces: new Map([
        ["/repo", [{ benchPath: "/bench/josh", sourceBranch: "josh" }]],
      ]),
    });
    (
      globalThis as unknown as { window: { ion: Record<string, unknown> } }
    ).window.ion.gitOpState = vi.fn(async () => ({
      ok: true,
      state: "merging",
    }));

    await h.slice.openConflictAssist!("/wt/mine");

    expect(submit.mock.calls[0][1]).not.toContain("BenchResolutionHistory");
  });
});
