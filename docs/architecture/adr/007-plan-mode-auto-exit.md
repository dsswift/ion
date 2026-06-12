---
title: "ADR-007: Deterministic Plan-Mode Exit Safety Net"
description: The engine deterministically synthesizes ExitPlanMode at end-of-turn when a plan-mode run terminates without the model invoking the sentinel tool, so consumers reliably see the plan-approval card instead of the conversation being parked.
sidebar_position: 7
---

# ADR-007: Deterministic Plan-Mode Exit Safety Net

## Status

Accepted

## Date

2026-06-06

## Context

Plan mode is a published engine contract: the model produces a plan
file, then invokes the `ExitPlanMode` sentinel tool so consumers can
render an approval card. The contract has worked reliably for
single-turn / short-context runs since plan mode was introduced.

In long-running, large-context conversations — observed concretely in
conversation `1780434358497-2a573297a200`, the originating report for
this ADR — the contract can break in a specific and reproducible way:

1. The model writes the plan file correctly.
2. The model's final assistant turn says, in prose, that the plan is
   ready for review ("Ready for your review", "exiting", "ExitPlanMode
   ready").
3. The model's tool invocation is **not** `ExitPlanMode` but rather
   `Bash` with `echo "ExitPlanMode ready"` or `echo "exiting"` — a
   no-op shell command where the model's intent was to call the
   sentinel tool.

The run terminates cleanly with stop reason `end_turn`. The plan file
exists on disk. But because the sentinel was never invoked, the
existing `interceptExitPlanMode` path (in `runloop_plan_mode_gates.go`)
never fires; no `PermissionDenial` is recorded; no
`PlanProposalEvent{Kind:"exit"}` is emitted; `TaskCompleteEvent` ships
with empty `PermissionDenials`. The conversation is left parked in
plan mode with the plan file invisible to the user.

There is no engine-side recovery primitive from this state. The
existing safeguards — the per-turn `[SYSTEM] Plan mode still active`
reminder injected from `plan_mode_prompt.go` — are advisory text. They
nudge the model on the *next* turn but cannot recover the current run.

The problem generalizes beyond the Bash-echo case: any final
assistant turn that ends with `end_turn` / `stop` and does not contain
a `tool_use` for `ExitPlanMode` or `AskUserQuestion` is a stuck-in-
plan-mode bug waiting to happen. Examples include:

- text-only final turns with no tool calls at all (model says "done"
  and stops),
- final turns that call other tools (Bash, Read, Glob) but not
  ExitPlanMode,
- final turns where the model emits a structurally-correct response
  shape but with the wrong tool name.

Stronger prompt-level guidance — already extensive in
`plan_mode_prompt.go` — does not give the engine a deterministic
recovery primitive. Only a state-machine completion at the engine
level does.

## Decision

The engine deterministically synthesizes an `ExitPlanMode` call at the
end of any plan-mode run that terminates with stop reason `end_turn`
or `stop` and does not contain an `ExitPlanMode` or `AskUserQuestion`
tool_use in the final assistant turn.

The synthesis path:

1. Sets `run.exitPlanMode = true`.
2. Appends a synthetic `types.PermissionDenial` whose `ToolName` is
   `"ExitPlanMode"`, `ToolUseID` is engine-origin
   (`"synth-exit-plan-{runID}-t{turn}-{ns}"`), and `ToolInput` carries
   `{"planFilePath": …, "synthesized": true, "reason": …}`.
3. Emits a new `engine_plan_mode_auto_exit` normalized event before
   the canonical `engine_plan_proposal{kind:"exit"}` so consumers can
   distinguish engine-synthesized exits from model-driven ones.
4. Emits `TaskCompleteEvent` with the synthetic denial in
   `PermissionDenials` so legacy consumers keying off the denial path
   continue to render approval cards unchanged.
5. Logs at `Warn` level with the runID, sessionID, planFilePath, and
   the list of tools the model did emit on the final turn.

Configurability follows the same three-layer precedence pattern as
the early-stop continuation feature (ADR-002):

| Layer | Field | Default |
|-------|-------|---------|
| engine.json | `limits.planModeAutoExitOnEndTurn` | `true` |
| RunOptions | `planModeAutoExit *bool` | `nil` (inherit config) |
| Extension SDK | `before_plan_mode_auto_exit` hook | no opinion |

The hook receives the resolved `PlanFilePath`, the concatenated
assistant text, and the list of tools the model emitted this turn,
and may suppress the synthesis, override the plan file path, or
override the human-readable reason. Last writer wins per field across
multiple handlers — same merge semantics as
`before_plan_mode_exit` / `before_early_stop_decision`.

The safety net is **on by default**. Rationale: the stuck-in-plan-mode
failure mode the synthesis defends against is strictly worse than the
(cheap, idempotent) synthesis path. A consumer that finds the
synthesis inappropriate for its automation policy can flip the config
field to `false` or wire the hook to return `Suppress: true`. A
consumer that does nothing inherits the safe behaviour.

## Consequences

### Positive

- Plan mode becomes a deterministic state machine: a plan-mode run
  always ends with the plan surfaced to the user, regardless of
  which tool the model chose for the final turn.
- Long-running / large-context plan-mode runs no longer have a
  stuck-state failure mode that requires manual recovery.
- Consumers gain a typed event (`engine_plan_mode_auto_exit`) for
  telemetry on prompt quality, separate from the model-driven exit
  path, enabling feedback loops that track misrouting frequency.
- Harnesses with strict automation policies retain full control via
  the new `before_plan_mode_auto_exit` hook and the per-run
  `RunOptions.PlanModeAutoExit` override.

### Negative

- The engine now produces a new flat-EngineEvent shape
  (`planModeAutoExit*` prefixed fields). Adding fields to
  `EngineEvent` is additive but does grow the wire schema.
- The synthesized `PermissionDenial.ToolUseID` is not a
  provider-issued ID. Consumers that try to correlate denial IDs
  against provider tool-call logs will not find a match for
  synthesized denials. The `synthesized: true` flag in
  `ToolInput` lets consumers detect this case; the
  `engine_plan_mode_auto_exit` event is the typed-event counterpart.
- Harnesses that previously relied on "if my plan-mode run completes
  without ExitPlanMode, it must be stuck" as a signal must migrate to
  inspecting the new event or setting `planModeAutoExit = false` to
  preserve the old behaviour.

### Neutral

- The synthesis fires only when the run is in plan mode and the
  final turn meets every precondition. Multi-turn plan-mode runs in
  the middle of investigation (model is reading files, running
  greps) are unaffected: those turns terminate with stop reason
  `tool_use`, not `end_turn` / `stop`, so the synthesis branch never
  even evaluates.
- The hook + config + RunOptions surface is generous (per the
  engine-API-surface-should-be-generous rule). External consumers
  that have not yet built against the new hook lose nothing —
  they inherit the safe default and observe one extra typed event.

## References

- Issue: dsswift/ion#187
- Originating conversation: `1780434358497-2a573297a200` (Bash-echo
  case observed at entries `c9c11cc3`, `d31b9d47`, `cc03b7ee`).
- Implementation:
  - `engine/internal/backend/runloop_plan_mode_auto_exit.go` —
    synthesis logic and config precedence resolver.
  - `engine/internal/backend/runloop.go` — synthesis branch in the
    `end_turn` / `stop` case.
  - `engine/internal/types/normalized_event.go` —
    `PlanModeAutoExitEvent` variant.
  - `engine/internal/types/config.go` —
    `LimitsConfig.PlanModeAutoExitOnEndTurn`.
  - `engine/internal/types/run_options.go` —
    `RunOptions.PlanModeAutoExit`.
  - `engine/internal/extension/sdk_hook_types.go`,
    `sdk_hooks_lifecycle.go`, `hook_forwarders.go`,
    `hook_dispatch.go`, `group.go` — extension hook surface.
  - `engine/internal/session/plan_mode.go`,
    `prompt_runconfig.go` — session-layer wiring.
  - `engine/internal/backend/runloop_plan_mode_auto_exit_test.go` —
    14 regression cases plus 6 precedence subtests.
- Related ADRs:
  - ADR-002 (Engine vs Harness for Early-Stop Continuation) — same
    three-layer config precedence pattern.
  - ADR-003 (State Events vs Workflow Events) — explains why
    `engine_plan_mode_auto_exit` is a sibling to `engine_plan_proposal`
    rather than mutating `engine_plan_mode_changed`.
  - ADR-006 (Deterministic Seams and Probabilistic Judgment) —
    informs the on-by-default decision: a state-machine invariant
    belongs in deterministic engine code, not in persona prose.
