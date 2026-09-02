/**
 * Cache/fallback tests for getRemoteTabStates — the read side of the
 * renderer-push snapshot architecture.
 *
 * Pins:
 *   - fresh cache (< RENDERER_CACHE_MAX_AGE_MS) → served WITHOUT invoking the
 *     legacy renderer poll
 *   - empty cache → legacy poll invoked; a non-empty result REFRESHES the cache
 *   - stale cache (>= max age) → legacy poll invoked
 *   - legacy poll returning empty does NOT poison the cache and falls through
 *     to the cold-start path
 *   - main-process catalog read state is projected without mutating the legacy
 *     renderer cache manifest
 *
 * The legacy poll is injected via _setPollRendererTabStatesForTest so no
 * BrowserWindow / executeJavaScript is involved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockIsResourceRead, mockGetHealth } = vi.hoisted(() => ({
  mockIsResourceRead: vi.fn(
    (_resourceId: string, _producer?: string, _kind?: string) => false,
  ),
  mockGetHealth: vi.fn(
    (): {
      tabs: Array<{
        tabId: string;
        status: string;
        conversationId: string | null;
        lastActivityAt?: number;
      }>;
    } => ({ tabs: [] }),
  ),
}));

vi.mock("../../state", () => ({
  state: {
    mainWindow: null,
    remoteTransport: null,
    rendererSnapshotCache: null,
  },
  sessionPlane: { getHealth: mockGetHealth },
  lastMessagePreview: new Map<string, string>(),
}));

vi.mock("../../settings-store", () => ({
  TABS_FILE: "/nonexistent/for-tests/tabs.json",
  // The cold-start path classifies persisted rows through the shared inbox
  // classifier and reads the auto-settle preference to do it. Zero disables
  // the clock, which is what these cache/fallback tests want: they assert
  // routing (cache vs poll vs cold), not classification.
  readSettings: () => ({ inboxAutoSettleDays: 0 }),
}));

vi.mock("../../event-wiring-resources", () => ({
  filterDeletedResources: <T>(items: T[]) => items,
  isResourceRead: (resourceId: string, producer?: string, kind?: string) =>
    mockIsResourceRead(resourceId, producer, kind),
}));

import {
  getRemoteTabStates,
  refreshRendererSnapshotCache,
  RENDERER_CACHE_MAX_AGE_MS,
  _setPollRendererTabStatesForTest,
} from "../snapshot";
import { resourceCatalog } from "../../resource-catalog";
import { state } from "../../state";
import type {
  RemoteTabStatesPayload,
  ProjectedRendererTab,
} from "../../../shared/remote-projection-types";

function projectedTab(
  id: string,
  overrides: Partial<ProjectedRendererTab> = {},
): ProjectedRendererTab {
  return {
    id,
    title: `Tab ${id}`,
    customTitle: null,
    status: "idle",
    workingDirectory: "/p",
    permissionMode: "auto",
    permissionQueue: [],
    elicitationQueue: [],
    contextTokens: null,
    contextWindow: null,
    messageCount: 0,
    queuedPrompts: [],
    engineProfileId: null,
    groupId: null,
    modelOverride: null,
    groupPinned: false,
    conversationId: null,
    lastMessageContent: null,
    lastActivityTs: 0,
    idleSince: null,
    inboxState: "active" as const,
    unread: false,
    snoozedUntil: null,
    settledAt: null,
    wokeAt: null,
    convFingerprint: "",
    pillColor: null,
    pillIcon: null,
    ...overrides,
  };
}

describe("getRemoteTabStates — renderer-push cache + legacy-poll fallback", () => {
  let pollMock: ReturnType<typeof vi.fn<() => Promise<RemoteTabStatesPayload>>>;

  beforeEach(() => {
    pollMock = vi.fn(async (): Promise<RemoteTabStatesPayload> => ({
      tabs: [],
      resourceManifest: {},
    }));
    _setPollRendererTabStatesForTest(pollMock);
    state.rendererSnapshotCache = null;
    resourceCatalog.clear();
    mockIsResourceRead.mockReturnValue(false);
    mockGetHealth.mockReturnValue({ tabs: [] });
  });

  afterEach(() => {
    _setPollRendererTabStatesForTest(null);
    state.rendererSnapshotCache = null;
    vi.restoreAllMocks();
  });

  it("serves a fresh cache without invoking the legacy poll", async () => {
    state.rendererSnapshotCache = {
      tabs: [projectedTab("t1")],
      resourceManifest: {},
      receivedAt: Date.now(),
    };
    const { tabs } = await getRemoteTabStates();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe("t1");
    expect(pollMock).not.toHaveBeenCalled();
  });

  it("runs the legacy poll when the cache is empty, and refreshes the cache from its result", async () => {
    pollMock.mockResolvedValue({
      tabs: [projectedTab("t-polled")],
      resourceManifest: {},
    });
    const { tabs } = await getRemoteTabStates();
    expect(pollMock).toHaveBeenCalledTimes(1);
    expect(tabs[0].id).toBe("t-polled");
    // Cache refreshed → the next call is a cache read, no second poll.
    const second = await getRemoteTabStates();
    expect(pollMock).toHaveBeenCalledTimes(1);
    expect(second.tabs[0].id).toBe("t-polled");
  });

  it("runs the legacy poll when the cache is stale (>= max age)", async () => {
    state.rendererSnapshotCache = {
      tabs: [projectedTab("t-stale")],
      resourceManifest: {},
      receivedAt: Date.now() - RENDERER_CACHE_MAX_AGE_MS - 1,
    };
    pollMock.mockResolvedValue({
      tabs: [projectedTab("t-fresh")],
      resourceManifest: {},
    });
    const { tabs } = await getRemoteTabStates();
    expect(pollMock).toHaveBeenCalledTimes(1);
    expect(tabs[0].id).toBe("t-fresh");
  });

  it("does not cache an empty poll result and falls through to the cold-start path", async () => {
    mockGetHealth.mockReturnValue({
      tabs: [
        {
          tabId: "health-1",
          status: "idle",
          conversationId: null,
          lastActivityAt: 123,
        },
      ],
    });
    const { tabs } = await getRemoteTabStates();
    expect(pollMock).toHaveBeenCalledTimes(1);
    // Cold-start path served from engine health.
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe("health-1");
    // Empty result must NOT be cached (a cached empty would mask the renderer
    // coming online for the whole freshness window).
    expect(state.rendererSnapshotCache).toBeNull();
  });

  it("maps cached projected tabs through the wire projection (sorted running-first)", async () => {
    state.rendererSnapshotCache = {
      tabs: [
        projectedTab("t-idle", { lastActivityTs: 500 }),
        projectedTab("t-run", { status: "running", lastActivityTs: 100 }),
      ],
      resourceManifest: {},
      receivedAt: Date.now(),
    };
    const { tabs } = await getRemoteTabStates();
    // Running tabs sort first regardless of lastActivityAt.
    expect(tabs.map((t) => t.id)).toEqual(["t-run", "t-idle"]);
    expect(tabs[0].status).toBe("running");
    // lastActivityTs → lastActivityAt wire rename survived.
    expect(tabs[1].lastActivityAt).toBe(500);
  });

  it("projects main-process catalog read state without mutating the legacy cached manifest", async () => {
    const cachedManifest = {
      briefing: [
        {
          id: "cached-r1",
          kind: "briefing",
          title: "Cached",
          createdAt: "2025-01-01",
          read: false,
        },
      ],
    };
    state.rendererSnapshotCache = {
      tabs: [projectedTab("t1")],
      resourceManifest: cachedManifest,
      receivedAt: Date.now(),
    };
    resourceCatalog.applyFullItem("briefing", {
      id: "r1",
      kind: "briefing",
      title: "B",
      content: "body",
      createdAt: "2025-01-01",
      read: false,
    });
    mockIsResourceRead.mockImplementation(
      (resourceId: string) => resourceId === "r1",
    );

    const { resourceManifest } = await getRemoteTabStates();

    // The main catalog owns the manifest and carries persisted read state.
    expect(resourceManifest.briefing[0]).toMatchObject({
      id: "r1",
      read: true,
    });
    // The old renderer payload stays untouched and cannot replace catalog truth.
    expect(cachedManifest.briefing[0]).toMatchObject({
      id: "cached-r1",
      read: false,
    });
  });
});

/**
 * refreshRendererSnapshotCache — the read-your-write escape hatch.
 *
 * `getRemoteTabStates` serves any cache younger than RENDERER_CACHE_MAX_AGE_MS
 * without checking whether it holds the row the caller asked about. That is
 * correct for a periodic snapshot and WRONG for the tab-created echo, which
 * must observe a tab minted milliseconds ago while the renderer's projection
 * push is still inside its 250ms debounce. This function bypasses the age gate
 * outright.
 */
