/**
 * End-to-end worktree refinement loop.
 *
 * Proves the whole `test -> bug -> test` cycle the redesign targets:
 *  - a normal auto-mode Message on a `test` worktree moves it to `bug`
 *  - a slash / machine / structured Message, or any non-`test` stage, does not
 *  - a changed bench pin moves `bug` back to `test`
 *
 * The runtime normalizes the current stage from the registry (section 2) and the
 * refinement rule reads it, so this exercises normalization, the fail-closed
 * evaluator, and the message-submitted event together against the real registry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../logger", () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => process.env.ION_TEST_HOME_AUTOMATION_REFINE || actual.homedir(),
  };
});

import {
  registerWorktree,
  setWorktreeStage,
  lookupWorktreeStage,
} from "../worktree/registry";
import { AutomationRuntime } from "./runtime";
import { AutomationService } from "./service";
import { AutomationStore } from "./store";
import { AutomationHistoryStore } from "./history";
import type { AutomationDefinition } from "./types";

const WT = "/wt/refine-aaa";

const refinement: AutomationDefinition = {
  id: "builtin.normal-refinement-marks-issue",
  name: "Normal refinement marks worktree as Issue found",
  enabled: true,
  trigger: { kind: "event", event: "conversation:message-submitted" },
  condition: {
    all: [
      { path: "payload.worktreePath", operator: "exists" },
      { path: "payload.stage", operator: "equals", value: "test" },
      { path: "payload.messageKind", operator: "equals", value: "prompt" },
      { path: "payload.permissionMode", operator: "equals", value: "auto" },
    ],
  },
  steps: [{ kind: "worktree:set-stage", payload: { stage: "bug", onlyIfStage: "test" } }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const inverse: AutomationDefinition = {
  id: "builtin.issue-fix-reaches-bench-needs-testing",
  name: "Fixed issue reaching the bench needs testing",
  enabled: true,
  trigger: { kind: "event", event: "worktree:pin-advanced" },
  condition: { all: [{ path: "payload.stage", operator: "equals", value: "bug" }] },
  steps: [{ kind: "worktree:set-stage", payload: { stage: "test", onlyIfStage: "bug" } }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

let root: string;
let runtime: AutomationRuntime;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ion-refine-"));
  mkdirSync(join(root, "home", ".ion"), { recursive: true });
  process.env.ION_TEST_HOME_AUTOMATION_REFINE = join(root, "home");
  registerWorktree({
    worktreePath: WT,
    repoPath: "/repo/project",
    branchName: "wt/refine-aaa",
    sourceBranch: "main",
  });
  const service = new AutomationService({
    builtIn: [refinement, inverse],
    store: new AutomationStore(join(root, "automations")),
    history: new AutomationHistoryStore(join(root, "history.json")),
  });
  runtime = new AutomationRuntime(service, vi.fn());
});

afterEach(() => {
  delete process.env.ION_TEST_HOME_AUTOMATION_REFINE;
  rmSync(root, { recursive: true, force: true });
});

async function submit(patch: Record<string, unknown>): Promise<void> {
  await runtime.trigger({
    type: "conversation:message-submitted",
    payload: {
      tabId: "tab-1",
      worktreePath: WT,
      permissionMode: "auto",
      messageKind: "prompt",
      isSteer: false,
      ...patch,
    },
  });
}

describe("worktree refinement loop", () => {
  it("moves a test worktree to bug on a normal auto-mode message", async () => {
    setWorktreeStage(WT, "test");
    await submit({});
    expect(lookupWorktreeStage(WT)).toBe("bug");
  });

  it("also fires on a human steer (isSteer: true)", async () => {
    setWorktreeStage(WT, "test");
    await submit({ isSteer: true });
    expect(lookupWorktreeStage(WT)).toBe("bug");
  });

  it("leaves test unchanged for a slash, structured, or machine message", async () => {
    for (const messageKind of ["slash", "structured", "machine"]) {
      setWorktreeStage(WT, "test");
      await submit({ messageKind });
      expect(lookupWorktreeStage(WT)).toBe("test");
    }
  });

  it("leaves test unchanged for a plan-mode message", async () => {
    setWorktreeStage(WT, "test");
    await submit({ permissionMode: "plan" });
    expect(lookupWorktreeStage(WT)).toBe("test");
  });

  it("leaves any stage other than test unchanged", async () => {
    setWorktreeStage(WT, "build");
    await submit({});
    expect(lookupWorktreeStage(WT)).toBe("build");
  });

  it("moves bug back to test on a changed bench pin", async () => {
    setWorktreeStage(WT, "bug");
    await runtime.triggerPinAdvance({
      repoPath: "/repo/project",
      sourceBranch: "main",
      worktreePath: WT,
      branchName: "wt/refine-aaa",
      previousPinnedSha: "a",
      pinnedSha: "b",
      previousPinnedTreeHash: "t1",
      pinnedTreeHash: "t2",
    });
    expect(lookupWorktreeStage(WT)).toBe("test");
  });
});
