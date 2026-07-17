---
title: "ADR-017: Opinionless Tool Instructions"
description: Engine-shipped tool descriptions and reminders carry mechanics only — input shape, channel correctness, interception semantics. Style, depth, tone, and workflow framing are consumer opinions and live in harness prose or operator config.
sidebar_position: 17
---

# ADR-017: Opinionless Tool Instructions

## Status

Accepted

## Date

2026-07-03

## Context

[ADR-004](./004-enter-plan-mode-prose-in-harness.md) moved the
`EnterPlanMode` policy prose out of the engine and into the harness, but it
answered a narrow question — *where does this one tool's description live?* —
and left the general question open: **what is an engine-shipped tool
description allowed to say at all?**

The gap became concrete while fixing the AskUserQuestion lead-up defect
(questions arriving with all analysis locked in private reasoning, nothing
visible to the user). An early draft of the fix extended the engine's
AskUserQuestion description to require "real tradeoffs, grounded in the
specifics of the codebase" and "a recommendation with its reasoning" before
every question. Those requirements are *good defaults for one operator's
workflow* — and they are exactly the kind of drift this ADR exists to stop.
A user running a lightweight TUI, a domain harness collecting form input, or
a headless pipeline asking a yes/no gate question does not want every
question preceded by a tradeoff essay. Baking that in would have made the
engine's default *opinionated*, and the opinion would have been invisible to
consumers until they wondered why their model writes essays before every
question.

The anti-model is well known: Claude Code's harness ships a massive system
prompt and massive tool descriptions. They are high quality and produce a
very effective harness — and they are deeply opinionated, geared toward one
software-development workflow, and not extensible. That is a legitimate
design for a *product harness*. It is a defect for an *engine*. Ion's engine
is consumed by harnesses we have never met; every sentence of opinion in an
engine default is a sentence some consumer has to fight.

This is the root `AGENTS.md` § "Opinionless mechanics, extensible opinions"
principle applied to a specific, recurring surface: the prose the engine
ships inside tool definitions, plan-mode prompts, and turn reminders.

## Decision

**Engine-shipped tool descriptions, prompts, and reminders carry only what
is required for the tool to work, work always, and work correctly.**

What qualifies as *mechanics* (the engine may — and should — state it):

| Category | Example |
|----------|---------|
| Input shape | "keep the question to 1-2 sentences; the UI card is small" |
| Channel correctness | "the user sees only visible assistant text; private reasoning is never shown to them — context must be visible text before the call" |
| Interception semantics | "the run pauses until the user responds"; "the engine intercepts this call" |
| Contract boundaries | "options are 2-5 concise labels"; "the user can always type a custom answer" |

What qualifies as *opinion* (the engine must NOT state it):

| Category | Example |
|----------|---------|
| Styling and depth | "provide tradeoff analysis", "include a recommendation with reasoning" |
| Tone and narrative shape | "write a full lead-up essay", "be concise" (beyond input-shape limits) |
| Workflow framing | "always confirm before proceeding", domain-specific question patterns |
| Formatting conventions | markdown structure, section ordering, phrasing templates |

Opinions live in the consumer's layer, reachable through the existing
override seams:

- **Operator config** — `~/.ion/AGENTS.md` and project `AGENTS.md` files
  (this is where "give me tradeoffs and a recommendation" belongs).
- **Harness prose** — `RunOptions.PlanModePrompt`,
  `RunOptions.PlanModeSparseReminder`, `RunOptions.EnterPlanModeDescription`
  (the ADR-004 pattern).
- **Tool replacement** — `RegisterTool` replace-on-duplicate semantics let an
  extension ship its own description for any tool, including sentinels.

### The test for future edits

Before adding a sentence to an engine-shipped tool description, prompt, or
reminder, ask: **if this sentence were removed, would any consumer's tool
invocation stop working correctly?**

- If yes (the model would put context in the wrong channel, exceed the input
  shape, misunderstand the pause/interception behavior) — it is mechanics;
  keep it.
- If no (the tool still works; output is merely styled differently than one
  operator prefers) — it is opinion; move it to the consumer layer.

### Enforcement

`engine/internal/tools/ask_user_question_test.go` pins both directions for
the AskUserQuestion description: the channel mechanics must be present, and
opinionated styling terms ("tradeoff", "recommendation") must be absent.
New sentinel tools with engine-shipped descriptions should add the same
two-directional pin.

## Consequences

- Engine defaults stay small and neutral; every consumer gets a working tool
  with no imported workflow.
- Operators and harnesses that want rich, opinionated behavior (tradeoff
  lead-ups, domain framing) express it in their own config, where it is
  visible, versioned, and theirs to change.
- Reviewers have a bright-line question for tool-prose diffs, and the
  opinionless guard tests make the drift fail CI instead of shipping.

## Related

- [ADR-004: Move EnterPlanMode Prose to Harness](./004-enter-plan-mode-prose-in-harness.md) — the single-tool precedent this generalizes.
- [ADR-005: Plan-Mode Prose Symmetry](./005-plan-mode-prose-symmetry.md) — the override seams for plan-mode prompts and reminders.
- Root `AGENTS.md` § "Opinionless mechanics, extensible opinions" — the repo-wide principle.
