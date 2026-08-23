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
  CONFLICT_ASSIST_PROMPT,
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

describe("openConflictAssist", () => {
  /** window.ion with a configured standard tier, overridable per test. */
  function ionWith(
    tier: Partial<{ model: string; configured: boolean }> = {},
  ): void {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: {
        resolveModelTier: vi.fn().mockResolvedValue({
          tier: CONFLICT_ASSIST_TIER,
          model: tier.model ?? "prov/claude-sonnet-4-6",
          fallbacks: [],
          configured: tier.configured ?? true,
        }),
      },
    };
  }

  it("uses only the configured workbench tier when available", async () => {
    const resolveModelTier = vi.fn(async (tier: string) => ({
      tier,
      model: "prov/fast",
      fallbacks: [],
      configured: tier === "workbench-sync",
    }));
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: { resolveModelTier },
    };
    const h = harness({
      submit: vi.fn(),
      setTabAutomaticModel: vi.fn(),
      createTabInDirectory: vi.fn().mockResolvedValue("tab-new"),
      tabs: [],
    });

    await h.slice.openConflictAssist!(WT);

    expect(resolveModelTier).toHaveBeenCalledTimes(1);
    expect(resolveModelTier).toHaveBeenCalledWith("workbench-sync");
  });

  it("falls back to standard when workbench tier is absent", async () => {
    const resolveModelTier = vi.fn(async (tier: string) => ({
      tier,
      model: tier === "standard" ? "prov/standard" : tier,
      fallbacks: [],
      configured: tier === "standard",
    }));
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: { resolveModelTier },
    };
    const setTabAutomaticModel = vi.fn();
    const h = harness({
      submit: vi.fn(),
      setTabAutomaticModel,
      createTabInDirectory: vi.fn().mockResolvedValue("tab-new"),
      tabs: [],
    });

    await h.slice.openConflictAssist!(WT);

    expect(resolveModelTier.mock.calls.map(([tier]) => tier)).toEqual([
      "workbench-sync",
      "standard",
    ]);
    expect(setTabAutomaticModel).toHaveBeenCalledWith(
      "tab-new",
      "prov/standard",
    );
  });

  it("uses an independent prompt override for the live operation", async () => {
    preferenceState.aiAssistPromptOverrides = {
      "rebase-resolution": "custom resolve {{directory}}",
    };
    ionWith();
    const submit = vi.fn();
    const h = harness({
      submit,
      setTabAutomaticModel: vi.fn(),
      createTabInDirectory: vi.fn().mockResolvedValue("tab-new"),
      tabs: [],
    });

    await h.slice.openConflictAssist!(WT);

    expect(submit).toHaveBeenCalledWith("tab-new", `custom resolve ${WT}`, {
      source: "machine",
    });
    preferenceState.aiAssistPromptOverrides = {};
  });

  it("creates a conversation in the directory and submits the exact prompt", async () => {
    ionWith();
    const submit = vi.fn();
    const setTabAutomaticModel = vi.fn();
    const createTabInDirectory = vi.fn().mockResolvedValue("tab-new");
    const h = harness({
      submit,
      setTabAutomaticModel,
      createTabInDirectory,
      tabs: [],
      activeTabId: null,
    });

    const tabId = await h.slice.openConflictAssist!(WT);

    expect(tabId).toBe("tab-new");
    expect(createTabInDirectory).toHaveBeenCalledWith(WT, false, true);
    const prompt = conflictAssistPrompt(null, false, WT);
    expect(submit).toHaveBeenCalledWith("tab-new", prompt, {
      source: "machine",
    });
    expect(CONFLICT_ASSIST_PROMPT).toBe(conflictAssistPrompt(null));
    expect(prompt).toContain("currently in-progress rebase");
    expect(prompt).toContain("Do not abort the rebase");
    expect(prompt).toContain(
      "separate standalone call containing only git rebase --continue",
    );
    expect(prompt).toContain("Done only when the operation has ended");
  });

  it("creates a FRESH conversation even when one already exists in the directory", async () => {
    // The regression this pins: the first version focused the existing
    // conversation and submitted there — interrupting the operator's live
    // development thread, whose context could also sway the rebase fix. The
    // assist must always get a bare conversation with no prior context.
    ionWith();
    const submit = vi.fn();
    const selectTab = vi.fn();
    const setTabAutomaticModel = vi.fn();
    const createTabInDirectory = vi.fn().mockResolvedValue("tab-fresh");
    const h = harness({
      submit,
      selectTab,
      setTabAutomaticModel,
      createTabInDirectory,
      tabs: [{ id: "tab-existing", workingDirectory: WT }],
      activeTabId: "tab-existing",
    });

    const tabId = await h.slice.openConflictAssist!(WT);

    expect(tabId).toBe("tab-fresh");
    expect(createTabInDirectory).toHaveBeenCalledWith(WT, false, true);
    // The existing conversation is untouched: not focused, nothing submitted.
    expect(selectTab).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalledWith(
      "tab-existing",
      CONFLICT_ASSIST_PROMPT,
    );
    expect(submit).toHaveBeenCalledWith(
      "tab-fresh",
      conflictAssistPrompt(null, false, WT),
      { source: "machine" },
    );
  });

  it("refuses with a remediation message when the standard tier is not configured", async () => {
    // The assist runs on the standard tier by specification — never the
    // operator's default (often a reasoning model), never highest/lowest.
    // No tier, no tab: the refusal must create nothing to clean up.
    ionWith({ configured: false });
    const submit = vi.fn();
    const createTabInDirectory = vi.fn();
    const h = harness({
      submit,
      createTabInDirectory,
      tabs: [],
      activeTabId: null,
    });

    await expect(h.slice.openConflictAssist!(WT)).rejects.toThrow(
      /workbench-sync.*standard.*Settings/s,
    );
    expect(createTabInDirectory).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("names the operation actually in progress: a merge gets the merge prompt", async () => {
    // The bench resolve-once flow leaves a MERGE in progress; telling the
    // model to fix a rebase that does not exist sent it hunting for the wrong
    // operation. The prompt is derived from the live op state.
    ionWith();
    (
      globalThis as unknown as { window: { ion: Record<string, unknown> } }
    ).window.ion.gitOpState = vi
      .fn()
      .mockResolvedValue({ ok: true, state: "merging" });
    const submit = vi.fn();
    const setTabAutomaticModel = vi.fn();
    const createTabInDirectory = vi.fn().mockResolvedValue("tab-new");
    const h = harness({
      submit,
      setTabAutomaticModel,
      createTabInDirectory,
      tabs: [],
      activeTabId: null,
    });

    await h.slice.openConflictAssist!(WT);

    const mergePrompt = conflictAssistPrompt("merging", false, WT);
    expect(submit).toHaveBeenCalledWith("tab-new", mergePrompt, {
      source: "machine",
    });
    expect(mergePrompt).toContain("currently in-progress merge");
    expect(mergePrompt).toContain("git merge --continue");
    expect(conflictAssistPrompt("cherry-picking")).toContain(
      "git cherry-pick --continue",
    );
    expect(conflictAssistPrompt(null)).toBe(CONFLICT_ASSIST_PROMPT);
  });

  it("locks + role-tags the conversation BEFORE the machine prompt is sent", async () => {
    // The fix conversation's entire instruction is the one machine-sent
    // prompt: locking prevents follow-ups from grafting an open-ended
    // conversation onto a checkout (often a bench) where development work
    // does not belong. Role + lock land atomically BEFORE submit() so a fast
    // completion cannot race ahead of the lifecycle tagging; the machine
    // prompt passes the lock via its 'machine' source.
    ionWith();
    let lockedAtSubmit: boolean | undefined;
    let roleAtSubmit: string | null | undefined;
    const setTabAutomaticModel = vi.fn();
    const createTabInDirectory = vi.fn().mockResolvedValue("tab-new");
    const h = harness({
      setTabAutomaticModel,
      createTabInDirectory,
      tabs: [{ id: "tab-new", inputLocked: false }],
      activeTabId: null,
    });
    const submit = vi.fn(() => {
      const t = (
        h.state().tabs as Array<{
          id: string;
          inputLocked: boolean;
          tabRole?: string | null;
        }>
      ).find((x) => x.id === "tab-new");
      lockedAtSubmit = t?.inputLocked;
      roleAtSubmit = t?.tabRole;
    });
    (h.state() as { submit: unknown }).submit = submit;

    await h.slice.openConflictAssist!(WT);

    const tabs = h.state().tabs as Array<{
      id: string;
      inputLocked: boolean;
      tabRole?: string | null;
    }>;
    expect(tabs.find((t) => t.id === "tab-new")?.inputLocked).toBe(true);
    expect(tabs.find((t) => t.id === "tab-new")?.tabRole).toBe(
      "conflict-auto-fix",
    );
    // Order pinned: at submit time the tab was ALREADY locked and role-tagged.
    expect(lockedAtSubmit).toBe(true);
    expect(roleAtSubmit).toBe("conflict-auto-fix");
    expect(submit).toHaveBeenCalledWith(
      "tab-new",
      conflictAssistPrompt(null, false, WT),
      { source: "machine" },
    );
  });

  it("pins the tier model on the fresh conversation", async () => {
    ionWith({ model: "prov/claude-sonnet-4-6" });
    const submit = vi.fn();
    const setTabAutomaticModel = vi.fn();
    const createTabInDirectory = vi.fn().mockResolvedValue("tab-new");
    const h = harness({
      submit,
      setTabAutomaticModel,
      createTabInDirectory,
      tabs: [],
      activeTabId: null,
    });

    await h.slice.openConflictAssist!(WT);

    expect(setTabAutomaticModel).toHaveBeenCalledWith(
      "tab-new",
      "prov/claude-sonnet-4-6",
    );
  });

  it("forces auto mode on the fresh conversation regardless of the default", async () => {
    // A plan-mode default would park the assist writing a plan for work the
    // operator already requested verbatim.
    ionWith();
    const setTabAutomaticModel = vi.fn();
    const createTabInDirectory = vi.fn().mockResolvedValue("tab-new");
    const h = harness({
      submit: vi.fn(),
      setTabAutomaticModel,
      createTabInDirectory,
      tabs: [],
      activeTabId: null,
    });

    await h.slice.openConflictAssist!(WT);

    expect(applyPermissionModeForTab).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "tab-new",
      "auto",
      "conflict_assist",
    );
  });
});
