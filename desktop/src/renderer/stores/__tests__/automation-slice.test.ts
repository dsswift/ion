import { describe, expect, it, vi } from "vitest";
import type { AutomationAction } from "../../../shared/types-automation";
import { createAutomationSlice } from "../slices/automation-slice";

const action: AutomationAction = {
  kind: "conversation",
  payload: {
    directory: "/project",
    prompt: "inspect failure",
    useWorktree: false,
    groupId: "review",
    groupPinned: true,
    pillColor: "red",
    pillIcon: "bug",
  },
};

describe("automation slice", () => {
  it("creates, decorates, and submits an automation conversation in owner order", async () => {
    const calls: string[] = [];
    const state: any = {
      createTabInDirectory: vi.fn(async () => {
        calls.push("create");
        return "tab-1";
      }),
      moveTabToGroup: vi.fn(() => calls.push("move")),
      moveTabToGroupAndPin: vi.fn(() => calls.push("pin")),
      setTabPillColor: vi.fn(() => calls.push("color")),
      setTabPillIcon: vi.fn(() => calls.push("icon")),
      submit: vi.fn(() => calls.push("submit")),
    };
    const slice = createAutomationSlice(
      () => {},
      () => state,
    );
    Object.assign(state, slice);

    await state.runAutomationCommand(action);

    expect(state.createTabInDirectory).toHaveBeenCalledWith(
      "/project",
      false,
      true,
      undefined,
    );
    expect(state.moveTabToGroupAndPin).toHaveBeenCalledWith("tab-1", "review");
    expect(state.setTabPillColor).toHaveBeenCalledWith("tab-1", "red");
    expect(state.setTabPillIcon).toHaveBeenCalledWith("tab-1", "bug");
    expect(state.submit).toHaveBeenCalledWith("tab-1", "inspect failure");
    expect(calls).toEqual(["create", "pin", "color", "icon", "submit"]);
  });

  it("formats slash action and mutates existing tab metadata", async () => {
    const state: any = {
      createTabInDirectory: vi.fn(async () => "tab-2"),
      moveTabToGroup: vi.fn(),
      moveTabToGroupAndPin: vi.fn(),
      setTabPillColor: vi.fn(),
      setTabPillIcon: vi.fn(),
      setTabGroupId: vi.fn(),
      submit: vi.fn(),
    };
    const slice = createAutomationSlice(
      () => {},
      () => state,
    );
    Object.assign(state, slice);

    await state.runAutomationCommand({
      kind: "conversation:slash",
      payload: { directory: "/project", command: "align", args: "--fix" },
    });
    await state.runAutomationCommand({
      kind: "tab:set-color",
      payload: { tabId: "tab-2", color: "#f08c4a" },
    });
    await state.runAutomationCommand({
      kind: "tab:set-icon",
      payload: { tabId: "tab-2", icon: "bug" },
    });
    await state.runAutomationCommand({
      kind: "tab:set-group",
      payload: { tabId: "tab-2", groupId: "review" },
    });

    await expect(state.runAutomationCommand({
      kind: "conversation:slash-resolved",
      payload: { directory: "/project", command: "align" },
    })).rejects.toThrow("Unsupported automation action: conversation:slash-resolved");

    expect(state.submit).toHaveBeenCalledWith("tab-2", "/align --fix");
    expect(state.setTabPillColor).toHaveBeenCalledWith("tab-2", "#f08c4a");
    expect(state.setTabPillIcon).toHaveBeenCalledWith("tab-2", "bug");
    expect(state.setTabGroupId).toHaveBeenCalledWith("tab-2", "review");
  });
});
