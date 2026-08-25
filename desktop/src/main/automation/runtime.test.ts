import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { AutomationHistoryStore } from "./history";
import { AutomationRuntime } from "./runtime";
import { AutomationService } from "./service";
import { AutomationStore } from "./store";
import type { AutomationDefinition } from "./types";

const definition: AutomationDefinition = {
  id: "record-prompt",
  name: "Record prompt",
  enabled: true,
  trigger: { kind: "event", event: "prompt:submitted" },
  actions: [{ kind: "record" }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function runtimeFor(
  action: import("./types").AutomationAction,
  enterprise?: {
    definitions?: AutomationDefinition[];
    authorizeAiActions?: boolean;
  },
) {
  const directory = mkdtempSync(join(tmpdir(), "ion-automation-runtime-"));
  const automation = { ...definition, id: "runner", actions: [action] };
  const service = new AutomationService({
    builtIn: [automation],
    enterprisePolicy: () => enterprise,
    store: new AutomationStore(join(directory, "automations")),
    history: new AutomationHistoryStore(join(directory, "history.json")),
  });
  return service;
}

describe("automation runtime", () => {
  it("starts without shipped workflows", () => {
    const directory = mkdtempSync(join(tmpdir(), "ion-automation-runtime-"));
    const service = new AutomationService({
      store: new AutomationStore(join(directory, "automations")),
      history: new AutomationHistoryStore(join(directory, "history.json")),
    });
    expect(new AutomationRuntime(service).definitions()).toEqual([]);
  });

  it("evaluates trigger and broadcasts typed execution outcome", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ion-automation-runtime-"));
    const service = new AutomationService({
      builtIn: [definition],
      store: new AutomationStore(join(directory, "automations.json")),
      history: new AutomationHistoryStore(join(directory, "history.json")),
    });
    const emit = vi.fn();
    const runtime = new AutomationRuntime(service, emit);

    await runtime.trigger({
      type: "prompt:submitted",
      payload: { tabId: "tab-1" },
    });

    expect(emit).toHaveBeenCalledWith({
      type: "automation:executed",
      automationId: "record-prompt",
      eventType: "prompt:submitted",
      outcome: "succeeded",
      worktreePath: undefined,
    });
    expect(service.historyEntries()).toHaveLength(1);
  });

  it("runs desktop notifications with validated title and body", async () => {
    const notify = vi.fn();
    const runtime = new AutomationRuntime(
      runtimeFor({
        kind: "desktop:notification",
        payload: { title: "Build done", body: "Ready to review" },
      }),
      vi.fn(),
      vi.fn(),
      notify,
    );
    await runtime.trigger({ type: "prompt:submitted" });
    expect(notify).toHaveBeenCalledWith("Build done", "Ready to review");
  });

  it("routes AI actions through acknowledged renderer commands", async () => {
    const runRendererCommand = vi.fn().mockResolvedValue(undefined);
    const action = {
      kind: "conversation:slash",
      payload: { directory: "/repo", command: "align" },
    };
    const runtime = new AutomationRuntime(
      runtimeFor(action),
      vi.fn(),
      runRendererCommand,
    );
    await runtime.trigger({ type: "prompt:submitted" });
    expect(runRendererCommand).toHaveBeenCalledWith(action);
  });

  it("does not treat a resolved-slash event as an executable action", async () => {
    const runRendererCommand = vi.fn().mockResolvedValue(undefined);
    const runtime = new AutomationRuntime(
      runtimeFor({
        kind: "conversation:slash-resolved",
        payload: { directory: "/repo", command: "align" },
      }),
      vi.fn(),
      runRendererCommand,
    );

    await runtime.trigger({ type: "prompt:submitted" });

    expect(runRendererCommand).not.toHaveBeenCalled();
    expect(runtime.history()[0]).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("Unsupported automation action"),
    });
  });

  it("refuses enterprise AI actions without standing authorization", async () => {
    const action = {
      kind: "conversation:run",
      payload: { directory: "/repo", prompt: "Review changes" },
    };
    const enterpriseDefinition = {
      ...definition,
      id: "runner",
      actions: [action],
    };
    const runtime = new AutomationRuntime(
      runtimeFor(action, {
        definitions: [enterpriseDefinition],
        authorizeAiActions: false,
      }),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      () => ({
        definitions: [enterpriseDefinition],
        authorizeAiActions: false,
      }),
    );
    await runtime.trigger({ type: "prompt:submitted" });
    expect(runtime.history()[0]).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("not authorized"),
      trace: {
        steps: [
          {
            type: "action",
            kind: "conversation:run",
            outcome: "failed",
            error: expect.stringContaining("not authorized"),
          },
        ],
      },
    });
  });

  it("delivers plan implementation with prompt context", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ion-automation-runtime-"));
    const planDefinition: AutomationDefinition = {
      ...definition,
      id: "record-plan",
      trigger: { kind: "event", event: "plan:implemented" },
    };
    const service = new AutomationService({
      builtIn: [planDefinition],
      store: new AutomationStore(join(directory, "automations.json")),
      history: new AutomationHistoryStore(join(directory, "history.json")),
    });
    const runtime = new AutomationRuntime(service, vi.fn());
    await runtime.trigger({
      type: "prompt:submitted",
      payload: { tabId: "tab-1", projectPath: "/repo" },
    });

    await runtime.triggerPlanImplemented("tab-1", {
      planFilePath: "/repo/plan.md",
      source: "renderer",
    });

    expect(service.historyEntries()[0]).toMatchObject({
      eventType: "plan:implemented",
      outcome: "succeeded",
    });
  });

  it("delivers source-tagged stage change facts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ion-automation-runtime-"));
    const stageDefinition: AutomationDefinition = {
      ...definition,
      id: "record-stage-change",
      trigger: { kind: "event", event: "worktree:stage-changed" },
    };
    const service = new AutomationService({
      builtIn: [stageDefinition],
      store: new AutomationStore(join(directory, "automations.json")),
      history: new AutomationHistoryStore(join(directory, "history.json")),
    });
    const runtime = new AutomationRuntime(service, vi.fn());
    await runtime.triggerStageChange({
      worktreePath: "/worktree",
      previousStage: "bug",
      stage: "test",
      source: "automation",
      automationId: "advance-stage",
    });
    expect(service.historyEntries()[0]).toMatchObject({
      eventType: "worktree:stage-changed",
      outcome: "succeeded",
    });
  });
});

it('preserves parent causation into terminal completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ion-automation-completion-'))
  const completionDefinition: AutomationDefinition = {
    ...definition,
    id: 'completion-loop',
    trigger: { kind: 'event', event: 'conversation:completed' },
    actions: [{ kind: 'record' }],
  }
  const service = new AutomationService({
    builtIn: [completionDefinition],
    store: new AutomationStore(join(directory, 'automation')),
    history: new AutomationHistoryStore(join(directory, 'history.json')),
  })
  const runtime = new AutomationRuntime(service, vi.fn())
  await runtime.triggerCompletion(
    'tab-completion',
    { reason: 'done' },
    { rootId: 'root', chain: ['completion-loop'], depth: 1 },
  )
  expect(service.historyEntries()[0]).toMatchObject({
    automationId: 'completion-loop',
    outcome: 'skipped',
    error: 'causation:cycle',
  })
})
