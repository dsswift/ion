import { describe, expect, it } from "vitest";
import type { TabState } from "../../../shared/types";
import { collapsedInboxRows } from "./inbox-collapse";

function tab(
  id: string,
  pinnedAt: number | null = null,
  pinOrderKey: string | null = null,
  status: TabState["status"] = "idle",
): TabState {
  return { id, pinnedAt, pinOrderKey, status, createdAt: 0 } as TabState;
}

describe("collapsed inbox groups", () => {
  it("keeps pinned rows first and then selected and working rows", () => {
    const tabs = [
      tab("pinned-last", 1, "z"),
      tab("selected"),
      tab("working", null, null, "running"),
      tab("idle"),
      tab("pinned-first", 2, "a"),
    ];
    expect(
      collapsedInboxRows(tabs, "selected", new Set(["working"])).map(
        ({ id }) => id,
      ),
    ).toEqual(["pinned-first", "pinned-last", "selected", "working"]);
  });

  it("does not duplicate a pinned selected working conversation", () => {
    expect(
      collapsedInboxRows(
        [tab("pinned-active", 1, null, "running"), tab("other")],
        "pinned-active",
        new Set(["pinned-active"]),
      ).map(({ id }) => id),
    ).toEqual(["pinned-active"]);
  });
});
