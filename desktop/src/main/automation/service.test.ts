import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { continueAutomationCausation } from "./causation";
import { AutomationHistoryStore } from "./history";
import { mergeAutomationLayers } from "./merge";
import { AutomationService } from "./service";
import { AutomationStore } from "./store";
import { selfCycleAdvisory } from "./declarative";
import type { AutomationDefinition } from "./types";

function automation(id: string, event = "git:changed"): AutomationDefinition {
  return {
    id,
    name: id,
    enabled: true,
    trigger: { kind: "event", event },
    actions: [{ kind: "record" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("automation foundations", () => {
  it("applies layers by identifier and honors enterprise removals", () => {
    const effective = mergeAutomationLayers({
      builtIn: [automation("built-in"), automation("shared")],
      user: [
        { ...automation("shared"), name: "user replacement" },
        automation("user"),
      ],
      enterprise: {
        definitions: [
          { ...automation("shared"), name: "enterprise replacement" },
        ],
        disabledIds: ["user"],
        locked: true,
        maxHistoryEntries: 12,
      },
    });
    expect(effective.definitions.map(({ id, name }) => ({ id, name }))).toEqual(
      [
        { id: "built-in", name: "built-in" },
        { id: "shared", name: "enterprise replacement" },
      ],
    );
    expect(effective).toMatchObject({ locked: true, maxHistoryEntries: 12 });
  });

  it("uses exact causal identity to prevent cycles and depth overflow", () => {
    const root = { rootId: "root", chain: [], depth: 0 };
    const first = continueAutomationCausation(root, "first", 2);
    expect(first).toMatchObject({
      ok: true,
      causation: { chain: ["first"], depth: 1 },
    });
    if (!first.ok) throw new Error("expected causation");
    expect(continueAutomationCausation(first.causation, "first", 2)).toEqual({
      ok: false,
      reason: "cycle",
    });
    const second = continueAutomationCausation(first.causation, "second", 2);
    expect(second).toMatchObject({
      ok: true,
      causation: { chain: ["first", "second"], depth: 2 },
    });
    if (!second.ok) throw new Error("expected causation");
    expect(continueAutomationCausation(second.causation, "third", 2)).toEqual({
      ok: false,
      reason: "max-depth",
    });
  });

  it("persists only user layer atomically and executes effective automation with history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ion-automation-"));
    const store = new AutomationStore(join(directory, "automation"));
    const history = new AutomationHistoryStore(join(directory, "history.json"));
    const service = new AutomationService({
      store,
      history,
      builtIn: [automation("built-in")],
      enterprise: {
        definitions: [automation("enterprise")],
        maxHistoryEntries: 1,
      },
    });
    service.saveUserDefinitions([automation("user")]);
    const ran: string[] = [];
    const result = await service.evaluate(
      { type: "git:changed" },
      async ({ automation }) => {
        ran.push(automation.id);
      },
    );

    expect(ran).toEqual(["built-in", "user", "enterprise"]);
    expect(result.map((entry) => entry.outcome)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect([
      ...new Set(result.map((entry) => entry.causation?.rootId)),
    ]).toHaveLength(1);
    expect(store.load().map((item) => item.id)).toEqual(["user"]);
    expect(history.load()).toHaveLength(1);
    expect(
      JSON.parse(
        readFileSync(join(directory, "automation", "user.json"), "utf8"),
      ),
    ).toMatchObject({ version: 2 });
  });

  it("reads current enterprise policy at each operation", () => {
    let locked = false;
    const directory = mkdtempSync(join(tmpdir(), "ion-automation-"));
    const service = new AutomationService({
      store: new AutomationStore(join(directory, "automation")),
      enterprisePolicy: () => ({ locked }),
    });
    service.saveUserDefinitions([automation("user")]);
    locked = true;
    expect(() => service.saveUserDefinitions([automation("other")])).toThrow(
      "Enterprise policy locks automation changes",
    );
  });
});

describe("declarative automation evaluation", () => {
  it("matches all and any groups through dotted paths", async () => {
    const definition: AutomationDefinition = {
      ...automation("conditional"),
      condition: {
        all: [
          { path: "payload.worktree.stage", operator: "equals", value: "test" },
        ],
        any: [
          {
            path: "payload.priority",
            operator: "greater-than-or-equals",
            value: 3,
          },
          { path: "payload.labels", operator: "contains", value: "urgent" },
        ],
      },
      steps: [{ kind: "record" }],
      actions: undefined,
    };
    const directory = mkdtempSync(join(tmpdir(), "ion-automation-"));
    const service = new AutomationService({
      store: new AutomationStore(join(directory, "automation")),
      builtIn: [definition],
    });
    const ran: string[] = [];
    await service.evaluate(
      {
        type: "git:changed",
        payload: {
          worktree: { stage: "test" },
          priority: 2,
          labels: ["urgent"],
        },
      },
      async ({ action }) => {
        ran.push(action.kind);
      },
    );
    await service.evaluate(
      {
        type: "git:changed",
        payload: { worktree: { stage: "test" }, priority: 2, labels: [] },
      },
      async ({ action }) => {
        ran.push(action.kind);
      },
    );
    expect(ran).toEqual(["record"]);
  });

  it("runs selected branches before later ordered steps", async () => {
    const definition: AutomationDefinition = {
      ...automation("ordered"),
      steps: [
        { kind: "first" },
        {
          type: "branch",
          condition: {
            all: [
              { path: "payload.approved", operator: "equals", value: true },
            ],
          },
          then: [{ kind: "then" }],
          else: [{ kind: "else" }],
        },
        { kind: "last" },
      ],
      actions: undefined,
    };
    const directory = mkdtempSync(join(tmpdir(), "ion-automation-"));
    const service = new AutomationService({
      store: new AutomationStore(join(directory, "automation")),
      builtIn: [definition],
    });
    const order: string[] = [];
    await service.evaluate(
      { type: "git:changed", payload: { approved: true } },
      async ({ action }) => {
        order.push(action.kind);
      },
    );
    expect(order).toEqual(["first", "then", "last"]);
  });
});

it("advises self-triggering definitions while exact causation blocks loop", async () => {
  const definition: AutomationDefinition = {
    ...automation("stage-loop", "worktree:stage-changed"),
    steps: [{ kind: "worktree:set-stage" }],
    actions: undefined,
  };
  const directory = mkdtempSync(join(tmpdir(), "ion-automation-"));
  const service = new AutomationService({
    store: new AutomationStore(join(directory, "automation")),
    builtIn: [definition],
  });
  const parent = { rootId: "root", chain: ["stage-loop"], depth: 1 };
  const result = await service.evaluate(
    { type: "worktree:stage-changed" },
    async () => {},
    parent,
  );
  expect(selfCycleAdvisory(definition)).toBe("possible-self-cycle");
  expect(result).toEqual([
    { automationId: "stage-loop", outcome: "skipped", reason: "cycle" },
  ]);
});

describe("project automation source", () => {
  it("loads project definitions only for the event project", async () => {
    const root = mkdtempSync(join(tmpdir(), "ion-automation-project-"));
    const project = join(root, "repo");
    const { mkdirSync, writeFileSync } = await import("fs");
    mkdirSync(join(project, ".ion", "automation"), { recursive: true });
    const definition = {
      ...automation("project-rule"),
      steps: [{ kind: "record" }],
      actions: undefined,
    };
    writeFileSync(
      join(project, ".ion", "automation", "project-rule.json"),
      JSON.stringify({ version: 2, definitions: [definition] }),
    );
    const service = new AutomationService({
      store: new AutomationStore(join(root, "user")),
    });
    const ran: string[] = [];
    await service.evaluate(
      { type: "git:changed", payload: { projectPath: project } },
      async ({ automation }) => {
        ran.push(automation.id);
      },
      undefined,
      project,
    );
    expect(ran).toEqual(["project-rule"]);
    await service.evaluate(
      { type: "git:changed", payload: {} },
      async ({ automation }) => {
        ran.push(automation.id);
      },
    );
    expect(ran).toEqual(["project-rule"]);
  });
});

describe("automation evaluation traces", () => {
  it("persists trigger, condition, branch, action, and causation decisions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ion-automation-trace-"));
    const history = new AutomationHistoryStore(join(directory, "history.json"));
    const service = new AutomationService({
      store: new AutomationStore(join(directory, "automation")),
      history,
      builtIn: [
        {
          ...automation("traceable"),
          condition: {
            all: [{ path: "payload.enabled", operator: "equals", value: true }],
          },
          steps: [
            {
              type: "branch",
              condition: {
                all: [
                  { path: "payload.approved", operator: "equals", value: true },
                ],
              },
              then: [{ kind: "then" }],
              else: [{ kind: "else" }],
            },
          ],
          actions: undefined,
        },
      ],
    });

    await service.evaluate(
      {
        type: "git:changed",
        occurredAt: "2026-01-02T03:04:05.000Z",
        payload: { enabled: true, approved: false },
      },
      async () => {},
    );

    expect(history.load()[0]?.trace).toMatchObject({
      trigger: {
        eventType: "git:changed",
        occurredAt: "2026-01-02T03:04:05.000Z",
      },
      condition: {
        type: "group",
        matched: true,
        all: [{ path: "payload.enabled", matched: true, actual: true }],
      },
      causation: { decision: "continued", input: { depth: 0 } },
      steps: [
        {
          type: "branch",
          selected: "else",
          condition: { matched: false },
          steps: [{ type: "action", kind: "else", outcome: "succeeded" }],
        },
      ],
    });
  });

  it("persists a skipped condition decision", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ion-automation-trace-"));
    const history = new AutomationHistoryStore(join(directory, "history.json"));
    const service = new AutomationService({
      store: new AutomationStore(join(directory, "automation")),
      history,
      builtIn: [
        {
          ...automation("condition-skip"),
          condition: {
            all: [{ path: "payload.enabled", operator: "equals", value: true }],
          },
        },
      ],
    });

    const result = await service.evaluate(
      { type: "git:changed", payload: { enabled: false } },
      async () => {},
    );

    expect(result).toMatchObject([{ outcome: "skipped", reason: "condition" }]);
    expect(history.load()[0]?.trace).toMatchObject({
      condition: { matched: false },
      causation: { decision: "not-evaluated" },
      steps: [],
    });
  });
});
