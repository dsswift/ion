---
title: "ADR-004: Move EnterPlanMode Prose to Harness"
description: Engine ships the sentinel mechanism and a one-line fallback. The harness owns the policy prose that tells the model when to enter plan mode.
sidebar_position: 4
---

# ADR-004: Move EnterPlanMode Prose to Harness

## Status

Accepted

## Date

2026-05-25

## Context

The `EnterPlanMode` sentinel tool landed in the engine on a feature
branch with an 18-line description bundled into the
Go source:

```go
Description: `Switch the current session into plan mode.

Call this tool when the task at hand warrants careful planning before execution:
- The user has asked for a plan ("make a plan for...", "plan how to...", ...)
- The request involves multiple files, architectural changes, or non-trivial scope
- You need to confirm an approach with the user before making any changes
- A previous workflow step has completed and a follow-up plan is needed

Once called, the session switches to plan mode where:
- Only read-only tools (Read, Grep, Glob, WebFetch, WebSearch) are available
- You may write exclusively to the plan file to build your plan
- Each turn must end with AskUserQuestion (for clarification) or ExitPlanMode (plan complete)
- All code modifications are blocked until the user reviews and approves the plan

Do NOT call this tool if:
- You are already in plan mode.
- The user's request is simple enough to execute directly without planning.
- The user has just asked you to implement an existing plan — proceed directly with the work, do not re-plan.`,
```

Every line beyond the opening sentence encodes a policy decision:

- **What counts as "warranting plan mode"** — multi-file, architectural,
  non-trivial scope. Specific to one workflow.
- **What's allowed inside plan mode** — Read, Grep, Glob, WebFetch,
  WebSearch. A specific tool allowlist.
- **Turn-ending rules** — "Each turn must end with AskUserQuestion or
  ExitPlanMode." Specific to one workflow pattern.
- **When NOT to enter** — "the user has just asked you to implement an
  existing plan." This phrase only makes sense in a desktop UI that has
  an "implement this plan" affordance the user can click; a TUI, a
  headless harness, or a future domain-specific Ion build (test plan,
  design doc, RFC) has different "when not" rules.

This is the same pattern [ADR-002](./002-engine-vs-harness-early-stop.md)
corrected for the early-stop continuation `ContinueMessage`: engine
provides the mechanism (the sentinel tool, the runloop interception,
the `before_plan_mode_enter` hook), harness provides the policy (the
prose that explains the policy to the model).

The pattern keeps showing up because the temptation is identical:
"someone has to write the prose, let's put it next to the tool
definition so it's easy to find." But the tool definition is part of
the engine's API contract; the prose is part of the harness's user
experience. Co-locating them mixes layers.

## Decision

**The engine provides the mechanism and a policy-neutral one-line
fallback. The harness provides the description prose.**

### Engine responsibilities (retained)

| Concern | Rationale |
|---------|-----------|
| `EnterPlanMode` sentinel tool name + injection mechanics | Tool injection is engine plumbing |
| Runloop interception when the model calls the tool | `before_plan_mode_enter` firing, mode flip, plan-file allocation |
| One-line policy-neutral fallback description | A sane default when no harness is in the picture — e.g. operators running the engine standalone |
| Forwarding `RunOptions.EnterPlanModeDescription` verbatim | Mechanism; the engine never composes prose over the harness string |

### Engine responsibilities (removed)

| Concern | New owner | Rationale |
|---------|-----------|-----------|
| WHEN-to-enter guidance ("multi-file, architectural, non-trivial") | Harness | What counts as worth planning depends on workflow |
| WHAT-is-allowed prose ("Read, Grep, Glob…", "write exclusively to the plan file") | Harness | The tool allowlist itself is mechanical (engine resolves it), but the framing around it is policy |
| Turn-ending rules ("AskUserQuestion or ExitPlanMode") | Harness | Workflow-shape advice |
| WHEN-NOT-to-enter prose ("user has just asked you to implement an existing plan") | Harness | The desktop's plan-then-implement flow is one workflow among many |

### Wire contract addition

A new `RunOptions.EnterPlanModeDescription string` field carries the
harness's prose to the engine on every `send_prompt` dispatch. Mirrored
on `ClientCommand.EnterPlanModeDescription` for the socket wire shape.
Both are additive `omitempty` fields — third-party harnesses that don't
care about plan mode set nothing and inherit the engine's one-liner.

When set, the engine forwards the string **verbatim** as the
`EnterPlanMode` tool description. No composition, no wrapping, no
"default plus harness override" mixing. The harness either owns the
description entirely or leaves it to the engine fallback.

### Engine default

The fallback in `engine/internal/tools/enter_plan_mode.go`:

```
Switch the current session into plan mode.
```

That is the complete default. It contains zero policy. A test in
`enter_plan_mode_test.go` (`TestEnterPlanModeDefaultDescriptionIsNeutral`)
asserts the default's length is under 120 chars and that none of the
forbidden harness-specific phrases come back.

### Reference policy implementation

