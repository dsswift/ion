import { describe, expect, it } from "vitest";
import { evaluateCondition, matchesCondition } from "./declarative";
import type { AutomationConditionGroup, AutomationEvent } from "./types";
import type { AutomationConditionOperator } from "../../shared/types-automation";

function evented(payload: Record<string, unknown>): AutomationEvent {
  return { type: "conversation:message-submitted", payload };
}

function condition(
  path: string,
  operator: AutomationConditionOperator,
  value?: unknown,
): AutomationConditionGroup {
  return { all: [{ path, operator, value: value as never }] };
}

describe("declarative condition evaluation — fail closed on absent paths", () => {
  it("exists matches a present non-null value and rejects absent and null", () => {
    expect(
      matchesCondition(condition("payload.stage", "exists"), evented({ stage: "test" })),
    ).toBe(true);
    expect(
      matchesCondition(condition("payload.stage", "exists"), evented({})),
    ).toBe(false);
    expect(
      matchesCondition(condition("payload.stage", "exists"), evented({ stage: null })),
    ).toBe(false);
  });

  it("not-exists matches an absent or null value", () => {
    expect(
      matchesCondition(condition("payload.stage", "not-exists"), evented({})),
    ).toBe(true);
    expect(
      matchesCondition(
        condition("payload.stage", "not-exists"),
        evented({ stage: null }),
      ),
    ).toBe(true);
    expect(
      matchesCondition(
        condition("payload.stage", "not-exists"),
        evented({ stage: "test" }),
      ),
    ).toBe(false);
  });

  it("not-equals returns true when the path is absent", () => {
    // undefined ≠ any value, so "stage is not bug" is vacuously satisfied when
    // there is no stage field. This lets rules omit "Worktree is present"
    // guards — a worktree action on a non-worktree event is skipped at runtime.
    expect(
      matchesCondition(
        condition("payload.stage", "not-equals", "bug"),
        evented({}),
      ),
    ).toBe(true);
    expect(
      matchesCondition(
        condition("payload.stage", "not-equals", "bug"),
        evented({ stage: "test" }),
      ),
    ).toBe(true);
    expect(
      matchesCondition(
        condition("payload.stage", "not-equals", "bug"),
        evented({ stage: "bug" }),
      ),
    ).toBe(false);
  });

  it("not-contains returns true when the path is absent", () => {
    // Same polarity rule as not-equals: a missing field contains nothing.
    expect(
      matchesCondition(
        condition("payload.tags", "not-contains", "x"),
        evented({}),
      ),
    ).toBe(true);
    expect(
      matchesCondition(
        condition("payload.tags", "not-contains", "x"),
        evented({ tags: ["y", "z"] }),
      ),
    ).toBe(true);
    expect(
      matchesCondition(
        condition("payload.tags", "not-contains", "x"),
        evented({ tags: ["x", "z"] }),
      ),
    ).toBe(false);
  });

  it("returns false for positive operators walked through a malformed path", () => {
    // payload.stage is a string, so payload.stage.name walks through a
    // non-object and resolves to undefined. Positive operators fail closed.
    expect(
      matchesCondition(
        condition("payload.stage.name", "equals", "bug"),
        evented({ stage: "test" }),
      ),
    ).toBe(false);
  });

  it("returns true for not-equals walked through a malformed path", () => {
    // undefined ≠ "bug", so not-equals returns true even for a malformed walk.
    expect(
      matchesCondition(
        condition("payload.stage.name", "not-equals", "bug"),
        evented({ stage: "test" }),
      ),
    ).toBe(true);
  });

  it("treats a present JSON null as a real value for equality", () => {
    expect(
      matchesCondition(
        condition("payload.stage", "equals", null),
        evented({ stage: null }),
      ),
    ).toBe(true);
    expect(
      matchesCondition(
        condition("payload.stage", "not-equals", "bug"),
        evented({ stage: null }),
      ),
    ).toBe(true);
  });

  it("evaluates string, array, pattern, and numeric operators against present values", () => {
    expect(
      matchesCondition(
        condition("payload.name", "contains", "efine"),
        evented({ name: "refinement" }),
      ),
    ).toBe(true);
    expect(
      matchesCondition(
        condition("payload.tags", "contains", "b"),
        evented({ tags: ["a", "b"] }),
      ),
    ).toBe(true);
    expect(
      matchesCondition(
        condition("payload.name", "matches", "^ref"),
        evented({ name: "refinement" }),
      ),
    ).toBe(true);
    expect(
      matchesCondition(
        condition("payload.count", "greater-than", 2),
        evented({ count: 3 }),
      ),
    ).toBe(true);
    expect(
      matchesCondition(
        condition("payload.count", "greater-than", 2),
        evented({}),
      ),
    ).toBe(false);
  });

  it("keeps the path and match in a trace without inventing an absent actual value", () => {
    // not-equals on absent field → matched: true (vacuous negative).
    // The trace must not fabricate an `actual` value for the absent field.
    const decision = evaluateCondition(
      condition("payload.stage", "not-equals", "bug"),
      evented({}),
    );
    if (decision.type !== "group") throw new Error("expected group decision");
    const [row] = decision.all;
    if (row.type !== "condition") throw new Error("expected condition decision");
    expect(row.path).toBe("payload.stage");
    expect(row.matched).toBe(true);
    expect("actual" in row).toBe(false);
  });
});
