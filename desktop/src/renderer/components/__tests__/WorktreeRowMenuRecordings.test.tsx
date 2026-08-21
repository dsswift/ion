// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import type {
  IntegrationWorkspace,
  WorktreeInventoryEntry,
} from "../../../shared/types";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  discard: vi.fn(),
  refresh: vi.fn(),
  benchWorkspaces: new Map(),
}));

vi.mock("framer-motion", () => ({
  motion: {
    div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
      ({ children, ...props }, ref) => (
        <div ref={ref} {...props}>
          {children}
        </div>
      ),
    ),
  },
}));
vi.mock("../../theme", () => ({
  useColors: () => new Proxy({}, { get: () => "#000000" }),
}));
vi.mock("../../preferences", () => ({
  usePreferencesStore: Object.assign(
    (selector: (state: { worktreeCompletionStrategy: string }) => unknown) =>
      selector({ worktreeCompletionStrategy: "merge-ff" }),
    { getState: () => ({ uiZoom: 1 }) },
  ),
}));
vi.mock("../../rendererLogger", () => ({
  rInfo: vi.fn(),
  rWarn: vi.fn(),
  rError: vi.fn(),
  rDebug: vi.fn(),
  rTrace: vi.fn(),
}));
vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: Object.assign(
    (
      selector: (state: {
        benchWorkspaces: Map<string, IntegrationWorkspace[]>;
        tabs: never[];
      }) => unknown,
    ) => selector({ benchWorkspaces: mocks.benchWorkspaces, tabs: [] }),
    {
      getState: () => ({
        benchDiscardMemberRecordings: mocks.discard,
        reprovisionWorktree: vi.fn(),
        newWorktreeConversation: vi.fn(),
        setWorktreeStage: vi.fn(),
        syncWorktree: vi.fn(),
        benchAddMember: vi.fn(),
        benchSetOrder: vi.fn(),
        retireWorktree: vi.fn(),
        recordConflictAlert: vi.fn(),
        tabs: [],
        conversationPanes: new Map(),
      }),
    },
  ),
}));

import { PopoverLayerProvider } from "../PopoverLayer";
import { WorktreeRowMenu } from "../WorktreeRowMenu";

const REPO = "/repo";
const WORKTREE = "/wt/a";
const BRANCH = "wt/a";

function workspace(): IntegrationWorkspace {
  return {
    repoPath: REPO,
    sourceBranch: "main",
    benchPath: "/bench",
    benchBranch: "ion/bench/main",
    baseSha: "base",
    lastBuiltAt: 1,
    members: [
      {
        worktreePath: WORKTREE,
        branchName: BRANCH,
                pin: "current",
        merge: "merged",
        pinnedSha: "pin",
        pinnedTreeHash: "tree",
        pinnedBaseSha: "base",
        currentTreeHash: "tree",
      },
    ],
  };
}

function entry(): WorktreeInventoryEntry {
  return {
    worktreePath: WORKTREE,
    branchName: BRANCH,
    label: "worktree a",
    sourceBranch: "main",
    head: "pin",
    lastCommitSubject: "work",
    isDirty: false,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: true,
  };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let closed: number;

function render(): void {
  act(() => {
    root.render(
      <PopoverLayerProvider>
        <WorktreeRowMenu
          entry={entry()}
          anchor={{ x: 10, y: 10 }}
          repoPath={REPO}
          onClose={() => {
            closed++;
          }}
          onRefresh={mocks.refresh}
        />
      </PopoverLayerProvider>,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`missing button ${label}`);
  return found as HTMLButtonElement;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  closed = 0;
  mocks.benchWorkspaces = new Map([[REPO, [workspace()]]]);
  mocks.discard.mockResolvedValue({
    ok: true,
    forgottenCount: 1,
    workspace: {
      ...workspace(),
      lastAssembly: "failed",
      lastAssemblyFailure: "conflict",
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("WorktreeRowMenu — selective recording discard", () => {
  it("offers the destructive action only to enrolled worktrees", () => {
    render();
    expect(button("Discard recorded resolutions")).toBeTruthy();
    act(() => root.unmount());
    mocks.benchWorkspaces = new Map();
    root = createRoot(host);
    render();
    expect(
      [...document.querySelectorAll("button")].some(
        (candidate) =>
          candidate.textContent?.trim() === "Discard recorded resolutions",
      ),
    ).toBe(false);
  });

  it("names selected member, keeps cancel inert, and targets exactly its branch", async () => {
    render();
    await click("Discard recorded resolutions");

    expect(mocks.discard).not.toHaveBeenCalled();
    expect(host.textContent).toContain(BRANCH);
    await click("Keep resolutions");
    expect(mocks.discard).not.toHaveBeenCalled();
    expect(closed).toBe(1);

    render();
    await click("Discard recorded resolutions");
    await click("Discard resolutions");
    expect(mocks.discard).toHaveBeenCalledWith(REPO, "main", [BRANCH]);
  });

  it("keeps outcome visible and identifies expected fresh conflict", async () => {
    render();
    await click("Discard recorded resolutions");
    await click("Discard resolutions");
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain("fresh conflict to resolve");
    expect(host.textContent).toContain("all other recordings remain");
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("reports no matching recording without claiming a deletion", async () => {
    mocks.discard.mockResolvedValue({
      ok: true,
      forgottenCount: 0,
      branchesWithNothingToForget: [BRANCH],
      workspace: workspace(),
    });
    render();
    await click("Discard recorded resolutions");
    await click("Discard resolutions");
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain("No recorded resolution matched");
  });
});
