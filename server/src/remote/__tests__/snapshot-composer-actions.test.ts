/**
 * A phone renders the composer's `+` menu from the snapshot alone, so the
 * Composer Actions the server offers each conversation must ride
 * `RemoteTabState.composerActions`, and be absent where none are offered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComposerAction } from "@ion/shared/studio-sdk-contract";
import type { ProjectedRendererTab } from "@ion/shared/remote-projection-types";

vi.mock("../../state", () => ({
  state: { mainWindow: null, remoteTransport: null, rendererSnapshotCache: null },
  sessionPlane: { getHealth: () => ({ tabs: [] }) },
  lastMessagePreview: new Map<string, string>(),
}));

vi.mock("../../engine/event-wiring-resources", () => ({
  filterDeletedResources: <T>(items: T[]) => items,
  isResourceRead: () => false,
}));

vi.mock("../../persistence/settings-store", () => ({
  tabsFile: () => "/nonexistent/for-tests/tabs.json",
  settingsDir: () => "/nonexistent/for-tests",
  readSettings: () => ({ inboxAutoSettleDays: 0 }),
}));

const offered: Record<string, ComposerAction[]> = {};
vi.mock("../../engine/composer-actions-wiring", () => ({
  composerActionsBoard: { actionsFor: (tabId: string) => offered[tabId] ?? [] },
  bindComposerActionsTabs: () => {},
}));

import { getRemoteTabStates, _setPollRendererTabStatesForTest } from "../snapshot";
import { state } from "../../state";

const briefing: ComposerAction = { id: "briefing", producer: "cos2", label: "Briefing", icon: "Newspaper", command: "/briefing" };

function projectedTab(id: string): ProjectedRendererTab {
  return {
    id,
    title: id,
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
    modelOverride: null,
    conversationId: null,
    lastMessageContent: null,
    lastActivityTs: 0,
    idleSince: null,
    inboxState: "active" as const,
    unread: false,
    snoozedUntil: null,
    settledAt: null,
    wokeAt: null,
    limitedUntil: null,
    quiet: false,
    pillColor: null,
  };
}

beforeEach(() => {
  _setPollRendererTabStatesForTest(vi.fn(async () => ({ tabs: [], resourceManifest: {} })));
  state.rendererSnapshotCache = { tabs: [projectedTab("t-cos"), projectedTab("t-plain")], resourceManifest: {}, receivedAt: Date.now() };
  offered["t-cos"] = [briefing];
});

afterEach(() => {
  _setPollRendererTabStatesForTest(null);
  state.rendererSnapshotCache = null;
  for (const key of Object.keys(offered)) delete offered[key];
});

describe("snapshot: composerActions", () => {
  it("carries the actions the server offers each conversation", async () => {
    const { tabs } = await getRemoteTabStates();
    expect(tabs.find((t) => t.id === "t-cos")?.composerActions).toEqual([briefing]);
  });

  it("omits the field on a conversation that offers none", async () => {
    const { tabs } = await getRemoteTabStates();
    expect(tabs.find((t) => t.id === "t-plain")).not.toHaveProperty("composerActions");
  });
});
