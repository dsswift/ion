---
title: Resource Limits
description: Configuring turn limits and budget ceilings for Ion Engine sessions.
sidebar_position: 6
---

# Resource Limits

Resource limits control how long an agent session can run and how much it can spend. They prevent runaway sessions and keep costs predictable.

## Fields

| Field | Type | Default | CLI flag | Description |
|-------|------|---------|----------|-------------|
| `maxTurns` | int | unset (unlimited) | `--max-turns N` | Maximum number of LLM turns before the agent stops. Each turn is one request-response cycle with the model. Unset or `<= 0` means no cap. |
| `maxBudgetUsd` | float | unset (unlimited) | `--max-budget USD` | Cost ceiling in US dollars. The agent stops when estimated spend reaches this value. Unset or `<= 0` means no cap. |
| `suppressSystemMessages` | bool | unset (`false`) | -- | When `true`, engine-injected steering messages are sent to the LLM but not persisted to session history. |
| `disablePlanModeReminder` | bool | unset (`false`) | -- | When `true`, the plan mode sparse reminder is not injected on turn 2+. Power users who want to customize the reminder text rather than suppress it entirely should see `RunOptions.PlanModeSparseReminder` in [client-commands.md](../protocol/client-commands.md#send_prompt) or the harness-level `desktop.planModeSparseReminder` key in [settings-json.md](./settings-json.md). |
| `planModeAutoExitOnEndTurn` | *bool | unset (defaults to `true`) | -- | Controls the deterministic plan-mode exit safety net introduced in [ADR-007](../architecture/adr/007-plan-mode-auto-exit.md). When `true` (the engine default), a plan-mode run that ends with stop reason `end_turn` / `stop` without the assistant invoking `ExitPlanMode` or `AskUserQuestion` triggers an engine-synthesized `ExitPlanMode` so consumers always see the plan-approval card. Set to `false` to disable the synthesis — useful for strict automation policies that prefer the conversation to park rather than auto-surface when the model misroutes plan exit. Per-run overrides flow through `RunOptions.PlanModeAutoExit`; the `before_plan_mode_auto_exit` extension hook overrides both. |
| `disableTurnLimitWarning` | bool | unset (`false`) | -- | When `true`, the turn-limit wind-down message is not injected. |
| `disableMaxTokenContinue` | bool | unset (`false`) | -- | When `true`, the max-tokens continue prompt is not injected. |
| `planModeAllowedBashCommands` | string[] | unset (Bash blocked in plan mode) | -- | Bash command prefixes the model may run while in plan mode. The engine ships no built-in list, so an unset field means Bash is unavailable in plan mode. Unlike every other field here this one merges **additively** across the user and project layers and is capped by enterprise policy — see [Plan-mode Bash allowlist](#plan-mode-bash-allowlist) below. |

The engine ships unopinionated. There is no built-in default cap on turns or budget. Harness engineers and operators set them via `engine.json`, CLI flags, or per-call options. For operational timeouts (tool execution, MCP calls, extension RPC, etc.), see the [`timeouts`](engine-json.md#timeouts) section.

## Configuration

Set limits in `engine.json` at the user or project level:

```json
{
  "limits": {
    "maxTurns": 100,
    "maxBudgetUsd": 25.0
  }
}
```

## CLI overrides

The `--max-turns` and `--max-budget` flags override config file values for a single session:

```bash
ion --max-turns 200 --max-budget 50.0
```

CLI flags take highest precedence after enterprise policy.

## Merge behavior

Limit fields use nullable (pointer) types internally. This means:

- **Omitting a field** leaves it unset at that layer. The value from a lower-priority layer is preserved.
- **Setting a field to a value** (including zero) overrides the lower layer.

For example, if the user config sets `maxTurns: 100` and the project config omits `maxTurns`, the merged result is 100. If the project config sets `maxTurns: 30`, the merged result is 30.

`planModeAllowedBashCommands` is the one exception: it is a list, not a scalar, and the user and project layers **union** rather than replace. See [Plan-mode Bash allowlist](#plan-mode-bash-allowlist).

## Plan-mode Bash allowlist

Plan mode is read-only apart from this one field, which names the Bash command prefixes a planning session may execute. Matching is token-based: `"gh"` permits `gh pr view 123` but not `ghost`; `"git log"` permits `git log --oneline` but not `git status`.

Three properties make it behave differently from the scalar limits above.

**It merges additively across user and project.** A repository can declare the commands its workflow needs without knowing what each developer already allows globally.

```jsonc
// ~/.ion/engine.json
{ "limits": { "planModeAllowedBashCommands": ["git log", "ls"] } }
```

```jsonc
// <repo>/.ion/engine.json — committed, travels with every clone
{ "limits": { "planModeAllowedBashCommands": ["graphify"] } }
```

Resolved: `["git log", "ls", "graphify"]`. Duplicates collapse, and user entries come first.

This is a portability mechanism, not a security control — it exists so a checked-in project file does not have to restate (or silently strip) each developer's personal entries.

**An explicit empty list means "block Bash entirely."** The field is tri-valued, and the distinction is load-bearing:

| Value | Meaning |
|---|---|
| omitted / `null` | This layer expresses no opinion; the lower layer stands. |
| `[]` | Permit nothing. Bash is unavailable in plan mode, beating any lower-layer list. |
| `["graphify", ...]` | Additive. Unioned with the lower layer. |

**Enterprise policy caps it.** When enterprise config sets a ceiling, the merged list is intersected against it and nothing below can widen past it. That intersection covers the two run-time sources as well — the `set_plan_mode` session override and per-prompt `bashAllowlistAdditionsForThisPrompt` additions — so a client cannot push a command policy forbids. Absent an enterprise ceiling the merged union stands as-is, which is the normal case on an unmanaged machine.

Full semantics, including the prefix-matching direction rule and how to write an effective ceiling, are in [Sealed Configuration → Plan-mode Bash allowlist](../enterprise/sealed-config.md#plan-mode-bash-allowlist).

## How limits interact

Limits are evaluated independently. The agent stops when any limit is reached. Limits set to `<= 0` (or omitted) are skipped:

- If `maxTurns` is set and reached before the budget ceiling, the session stops on the turn limit.
- If `maxBudgetUsd` is set and reached before the turn limit, the session stops on the budget limit.
- If neither is set, the session runs until the LLM emits a terminal stop or the caller cancels.

The agent reports which limit caused termination in the session end event.

## System Message Control

During the agent loop, the engine injects internal user-role messages for LLM steering. These are not user input — they are engine-generated guidance to keep the LLM on track.

### Types of system messages

| Type | When injected | Purpose |
|------|--------------|---------|
| Plan mode reminder | Turn 2+ during plan mode | Prevents LLM from drifting out of plan-mode constraints |
| Turn limit warning | 2 turns before `maxTurns` | Tells the LLM to wrap up |
| Max token continue | LLM response hits `max_tokens` | Prompts the LLM to continue its truncated response |

### Four levels of control

| Control | Config / Hook | LLM sees it? | Persisted? | Client sees it? |
|---------|--------------|-------------|-----------|----------------|
| Disable flag | `limits.disable*` | No | No | No |
| Hook suppress | `system_inject` → `suppress: true` | No | No | No |
| Suppress from history | `limits.suppressSystemMessages` | Yes | No | No |
| Default (tag + client filter) | none needed | Yes | Yes (tagged `internal`) | Client decides |

### Disable individually

Use the per-injection flags to prevent specific injections entirely. The LLM does not see them, nothing is persisted, and the `system_inject` hook does not fire:

```json
{
  "limits": {
    "disablePlanModeReminder": true,
    "disableTurnLimitWarning": true,
    "disableMaxTokenContinue": true
  }
}
```

### Suppress from history

Use `suppressSystemMessages` to let the LLM see the steering messages but not persist them to session history. Useful when you want the steering behavior but don't want the messages cluttering history:

```json
{
  "limits": {
    "suppressSystemMessages": true
  }
}
```

### Customize via hook

Use the [`system_inject`](../hooks/reference.md#system-message-injection-1) hook to replace or conditionally suppress the message text. See [hook patterns](../hooks/patterns.md#system-message-customization) for examples.

### Client filtering

When messages are persisted (the default), they are tagged with `internal: true` in `load_session_history` responses. Clients can filter them for display. The Ion Desktop and iOS apps hide internal messages by default.

## Enterprise constraints

Enterprise policy can enforce limit values that lower layers cannot weaken. If the enterprise layer sets a budget ceiling, neither the user config nor the project config can raise it above that value.

For `planModeAllowedBashCommands` the constraint is an intersection rather than a numeric cap, and it also binds the two client-supplied run-time sources. See [Sealed Configuration → Plan-mode Bash allowlist](../enterprise/sealed-config.md#plan-mode-bash-allowlist).

## Practical guidelines

| Use case | Recommended limits |
|----------|-------------------|
| Quick questions | `maxTurns: 10`, `maxBudgetUsd: 1.0` |
| Standard coding | `maxTurns: 50`, `maxBudgetUsd: 10.0` |
| Large refactors | `maxTurns: 200`, `maxBudgetUsd: 50.0` |
| Background agents | `maxTurns: 500`, `maxBudgetUsd: 100.0` |
| Unbounded (engine default) | omit both fields |

## Timeouts

Resource limits (turns, budget) control *how much* work a session does. Timeouts control *how long* individual operations take. The two are independent.

Tool execution timeouts, MCP call timeouts, extension RPC timeouts, and other operational timeouts are configured via the `timeouts` block in `engine.json`. See [engine.json Reference — timeouts](engine-json.md#timeouts) for the full field reference.

For CLI prompts, the `--timeout` flag sets a wall-clock deadline for the entire prompt execution. See [CLI Reference](../cli/reference.md#ion-prompt) for details.
