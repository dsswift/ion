import { describe, expect, it, vi } from "vitest";
import type { AutomationAction } from "@ion/shared/types-automation";
import { createAutomationSlice } from "../slices/automation-slice";

const action: AutomationAction = {
  kind: "conversation",
  payload: {
    directory: "/project",
    prompt: "inspect failure",
    useWorktree: false,
    pillColor: "red",
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
      setTabPillColor: vi.fn(() => calls.push("color")),
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
    );
    expect(state.setTabPillColor).toHaveBeenCalledWith("tab-1", "red");
    expect(state.submit).toHaveBeenCalledWith("tab-1", "inspect failure");
    expect(calls).toEqual(["create", "color", "submit"]);
  });

  it("formats slash action and mutates existing tab metadata", async () => {
    const state: any = {
      createTabInDirectory: vi.fn(async () => "tab-2"),
      setTabPillColor: vi.fn(),
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
    // The conversation icon is gone, and its action with it.
    await expect(state.runAutomationCommand({
      kind: "tab:set-icon",
      payload: { tabId: "tab-2", icon: "bug" },
    })).rejects.toThrow("Unsupported automation action: tab:set-icon");

    await expect(state.runAutomationCommand({
      kind: "conversation:slash-resolved",
      payload: { directory: "/project", command: "align" },
    })).rejects.toThrow("Unsupported automation action: conversation:slash-resolved");

    expect(state.submit).toHaveBeenCalledWith("tab-2", "/align --fix");
    expect(state.setTabPillColor).toHaveBeenCalledWith("tab-2", "#f08c4a");
  });
});
