import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConversationPane } from "../../../shared/types-engine";
import type { TabState } from "../../../shared/types";
import {
  collapsedInboxRows,
  inboxActivityOrder,
  isInboxTabWorking,
  nextInboxConversation,
  orderInboxTabs,
  worktreeChildRows,
} from "./inbox-collapse";

function tab(
  id: string,
  options: Partial<
    Pick<
      TabState,
      "pinnedAt" | "pinOrderKey" | "createdAt" | "lastActivityAt" | "status"
    >
  > = {},
): TabState {
  return {
    id,
    pinnedAt: null,
    pinOrderKey: null,
    createdAt: 0,
    lastActivityAt: null,
    status: "idle",
    ...options,
  } as TabState;
}

function pane(overrides: Record<string, unknown> = {}): ConversationPane {
  return {
    activeInstanceId: "main",
    instances: [
      {
        id: "main",
        label: "main",
        agentStates: [],
        statusFields: null,
        ...overrides,
      },
    ],
  } as unknown as ConversationPane;
}

describe("collapsedInboxRows", () => {
  it("keeps pinned rows first, then selected and working rows", () => {
    const tabs = [
      tab("pinned-later", { pinnedAt: 1, pinOrderKey: "z" }),
      tab("idle"),
      tab("selected"),
      tab("working", { status: "running" }),
      tab("pinned-first", { pinnedAt: 2, pinOrderKey: "a" }),
    ];
    expect(
      collapsedInboxRows(tabs, "selected", new Set(["working"])).map(
        ({ id }) => id,
      ),
    ).toEqual(["pinned-first", "pinned-later", "selected", "working"]);
  });

  it("shows every conversation under an expanded worktree and important rows when collapsed", () => {
    const tabs = [
      tab("plain"),
      tab("pinned", { pinnedAt: 1 }),
      tab("selected"),
      tab("working", { status: "running" }),
    ];
    expect(
      worktreeChildRows(tabs, false, "selected", new Set(["working"])).map(
        ({ id }) => id,
      ),
    ).toEqual(["plain", "pinned", "selected", "working"]);
    expect(
      worktreeChildRows(tabs, true, "selected", new Set(["working"])).map(
        ({ id }) => id,
      ),
    ).toEqual(["pinned", "selected", "working"]);
  });

  it("keeps conversation status indicators out of the worktree group header", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "InboxWorktreeRow.tsx"),
      "utf8",
    );
    expect(source).not.toContain("WorktreeConversationStatusDot");
    expect(source).not.toContain("group.tabs[0]");
  });

  it("uses created time then tab ID as the deterministic fallback pin order", () => {
    const tabs = [
      tab("older-b", { pinnedAt: 1, createdAt: 10 }),
      tab("newer", { pinnedAt: 2, createdAt: 20 }),
      tab("older-a", { pinnedAt: 3, createdAt: 10 }),
    ];
    expect(collapsedInboxRows(tabs).map(({ id }) => id)).toEqual([
      "newer",
      "older-a",
      "older-b",
    ]);
  });

  it("does not duplicate a pinned selected working row", () => {
    const pinnedActive = tab("pinned-active", {
      pinnedAt: 1,
      status: "running",
    });
    expect(
      collapsedInboxRows(
        [pinnedActive, tab("idle")],
        "pinned-active",
        new Set(["pinned-active"]),
      ).map(({ id }) => id),
    ).toEqual(["pinned-active"]);
  });

  it("recognizes foreground and all-instance background work", () => {
    expect(
      isInboxTabWorking(tab("running", { status: "running" }), undefined),
    ).toBe(true);
    expect(
      isInboxTabWorking(tab("starting", { status: "starting" }), undefined),
    ).toBe(true);
    expect(
      isInboxTabWorking(tab("waiting", { status: "waiting" }), undefined),
    ).toBe(true);
    expect(
      isInboxTabWorking(
        tab("child"),
        pane({ agentStates: [{ status: "running" }] }),
      ),
    ).toBe(true);
    expect(
      isInboxTabWorking(
        tab("pending"),
        pane({ statusFields: { hasPendingWork: true } }),
      ),
    ).toBe(true);
    expect(
      isInboxTabWorking(
        tab("shell"),
        pane({ statusFields: { backgroundShells: 1 } }),
      ),
    ).toBe(true);
    expect(isInboxTabWorking(tab("idle"), pane())).toBe(false);
  });
});

describe("Inbox conversation cycling", () => {
  const tabs = [
    tab("older", { lastActivityAt: 10 }),
    tab("tie-b", { pinnedAt: 1, lastActivityAt: 20 }),
    tab("tie-a", { lastActivityAt: 20 }),
    tab("no-activity"),
  ];

  it("orders every conversation by descending activity with a stable ID tie-breaker", () => {
    expect(inboxActivityOrder(tabs).map(({ id }) => id)).toEqual([
      "tie-a",
      "tie-b",
      "older",
      "no-activity",
    ]);
  });

  it("uses creation time for a new conversation with no message activity", () => {
    const ordered = [
      { ...tab("older"), lastMessageAt: 20 },
      { ...tab("new"), createdAt: 30, lastMessageAt: null },
    ] as TabState[];
    expect(orderInboxTabs(ordered, "activity").map(({ id }) => id)).toEqual([
      "new",
      "older",
    ]);
  });

  it("includes pinned conversations in activity order and wraps", () => {
    expect(nextInboxConversation(tabs, "tie-a")?.id).toBe("tie-b");
    expect(nextInboxConversation(tabs, "no-activity")?.id).toBe("tie-a");
  });

  it("starts at the most active conversation when the active tab is elsewhere", () => {
    expect(nextInboxConversation(tabs, "elsewhere")?.id).toBe("tie-a");
  });
});