The desktop ships its full prose as the `ENTER_PLAN_MODE_DESCRIPTION`
constant in [`desktop/src/main/prompt-pipeline.ts`](https://github.com/dsswift/ion/blob/main/desktop/src/main/prompt-pipeline.ts).
The pipeline applies it on every engine-tab prompt dispatch (auto-mode
runs only — when `implementationPhase` is true the engine skips
`EnterPlanMode` injection entirely, so the description is harmless).
The text is the same 18-line block previously baked into the engine,
so the desktop's user-facing model behavior is unchanged from before
this ADR.

Third-party harnesses copy this constant or write their own. TUIs may
prefer minimal framing; domain-specific harnesses may want "test plan"
/ "design doc" / "RFC" language instead of "plan." Anything goes — the
engine forwards what the harness sends.

## Consequences

### Positive

- Engine code is UI-agnostic again. No 18-line policy block sitting in
  Go source. No "the user has just asked you to implement an existing
  plan" phrasing that presumes a UI affordance the operator may not
  have.
- Third-party harnesses get full control of plan-mode prose without
  forking the engine binary.
- The mechanism is unchanged from the user's perspective. The desktop
  carries the same prose the engine used to; the model sees the same
  tool description; behavior is preserved.

### Negative

- The desktop now carries text that previously lived in the engine.
  Per ADR-002's framing: "duplicating policy is the cost of
  decentralizing it. Acceptable: prose is policy."
- Adds one field to the wire contract (`enterPlanModeDescription`).
  Additive `omitempty` so consumers that don't set it see no change.

### Migration

- **Desktop users**: no change. The desktop ships the same prose as
  before via the `ENTER_PLAN_MODE_DESCRIPTION` constant.
- **Third-party harnesses**: optional. Set
  `RunOptions.EnterPlanModeDescription` (or the socket
  `enterPlanModeDescription` field) on each `send_prompt` to control
  the prose. Leave empty to inherit the engine's one-line fallback.
- **Operators running the engine standalone** (no harness): the engine's
  one-line fallback is the description the model sees. If they want
  richer prose, they wire a harness extension that sets the field, or
  they accept the minimal fallback.

## Future considerations

The harness-supplied `enterPlanModeDescription` could be made
user-overridable via a `desktop.enterPlanModeDescription` key in
`~/.ion/settings.json`. The desktop would read this on session start
and pass it through `RunOptions`. Same applies to
`earlyStopContinueMessage` per ADR-002 and any future plan-mode framing
prompts. These keys are deliberately **not** exposed in the renderer
Settings UI today; doing so would commit Ion to a UX register
(multi-line editable text with placeholder validation, "reset to
default" affordance, cross-platform iOS textarea parity) it has not
designed for. Power users who want to retrain the model's planning
behavior — plan in JSON instead of prose, plan in domain language
("test plan", "design doc", "RFC") instead of generic "plan mode" —
edit `settings.json` directly; sophisticated harness consumers fork
the desktop or write their own harness. The settings-json override
path is one PR per knob (~50 lines) when a real user asks; the
renderer Settings UI investment waits on non-zero adoption of the
JSON path. This keeps the policy/mechanism boundary clean without
committing to a UI surface area Ion has not earned the right to
charge for.

**Update (plan-mode end-of-turn discipline PR):** The symmetric prose-override
knobs anticipated above now exist. `RunOptions.PlanModePrompt` and
`RunOptions.PlanModeSparseReminder` are both wire fields (`omitempty`, additive),
with the plan_mode_prompt hook as a secondary override layer and engine defaults
as the fallback. The desktop ships its reference prose as `PLAN_MODE_SPARSE_REMINDER`
in `prompt-pipeline.ts` (parallel to `ENTER_PLAN_MODE_DESCRIPTION`) and forwards
it on every plan-mode prompt dispatch. Power users override either via
`desktop.planModePrompt` or `desktop.planModeSparseReminder` in
`~/.ion/settings.json`, following this ADR's pattern exactly. See
[settings-json.md](../../configuration/settings-json.md#desktop-power-user-overrides)
and [Plan mode prose overrides](../../sessions/lifecycle.md#plan-mode-prose-overrides)
for full documentation.

## Related

- [ADR-001](./001-engine-vs-harness.md) — the parent principle this ADR concretely applies.
- [ADR-002](./002-engine-vs-harness-early-stop.md) — sibling application of the same boundary to the early-stop `ContinueMessage`.
- [ADR-003](./003-state-events-vs-workflow-events.md) — adjacent plan-mode work (state vs workflow events).
- [`engine/internal/tools/enter_plan_mode.go`](https://github.com/dsswift/ion/blob/main/engine/internal/tools/enter_plan_mode.go) — engine side: sentinel tool, fallback, `WithDescription` constructor.
- [`desktop/src/main/prompt-pipeline.ts`](https://github.com/dsswift/ion/blob/main/desktop/src/main/prompt-pipeline.ts) — desktop reference policy: `ENTER_PLAN_MODE_DESCRIPTION` constant + pipeline integration.
- [`docs/engine-grounding.md`](../../engine-grounding.md) — house rules including "engine executes, harness decides."