describe("refreshRendererSnapshotCache — bypasses the age gate", () => {
  let pollMock: ReturnType<typeof vi.fn<() => Promise<RemoteTabStatesPayload>>>;

  beforeEach(() => {
    pollMock = vi.fn(async (): Promise<RemoteTabStatesPayload> => ({
      tabs: [],
      resourceManifest: {},
    }));
    _setPollRendererTabStatesForTest(pollMock);
    state.rendererSnapshotCache = null;
  });

  afterEach(() => {
    _setPollRendererTabStatesForTest(null);
    state.rendererSnapshotCache = null;
    vi.restoreAllMocks();
  });

  it('polls and overwrites even when the existing cache is "fresh"', async () => {
    // A cache that getRemoteTabStates would happily serve — and which predates
    // the tab we are about to look for.
    state.rendererSnapshotCache = {
      tabs: [projectedTab("t-stale-but-fresh")],
      resourceManifest: {},
      receivedAt: Date.now(),
    };
    pollMock.mockResolvedValue({
      tabs: [projectedTab("t-just-created")],
      resourceManifest: {},
    });

    const payload = await refreshRendererSnapshotCache();

    expect(pollMock).toHaveBeenCalledTimes(1);
    expect(payload.tabs.map((t) => t.id)).toEqual(["t-just-created"]);
    expect(state.rendererSnapshotCache?.tabs.map((t) => t.id)).toEqual([
      "t-just-created",
    ]);
  });

  it("makes the subsequent getRemoteTabStates read a cache hit (one renderer round-trip)", async () => {
    pollMock.mockResolvedValue({
      tabs: [projectedTab("t-new")],
      resourceManifest: {},
    });

    await refreshRendererSnapshotCache();
    const { tabs } = await getRemoteTabStates();

    expect(tabs.map((t) => t.id)).toEqual(["t-new"]);
    // The refresh polled; the read served from the cache it wrote.
    expect(pollMock).toHaveBeenCalledTimes(1);
  });

  it("writes an empty result too — an empty renderer is a real observation", async () => {
    state.rendererSnapshotCache = {
      tabs: [projectedTab("t-old")],
      resourceManifest: {},
      receivedAt: Date.now(),
    };
    pollMock.mockResolvedValue({ tabs: [], resourceManifest: {} });

    const payload = await refreshRendererSnapshotCache();

    expect(payload.tabs).toHaveLength(0);
    // Unlike the fallback inside getRemoteTabStates, which keeps the old cache
    // when a poll comes back empty, a forced refresh records what it saw.
    expect(state.rendererSnapshotCache?.tabs).toHaveLength(0);
  });
});
