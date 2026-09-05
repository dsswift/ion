/**
 * workspace-folder-migration: mounted folders written under a worktree or
 * bench path move onto the Project that owns them, and nothing else moves.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  loadRegistry: vi.fn(() => [] as Array<{ worktreePath: string; repoPath?: string }>),
  loadWorkspaces: vi.fn(() => [] as Array<{ benchPath: string; repoPath: string }>),
  readSettings: vi.fn(() => ({}) as Record<string, unknown>),
  writeSettings: vi.fn(),
}));

vi.mock("../worktree/registry", () => ({ loadRegistry: mocks.loadRegistry }));
vi.mock("../integration/bench-store", () => ({ loadWorkspaces: mocks.loadWorkspaces }));
vi.mock("../settings-store", () => ({
  readSettings: mocks.readSettings,
  writeSettings: mocks.writeSettings,
}));
vi.mock("../logger", () => ({ log: vi.fn(), warn: vi.fn() }));

import {
  buildCheckoutOwners,
  remapWorkspaceFolders,
  migrateWorkspaceFolders,
} from "../workspace-folder-migration";

const REPO = "/src/ion";
const WORKTREE = "/home/.ion/worktrees/ion-abc";
const BENCH = "/home/.ion/integration/ion-bench";

const owners = buildCheckoutOwners(
  [{ worktreePath: WORKTREE, repoPath: REPO }],
  [{ benchPath: BENCH, repoPath: REPO }],
);

describe("remapWorkspaceFolders", () => {
  it("moves a worktree-keyed list onto its repo", () => {
    const { next, moved } = remapWorkspaceFolders({ [WORKTREE]: ["/lib/a"] }, owners);
    expect(next).toEqual({ [REPO]: ["/lib/a"] });
    expect(moved).toEqual([{ from: WORKTREE, to: REPO }]);
  });

  it("moves a bench-keyed list onto its repo", () => {
    const { next } = remapWorkspaceFolders({ [BENCH]: ["/lib/b"] }, owners);
    expect(next).toEqual({ [REPO]: ["/lib/b"] });
  });

  it("merges into an existing project key without duplicating", () => {
    const { next } = remapWorkspaceFolders(
      { [REPO]: ["/lib/a"], [WORKTREE]: ["/lib/a", "/lib/c"] },
      owners,
    );
    expect(next).toEqual({ [REPO]: ["/lib/a", "/lib/c"] });
  });

  it("drops the repo root itself, which the primary root already renders", () => {
    const { next } = remapWorkspaceFolders({ [WORKTREE]: [REPO, "/lib/a"] }, owners);
    expect(next).toEqual({ [REPO]: ["/lib/a"] });
  });

  it("leaves a key no record recognizes exactly as it is", () => {
    const { next, moved } = remapWorkspaceFolders({ "/src/other": ["/lib/a"] }, owners);
    expect(moved).toEqual([]);
    expect(next).toBeNull();
  });
});

describe("migrateWorkspaceFolders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadRegistry.mockReturnValue([{ worktreePath: WORKTREE, repoPath: REPO }]);
    mocks.loadWorkspaces.mockReturnValue([{ benchPath: BENCH, repoPath: REPO }]);
  });

  it("writes the corrected map, preserving unrelated settings", () => {
    mocks.readSettings.mockReturnValue({
      theme: "dark",
      workspaceFolders: { [WORKTREE]: ["/lib/a"] },
    });
    migrateWorkspaceFolders();
    expect(mocks.writeSettings).toHaveBeenCalledWith({
      theme: "dark",
      workspaceFolders: { [REPO]: ["/lib/a"] },
    });
  });

  it("is a no-op on a second run", () => {
    mocks.readSettings.mockReturnValue({ workspaceFolders: { [REPO]: ["/lib/a"] } });
    migrateWorkspaceFolders();
    expect(mocks.writeSettings).not.toHaveBeenCalled();
  });

  it("writes nothing when there is no map at all", () => {
    mocks.readSettings.mockReturnValue({});
    migrateWorkspaceFolders();
    expect(mocks.writeSettings).not.toHaveBeenCalled();
  });
});
