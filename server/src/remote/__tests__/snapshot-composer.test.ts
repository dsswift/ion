/**
 * A phone renders the composer's `+` menu from the snapshot alone, so the
 * Composer Actions the server offers each conversation must ride
 * `RemoteTabState.composerActions`, and the viewer's own Quick Tools that
 * apply to it must ride `RemoteTabState.quickTools`, without their commands.
 * Each is absent where nothing is offered.
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

// Hoisted: the store reads settings while the modules below load.
const { toolsBySubject, settingsReads } = vi.hoisted(() => ({
  toolsBySubject: {} as Record<string, unknown[]>,
  settingsReads: [] as Array<string | undefined>,
}));
vi.mock("../../persistence/effective-settings", () => ({
  readEffectiveSettings: (subject?: string) => {
    settingsReads.push(subject);
    return { quickTools: toolsBySubject[subject ?? "local:host"] ?? [] };
  },
}));

import { getRemoteTabStates, _setPollRendererTabStatesForTest } from "../snapshot";
import { state } from "../../state";

const briefing: ComposerAction = { id: "briefing", producer: "cos2", label: "Briefing", icon: "Newspaper", command: "/briefing" };

const rebase = { id: "7cf1e7f4", name: "Rebase", icon: "GitMerge", command: "git rebase main" };
const scoped = { id: "fcea88f3", name: "Land", icon: "Upload", command: "make land", directories: ["/repo"] };

function projectedTab(id: string, workingDirectory = "/p"): ProjectedRendererTab {
  return {
    id,
    title: id,
    customTitle: null,
    status: "idle",
    workingDirectory,
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
  state.rendererSnapshotCache = { tabs: [projectedTab("t-cos"), projectedTab("t-plain"), projectedTab("t-repo", "/repo/server")], resourceManifest: {}, receivedAt: Date.now() };
  offered["t-cos"] = [briefing];
  toolsBySubject["local:host"] = [rebase, scoped];
});

afterEach(() => {
  _setPollRendererTabStatesForTest(null);
  state.rendererSnapshotCache = null;
  for (const key of Object.keys(offered)) delete offered[key];
  for (const key of Object.keys(toolsBySubject)) delete toolsBySubject[key];
  settingsReads.length = 0;
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

describe("snapshot: quickTools", () => {
  it("lists the viewer's tools that apply to each conversation's directory, without commands", async () => {
    const { tabs } = await getRemoteTabStates();
    expect(tabs.find((t) => t.id === "t-plain")?.quickTools).toEqual([{ id: "7cf1e7f4", name: "Rebase", icon: "GitMerge" }]);
    expect(tabs.find((t) => t.id === "t-repo")?.quickTools).toEqual([
      { id: "7cf1e7f4", name: "Rebase", icon: "GitMerge" },
      { id: "fcea88f3", name: "Land", icon: "Upload" },
    ]);
  });

  it("reads the Quick Tools of the subject the snapshot is built for", async () => {
    toolsBySubject["local:alice"] = [];
    const { tabs } = await getRemoteTabStates("local:alice");
    expect(settingsReads).toContain("local:alice");
    for (const tab of tabs) expect(tab).not.toHaveProperty("quickTools");
  });
});
