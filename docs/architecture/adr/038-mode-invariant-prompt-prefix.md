---
title: "ADR-038: Mode-Invariant Prompt Prefix"
description: A run's tool list and system prompt do not depend on plan mode. Plan mode is delivered as notices in the conversation and enforced when a tool is called, so switching modes keeps the provider's prompt cache.
---

# ADR-038: Mode-Invariant Prompt Prefix

## Status

Accepted. Supersedes the placement of plan-mode prose described in [ADR-005](005-plan-mode-prose-symmetry.md): the three-layer override of that prose stands, and where it is delivered changes.

## Context

A provider caches a prompt as a prefix: the tool list, then the system prompt, then the messages. A request reuses the cache only as far as its bytes match the previous request. Anything that changes early in that order discards everything after it, and the provider rewrites it at the cache-write rate.

Plan mode changed the two earliest parts.

- **API backend.** The plan-mode prompt was appended to the system prompt. The tool list was filtered to the read-only set in plan mode, gained `EnterPlanMode` in auto mode, and lost it again on an implementation run.
- **claude-code backend.** A plan-mode run was spawned with `--disallowedTools` and with the plan prompt in `--append-system-prompt`, and registered a different set of tools on the engine's MCP server than an auto run did.

Every switch into or out of plan mode therefore rewrote the whole conversation. Measured on the claude-code backend, with switches made inside the cache lifetime: 185,548 tokens read before the switch, then 0 read and 191,135 rewritten. A run that stayed in one mode read 247,473 and rewrote 206.

Three more defects surfaced during the work.

- The built-in tool registry is a map, so the API backend sent its tools in a different order on every run, and a new run could never reuse the previous run's cache.
- The plan-mode reminder, and the `EnterPlanMode` tool result, were sent to the model without being saved as sent. The next run reloaded a history that did not match what had been cached.
- The read-only boundary on claude-code was fixed at spawn, so a model that entered plan mode part-way through a run kept its write tools until the next prompt. The hook that carries permission decisions to the CLI also failed open: the CLI refuses a tool only when its hook exits with status 2, and the hook command was `curl`.

## Decision

**The prefix does not depend on the mode.** For a given conversation, model, and harness configuration, the tool list (names, descriptions, schemas, order) and the system prompt are byte-identical whether the run is planning, in auto mode, or carrying out an approved plan. On claude-code the same holds for the spawn arguments and for the tools the engine registers. Both plan sentinels, `EnterPlanMode` and `ExitPlanMode`, are in the list in every mode. The assembled tool list is sorted by name.

**The read-only boundary is a policy applied when a tool is called.** One policy (`backend.PlanPolicy`) decides whether a call may run while a session is planning. Its rules are the ones the list filter used to express: the allowed read-only set, tools that declare themselves plan-safe, the Bash and MCP allowlists, and the plan file as the one writable path. Three rails apply it:

| Rail | Covers |
|---|---|
| The API run loop, ahead of the permission check | Every tool an API run calls |
| The claude-code `PreToolUse` hook server | The CLI's own native tools |
| The engine's MCP tool server | Extension tools, client tools, and engine tools bridged to a delegated CLI |

The two CLI rails read the session's plan state on every call, so a model that enters plan mode part-way through a run is read-only from its next tool call. The hook command is `ion hook-relay`, which exits 2 whenever it cannot get a decision, and a prompt whose rail cannot be set up is refused.

**Plan-mode instructions are notices in the conversation.** They are appended as machine-authored user turns where the mode changed, with three injection kinds:

| Kind | Sent when |
|---|---|
| `plan_mode_enter` | The model has not been told it is planning against this plan file |
| `plan_mode_exit` | The model was told it is planning and the run is not |
| `plan_mode_reminder` | Planning continues and five assistant turns have passed since the last notice |

Every notice is saved exactly as it was sent. An enter notice stays true in history because a later exit notice ends it; each states a fact as of its own position and none claims to out-rank the rest of the conversation.

**What the model was told is read from the conversation.** A reconciler walks the current context path to the most recent notice and compares it with the run's live mode. A rewind moves the leaf, and a compaction or a clear drops everything before it, so in each case the walk sees what the model will see. There is no session flag to go stale. On claude-code the notice is the leading block of the user turn written to the CLI's stdin and is recorded in Ion's conversation; a run that bridges into a fresh CLI session is always told again.

**The harness keeps its seams.** `RunOptions.PlanModePrompt` and the `plan_mode_prompt` hook still supply the instruction text, the allowed tool list, and the reminder text. The text now arrives as the enter notice and the list drives the policy. `system_inject` fires for each notice kind and can rewrite or withhold it. There is no option to restore the old placement: a harness controls the words and the allowed set, and the engine owns where they go.

**A prefix change is logged.** Each run records a fingerprint of the model, system prompt, and tool list, and warns, naming the part, when one differs from the conversation's previous run.

## Consequences

- Switching plan mode on or off, approving a plan, and a model entering plan mode itself no longer rewrite the conversation cache. Verified against the claude CLI on one resumed session: plan mode delivered as a notice read 43,284 tokens and rewrote 144; delivered by the old flags it read 0 and rewrote 40,542.
- A planning model can see tools it may not call. A refused call returns a reason that names what it can use instead.
- Bash on the plan-mode allowlist now works on claude-code, where it was previously removed outright.
- A harness's `EnterPlanMode` description must not claim that the tool's presence means plan mode is off. The description is shown in every mode.
- `SuppressSystemMessages` keeps notices out of the conversation, so a harness that sets it resends the enter notice after a restart.
- codex and the ACP backends (grok, cursor) use each agent's native plan mode and assemble their own prompts. Their prefix is theirs to keep stable.
- A pause longer than the provider's cache lifetime still rewrites the cache, and so does a model change. Neither is a mode switch.
