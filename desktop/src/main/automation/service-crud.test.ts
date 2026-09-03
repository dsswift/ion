/**
 * Source-aware listing and user-only CRUD.
 *
 * The security property under test: a user mutation can never copy a project,
 * enterprise, or built-in definition into the user store (`~/.ion/automation`).
 * Duplicate is the only way a non-user rule becomes editable, and it always
 * produces a NEW user id.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../logger", () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => process.env.ION_TEST_HOME_AUTOMATION_CRUD || actual.homedir(),
  };
});

import { AutomationService } from "./service";
import { AutomationStore, automationDirectory } from "./store";
import type { AutomationDefinition } from "./types";

function def(id: string, name = id): AutomationDefinition {
  return {
    id,
    name,
    enabled: true,
    trigger: { kind: "event", event: "conversation:message-submitted" },
    steps: [{ kind: "record" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

let root: string;
let projectPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ion-automation-crud-"));
  mkdirSync(join(root, "home", ".ion"), { recursive: true });
  process.env.ION_TEST_HOME_AUTOMATION_CRUD = join(root, "home");
  projectPath = join(root, "project");
  mkdirSync(join(projectPath, ".ion", "automation"), { recursive: true });
  writeFileSync(
    join(projectPath, ".ion", "automation", "proj.json"),
    JSON.stringify({ version: 2, definitions: [def("proj", "Project rule")] }),
  );
});

afterEach(() => {
  delete process.env.ION_TEST_HOME_AUTOMATION_CRUD;
  rmSync(root, { recursive: true, force: true });
});

function service(): AutomationService {
  return new AutomationService({ builtIn: [def("built-in", "Built-in rule")] });
}

describe("source-aware listing", () => {
  it("lists every source layer with effective flags", () => {
    const svc = service();
    svc.saveUserDefinition(def("user", "User rule"));
    const listing = svc.listing(projectPath);
    const bySource = Object.fromEntries(
      listing.entries.map((e) => [e.source, e]),
    );
    expect(bySource["built-in"]?.definition.id).toBe("built-in");
    expect(bySource["user"]?.definition.id).toBe("user");
    expect(bySource["project"]?.definition.id).toBe("proj");
    for (const entry of listing.entries) expect(entry.effective).toBe(true);
  });

  it("keeps a locally disabled project rule visible and not effective", () => {
    const svc = service();
    svc.setProjectDefinitionEnabled("proj", false, projectPath);
    const project = svc
      .listing(projectPath)
      .entries.find((e) => e.source === "project" && e.definition.id === "proj");
    expect(project).toBeDefined();
    expect(project?.locallyDisabled).toBe(true);
    expect(project?.effective).toBe(false);
    // And it is absent from the effective set the runtime evaluates.
    expect(svc.effective(projectPath).definitions.map((d) => d.id)).not.toContain(
      "proj",
    );
  });
});

describe("user-only CRUD preserves source ownership", () => {
  it("duplicating a project rule writes a NEW user id, never the project id", () => {
    const svc = service();
    const copy = svc.duplicateDefinition("proj", projectPath);
    expect(copy.id).not.toBe("proj");
    expect(copy.enabled).toBe(false);
    const userIds = new AutomationStore().load().map((d) => d.id);
    expect(userIds).toContain(copy.id);
    expect(userIds).not.toContain("proj");
    // No file named proj.json in the user store directory.
    const files = readdirSync(automationDirectory());
    expect(files).not.toContain("proj.json");
  });

  it("duplicating a built-in rule cannot copy the built-in id into the user store", () => {
    const svc = service();
    const copy = svc.duplicateDefinition("built-in");
    expect(copy.id).not.toBe("built-in");
    const userIds = new AutomationStore().load().map((d) => d.id);
    expect(userIds).not.toContain("built-in");
  });

  it("saveUserDefinition rejects a rule that cannot run", () => {
    const svc = service();
    expect(() =>
      svc.saveUserDefinition({ ...def("bad"), trigger: { kind: "event", event: "git:changed" } }),
    ).toThrow();
    expect(new AutomationStore().load()).toHaveLength(0);
  });

  it("deleteUserDefinition removes exactly one user rule", () => {
    const svc = service();
    svc.saveUserDefinition(def("a"));
    svc.saveUserDefinition(def("b"));
    svc.deleteUserDefinition("a");
    expect(new AutomationStore().load().map((d) => d.id)).toEqual(["b"]);
  });

  it("an enterprise lock blocks user mutations but not listing", () => {
    const locked = new AutomationService({
      builtIn: [def("built-in")],
      enterprisePolicy: () => ({ locked: true }),
    });
    expect(() => locked.saveUserDefinition(def("x"))).toThrow(/locks/);
    expect(() => locked.duplicateDefinition("built-in")).toThrow(/locks/);
    expect(locked.listing(projectPath).locked).toBe(true);
    expect(
      locked.listing(projectPath).entries.some((e) => e.definition.id === "proj"),
    ).toBe(true);
  });
});
