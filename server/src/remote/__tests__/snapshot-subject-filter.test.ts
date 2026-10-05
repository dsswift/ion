/**
 * `getRemoteTabStates(forSubject)` — A3's third fail-open site
 * (`filterBySubject` in `snapshot.ts`). An owned tab is visible only to its
 * owner; an unowned (pre-backfill legacy) tab is visible to everyone in
 * single-tenant mode and to no one once the server is multi-tenant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

import { getRemoteTabStates, _setPollRendererTabStatesForTest } from "../snapshot";
import { _resetPrincipalIndexForTest } from "../../protocol/tabs-index";
import { _resetCurrentServerConfigForTest, currentServerConfig, setCurrentServerConfig } from "../../config/current";
import type { ServerOidcConfig } from "../../config/server-config";
import { state } from "../../state";
import type { ProjectedRendererTab } from "@ion/shared/remote-projection-types";

const oidc: ServerOidcConfig = {
  issuer: "https://issuer.example.org",
  audience: "ion-server",
  scope: "api://ion-server/.default",
  clientId: "browser-client",
  rolesToScopes: {},
  defaultScopes: [],
  allowedSubjects: [],
    clientSecret: '',
};

let dataDir: string;
let originalIonDataDir: string | undefined;

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

function writeTabsFile(tabs: Array<{ id: string; principalSubject?: string }>): void {
  writeFileSync(
    join(dataDir, "tabs.json"),
    JSON.stringify({ tabs: tabs.map((t) => ({ id: t.id, conversationId: null, ...(t.principalSubject ? { principalSubject: t.principalSubject } : {}) })) }),
  );
}

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "ion-snapshot-subject-filter-"));
  process.env.ION_DATA_DIR = dataDir;
  _setPollRendererTabStatesForTest(vi.fn(async () => ({ tabs: [], resourceManifest: {} })));
  state.rendererSnapshotCache = {
    tabs: [projectedTab("t-alice"), projectedTab("t-bob"), projectedTab("t-legacy")],
    resourceManifest: {},
    receivedAt: Date.now(),
  };
});

afterEach(() => {
  _setPollRendererTabStatesForTest(null);
  state.rendererSnapshotCache = null;
  _resetPrincipalIndexForTest();
  _resetCurrentServerConfigForTest();
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR;
  else process.env.ION_DATA_DIR = originalIonDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("getRemoteTabStates(forSubject) — filterBySubject", () => {
  it("single-tenant: an unowned tab is visible to every subject", async () => {
    writeTabsFile([{ id: "t-alice", principalSubject: "local:alice" }, { id: "t-bob", principalSubject: "local:bob" }, { id: "t-legacy" }]);

    const forAlice = await getRemoteTabStates("local:alice");
    expect(forAlice.tabs.map((t) => t.id).sort()).toEqual(["t-alice", "t-legacy"]);
  });

  it("multi-tenant: an unowned tab is visible to no subject", async () => {
    setCurrentServerConfig({ ...currentServerConfig(), oidc });
    writeTabsFile([{ id: "t-alice", principalSubject: "local:alice" }, { id: "t-bob", principalSubject: "local:bob" }, { id: "t-legacy" }]);

    const forAlice = await getRemoteTabStates("local:alice");
    expect(forAlice.tabs.map((t) => t.id)).toEqual(["t-alice"]);

    const forBob = await getRemoteTabStates("local:bob");
    expect(forBob.tabs.map((t) => t.id)).toEqual(["t-bob"]);
  });

  it("no forSubject argument returns every tab unfiltered (broadcast/legacy path)", async () => {
    writeTabsFile([{ id: "t-alice", principalSubject: "local:alice" }, { id: "t-bob", principalSubject: "local:bob" }, { id: "t-legacy" }]);
    const all = await getRemoteTabStates();
    expect(all.tabs.map((t) => t.id).sort()).toEqual(["t-alice", "t-bob", "t-legacy"]);
  });

  it("FR-02: shared tenancy returns every tab for every subject, owned or not", async () => {
    setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: "shared" } });
    writeTabsFile([{ id: "t-alice", principalSubject: "local:alice" }, { id: "t-bob", principalSubject: "local:bob" }, { id: "t-legacy" }]);

    const forAlice = await getRemoteTabStates("local:alice");
    expect(forAlice.tabs.map((t) => t.id).sort()).toEqual(["t-alice", "t-bob", "t-legacy"]);
  });
});
