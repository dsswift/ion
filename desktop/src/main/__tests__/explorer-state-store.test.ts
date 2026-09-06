/**
 * The main-owned explorer state: what reaches disk, what does not, and what a
 * retired checkout leaves behind.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  mkdirSync: vi.fn(),
  atomicWriteFileSync: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
  mkdirSync: mocks.mkdirSync,
}));
vi.mock("../utils/atomicWrite", () => ({
  atomicWriteFileSync: mocks.atomicWriteFileSync,
}));
vi.mock("../logger", () => ({ log: vi.fn(), warn: vi.fn() }));

import {
  loadExplorerState,
  saveExplorerState,
  forgetExplorerState,
  resetExplorerStateCache,
} from "../explorer-state-store";
import type { ExplorerStateSnapshot } from "../../shared/explorer-state";

const snapshot: ExplorerStateSnapshot = {
  version: 1,
  expanded: { "/repo": ["/repo/src"], "/home/.ion/worktrees/wt-1": ["/home/.ion/worktrees/wt-1/src"] },
  collapsedRoots: ["/lib/shared"],
  selected: { "/repo": "/repo/readme.md" },
};

function writtenPayload(): Record<string, unknown> {
  const call = mocks.atomicWriteFileSync.mock.calls.at(-1);
  return JSON.parse(call?.[1] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetExplorerStateCache();
  mocks.existsSync.mockReturnValue(false);
});

describe("loadExplorerState", () => {
  it("starts empty when there is no file yet", () => {
    expect(loadExplorerState()).toEqual({ version: 1, expanded: {}, collapsedRoots: [], selected: {} });
  });

  it("reads and sanitizes what is on disk", () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({ version: 1, expanded: { "/repo": ["/repo/src", "junk"] }, collapsedRoots: ["/lib"] }),
    );
    const out = loadExplorerState();
    expect(out.expanded).toEqual({ "/repo": ["/repo/src"] });
    expect(out.collapsedRoots).toEqual(["/lib"]);
  });

  it("starts empty rather than throwing on a corrupt file", () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue("{ not json");
    expect(loadExplorerState().expanded).toEqual({});
  });
});

describe("saveExplorerState", () => {
  it("writes expansion and folded roots but never the selection", () => {
    saveExplorerState(snapshot);
    const payload = writtenPayload();
    expect(payload.expanded).toEqual(snapshot.expanded);
    expect(payload.collapsedRoots).toEqual(snapshot.collapsedRoots);
    expect(payload).not.toHaveProperty("selected");
  });

  it("keeps serving the saved snapshot, selection included, while running", () => {
    saveExplorerState(snapshot);
    expect(loadExplorerState().selected).toEqual({ "/repo": "/repo/readme.md" });
  });
});

describe("forgetExplorerState", () => {
  it("drops a retired checkout and writes the result", () => {
    saveExplorerState(snapshot);
    mocks.atomicWriteFileSync.mockClear();

    const { snapshot: next, changed } = forgetExplorerState("/home/.ion/worktrees/wt-1");

    expect(changed).toBe(true);
    expect(Object.keys(next.expanded)).toEqual(["/repo"]);
    expect(writtenPayload().expanded).toEqual({ "/repo": ["/repo/src"] });
  });

  it("writes nothing for a directory it never recorded", () => {
    saveExplorerState(snapshot);
    mocks.atomicWriteFileSync.mockClear();

    expect(forgetExplorerState("/somewhere/else").changed).toBe(false);
    expect(mocks.atomicWriteFileSync).not.toHaveBeenCalled();
  });
});
