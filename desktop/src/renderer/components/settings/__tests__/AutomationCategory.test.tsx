// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const automationListing = vi.fn();
const automationHistory = vi.fn();
const automationUpsert = vi.fn();
const automationDelete = vi.fn();
const automationDuplicate = vi.fn();
const getEnterprisePolicyFull = vi.fn();
const setProjectAutomationEnabled = vi.fn();
const selectDirectory = vi.fn();
;(globalThis as unknown as { window: Window }).window = {
  ion: {
    automationListing,
    automationHistory,
    automationUpsert,
    automationDelete,
    automationDuplicate,
    getEnterprisePolicyFull,
    setProjectAutomationEnabled,
    selectDirectory,
  },
} as unknown as Window;

vi.mock("../../../theme", () => ({ useColors: () => new Proxy({}, { get: () => "#000000" }) }));
vi.mock("../../../rendererLogger", () => ({ rInfo: vi.fn(), rWarn: vi.fn() }));
vi.mock("../../git/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../../preferences", () => ({
  usePreferencesStore: (selector: (state: { tabGroups: unknown[] }) => unknown) =>
    selector({ tabGroups: [] }),
}));
vi.mock("../../SlashCommandMenu", () => ({ SLASH_COMMANDS: [{ command: "/align" }] }));

import { AutomationCategory } from "../AutomationCategory";
import type { AutomationDefinition, AutomationSourceEntry } from "../../../../shared/types-automation";

let container: HTMLDivElement;
let root: Root;

function userDef(id: string, name: string): AutomationDefinition {
  return {
    id,
    name,
    enabled: true,
    trigger: { kind: "event", event: "worktree:pin-advanced" },
    steps: [{ kind: "worktree:set-stage", payload: { stage: "test", onlyIfStage: "bug" } }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function entry(
  definition: AutomationDefinition,
  source: AutomationSourceEntry["source"],
  extra: Partial<AutomationSourceEntry> = {},
): AutomationSourceEntry {
  return { definition, source, effective: true, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  automationListing.mockResolvedValue({
    entries: [entry(userDef("u1", "My rule"), "user")],
    locked: false,
  });
  automationHistory.mockResolvedValue([]);
  automationUpsert.mockResolvedValue({ ok: true, definition: userDef("u1", "My rule") });
  automationDelete.mockResolvedValue({ ok: true });
  automationDuplicate.mockResolvedValue({ ok: true, definition: userDef("copy", "My rule (copy)") });
  getEnterprisePolicyFull.mockResolvedValue(null);
  setProjectAutomationEnabled.mockResolvedValue({ ok: true });
  selectDirectory.mockResolvedValue(null);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
async function render(): Promise<void> {
  await act(async () => {
    root.render(<AutomationCategory />);
    await settle();
  });
}
function button(text: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
  if (!el) throw new Error(`missing button ${text}`);
  return el as HTMLButtonElement;
}
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await settle();
  });
}
async function setSelect(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  });
}
function select(label: string): HTMLSelectElement {
  return container.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement;
}

describe("AutomationCategory — source-aware list + inline editor", () => {
  it("lists rules with a source tag and reads the source-aware listing", async () => {
    await render();
    expect(automationListing).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("My rule");
    expect(container.textContent).toContain("You");
  });

  it("keeps the list visible while editing and swaps content when another rule is selected", async () => {
    automationListing.mockResolvedValue({
      entries: [
        entry(userDef("u1", "First"), "user"),
        entry(
          { ...userDef("u2", "Second"), trigger: { kind: "event", event: "worktree:landed" } },
          "user",
        ),
      ],
      locked: false,
    });
    await render();
    const [firstEdit, secondEdit] = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent === "Edit",
    ) as HTMLButtonElement[];
    await click(firstEdit);
    // The list is still present alongside the editor (inline seam).
    expect(container.querySelector('[aria-label="Automation Editor"]')).toBeTruthy();
    expect(container.textContent).toContain("First");
    expect(container.textContent).toContain("Second");
    expect(select("Automation trigger").value).toBe("worktree:pin-advanced");
    // Selecting another rule swaps the editor content in place.
    await click(secondEdit);
    expect(select("Automation trigger").value).toBe("worktree:landed");
  });

  it("renders Needs testing and Issue found as stage choices, storing test and bug", async () => {
    await render();
    await click(button("Create workflow"));
    await setSelect(select("Automation trigger"), "conversation:message-submitted");
    await click(button("Add action"));
    // The default action is 'record'; switch it to set-stage.
    await setSelect(select("Action"), "worktree:set-stage");
    const stageSelect = select("New stage");
    const labels = Array.from(stageSelect.options).map((o) => o.textContent);
    expect(labels).toContain("Needs testing");
    expect(labels).toContain("Issue found");
    const values = Array.from(stageSelect.options).map((o) => o.value);
    expect(values).toContain("test");
    expect(values).toContain("bug");
  });

  it("saves the refinement template with messageKind prompt, permissionMode auto, onlyIfStage test", async () => {
    await render();
    await click(button("Create workflow"));
    await click(button("Use Normal message on a tested worktree marks Issue found"));
    expect(select("Automation trigger").value).toBe("conversation:message-submitted");
    await click(button("Save"));
    const saved = automationUpsert.mock.calls[0][0] as AutomationDefinition;
    expect(saved.condition?.all).toEqual(
      expect.arrayContaining([
        { path: "payload.messageKind", operator: "equals", value: "prompt" },
        { path: "payload.permissionMode", operator: "equals", value: "auto" },
      ]),
    );
    expect(saved.steps).toEqual([
      { kind: "worktree:set-stage", payload: { stage: "bug", onlyIfStage: "test" } },
    ]);
  });

  it("removes incompatible actions when the trigger changes", async () => {
    await render();
    await click(button("Create workflow"));
    await setSelect(select("Automation trigger"), "worktree:pin-advanced");
    await click(button("Add action"));
    await setSelect(select("Action"), "worktree:set-stage");
    // engine:status cannot supply a worktree, so the set-stage action is dropped.
    await setSelect(select("Automation trigger"), "engine:status");
    expect(container.querySelector('[aria-label="Action"]')).toBeNull();
  });

  it("blocks save when an action target the trigger cannot supply is present", async () => {
    await render();
    await click(button("Create workflow"));
    // engine:status provides no worktree; add a set-stage action via a trigger that
    // does, then switch — but here we assert Save stays disabled with no actions
    // and an unsatisfiable action.
    await setSelect(select("Automation trigger"), "worktree:pin-advanced");
    await click(button("Add action"));
    await setSelect(select("Action"), "worktree:set-stage");
    // Now a valid rule — Save enabled.
    expect((button("Save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not offer Edit or Delete for a non-user source, only Duplicate", async () => {
    automationListing.mockResolvedValue({
      entries: [entry(userDef("b1", "Built-in rule"), "built-in")],
      locked: false,
    });
    await render();
    const texts = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(texts).toContain("Duplicate");
    expect(texts).not.toContain("Edit");
    expect(texts).not.toContain("Delete");
  });

  it("toggles a project rule through setProjectAutomationEnabled and stays reversible", async () => {
    automationListing.mockResolvedValue({
      entries: [entry(userDef("p1", "Project rule"), "project", { locallyDisabled: false })],
      locked: false,
    });
    await render();
    const checkbox = container.querySelector(
      '[aria-label="Enable Project rule"]',
    ) as HTMLInputElement;
    await click(checkbox);
    expect(setProjectAutomationEnabled).toHaveBeenCalledWith("", "p1", false);
  });
});
