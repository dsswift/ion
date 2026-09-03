import { describe, expect, it } from "vitest";
import {
  AUTOMATION_TRIGGERS,
  automationField,
  automationTrigger,
  validateUserDefinition,
} from "../automation-catalog";
import { WORK_STAGES } from "../types-git";
import type { AutomationDefinition } from "../types-automation";

function definition(
  event: string,
  patch: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  return {
    id: "user.test",
    name: "Test",
    enabled: true,
    trigger: { kind: "event", event },
    steps: [{ kind: "record" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("automation catalog", () => {
  it("exposes the message-submitted authorship fields", () => {
    const trigger = automationTrigger("conversation:message-submitted");
    expect(trigger).toBeDefined();
    const paths = trigger?.fields.map((f) => f.path) ?? [];
    for (const path of [
      "payload.messageKind",
      "payload.permissionMode",
      "payload.isSteer",
      "payload.source",
      "payload.worktreePath",
      "payload.stage",
    ])
      expect(paths).toContain(path);
  });

  it("pins the worktree stage field values to WORK_STAGES", () => {
    const trigger = automationTrigger("worktree:stage-changed");
    const stage = trigger && automationField(trigger, "payload.stage");
    expect(stage?.values?.map((v) => v.value)).toEqual(
      WORK_STAGES.map((s) => s.id),
    );
  });

  it("marks engine:status as unable to supply a worktree target", () => {
    expect(automationTrigger("engine:status")?.provides.worktree).toBe(false);
  });

  it("validates the two-way refinement definition", () => {
    const refinement = definition("conversation:message-submitted", {
      condition: {
        all: [
          { path: "payload.worktreePath", operator: "exists" },
          { path: "payload.stage", operator: "equals", value: "test" },
          { path: "payload.messageKind", operator: "equals", value: "prompt" },
          { path: "payload.permissionMode", operator: "equals", value: "auto" },
        ],
      },
      steps: [
        {
          kind: "worktree:set-stage",
          payload: { stage: "bug", onlyIfStage: "test" },
        },
      ],
    });
    expect(validateUserDefinition(refinement)).toEqual({ ok: true });
  });

  it("rejects an unknown trigger event", () => {
    const result = validateUserDefinition(definition("git:changed"));
    expect(result.ok).toBe(false);
  });

  it("rejects a condition field the trigger does not carry", () => {
    const result = validateUserDefinition(
      definition("conversation:message-submitted", {
        condition: { all: [{ path: "payload.previousStage", operator: "exists" }] },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a finite value outside the field's choices", () => {
    const result = validateUserDefinition(
      definition("conversation:message-submitted", {
        condition: {
          all: [{ path: "payload.stage", operator: "equals", value: "shipping" }],
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an action whose target the trigger cannot supply", () => {
    // engine:status has no worktree, so worktree:set-stage cannot run from it.
    const result = validateUserDefinition(
      definition("engine:status", {
        steps: [{ kind: "worktree:set-stage", payload: { stage: "bug" } }],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a worktree action from a trigger that supplies a worktree", () => {
    const result = validateUserDefinition(
      definition("worktree:pin-advanced", {
        steps: [{ kind: "worktree:set-stage", payload: { stage: "test" } }],
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a required action config field that is missing", () => {
    const result = validateUserDefinition(
      definition("conversation:message-submitted", {
        steps: [{ kind: "desktop:notification", payload: {} }],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("every trigger field lists at least one operator", () => {
    for (const trigger of AUTOMATION_TRIGGERS)
      for (const field of trigger.fields)
        expect(field.operators.length).toBeGreaterThan(0);
  });
});
