// @vitest-environment jsdom
import React, { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabState, WorktreeInventoryEntry } from "../../../shared/types";
import type { ConversationPane } from "../../../shared/types-engine";
import type { InboxNavigatorProject } from "./inbox-navigator";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const listeners = new Set<() => void>();
const state = {
  activeTabId: "outside",
  tabs: [] as TabState[],
  conversationPanes: new Map<string, ConversationPane>(),
  worktreeInventory: new Map<string, WorktreeInventoryEntry[]>(),
  workspaceOperationLedger: new Map(),
  benchWorkspaces: new Map(),
  selectTab: vi.fn(),
};

function activateOutsideInbox(tabId: string): void {
  state.activeTabId = tabId;
  for (const listener of listeners) listener();
}

vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: Object.assign(
    (selector: (value: typeof state) => unknown) =>
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => selector(state),
      ),
    { getState: () => state },
  ),
}));

vi.mock("../../theme", () => ({
  useColors: () => new Proxy({}, { get: () => "#000000" }),
}));
vi.mock("../../rendererLogger", () => ({ rInfo: vi.fn(), rError: vi.fn() }));
vi.mock("../../components/WorktreePipelinePanel", () => ({
  WorktreePipelinePanel: () => null,
}));
vi.mock("./InboxBenchBar", () => ({ InboxBenchBar: () => null }));
vi.mock("./InboxBenchMenu", () => ({ InboxBenchMenu: () => null }));
vi.mock("./InboxWorktreeRow", () => ({ InboxWorktreeRow: () => null }));

import { InboxNavigatorGroups } from "./InboxNavigatorGroups";

function tab(id: string): TabState {
  return {
    id,
    title: id,
    customTitle: null,
    status: "idle",
    workingDirectory: "/repo",
    pinnedAt: null,
  } as TabState;
}

const older = tab("older");
const newer = tab("newer");
const project: InboxNavigatorProject = {
  project: { key: "/repo", name: "repo" },
  groups: [
    {
      key: "source:/repo",
      kind: "source",
      label: "Source Repository",
      tabs: [older, newer],
    },
  ],
  flatTabs: [],
};
const collapsed = new Set(["group:card:source:/repo"]);

function Harness(): React.JSX.Element {
  return (
    <InboxNavigatorGroups
      projects={[project]}
      collapsed={collapsed}
      onToggle={() => {}}
      variant="card"
      selectedBench={{}}
      onSelectBench={() => {}}
      row={(item) => (
        <div key={item.id} data-testid={`conversation-${item.id}`}>
          {item.title}
        </div>
      )}
    />
  );
}

describe("InboxNavigatorGroups external selection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    listeners.clear();
    state.activeTabId = "outside";
    state.tabs = [older, newer];
    state.worktreeInventory = new Map();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("shows whichever conversation becomes active while its group stays collapsed", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });

    expect(
      container.querySelector('[data-testid="conversation-older"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="conversation-newer"]'),
    ).toBeNull();

    // Models activation from the tab strip or any other store action. No Inbox
    // click occurs, so visibility must follow the shared activeTabId directly.
    await act(async () => {
      activateOutsideInbox("older");
    });

    expect(
      container.querySelector('[data-testid="conversation-older"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="conversation-newer"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Toggle Source Repository"]'),
    ).not.toBeNull();

    await act(async () => {
      activateOutsideInbox("newer");
    });

    expect(
      container.querySelector('[data-testid="conversation-older"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="conversation-newer"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Toggle Source Repository"]'),
    ).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
