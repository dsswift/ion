---
title: Resource Limits
description: Configuring turn limits and budget ceilings for Ion Engine sessions.
sidebar_position: 5
---

# Resource Limits

Resource limits control how long an agent session can run and how much it can spend. They prevent runaway sessions and keep costs predictable.

## Fields

| Field | Type | Default | CLI flag | Description |
|-------|------|---------|----------|-------------|
| `maxTurns` | int | unset (unlimited) | `--max-turns N` | Maximum number of LLM turns before the agent stops. Each turn is one request-response cycle with the model. Unset or `<= 0` means no cap. |
| `maxBudgetUsd` | float | unset (unlimited) | `--max-budget USD` | Cost ceiling in US dollars. The agent stops when estimated spend reaches this value. Unset or `<= 0` means no cap. |
| `suppressSystemMessages` | bool | unset (`false`) | -- | When `true`, engine-injected steering messages are sent to the LLM but not persisted to session history. |
| `disablePlanModeReminder` | bool | unset (`false`) | -- | When `true`, the plan mode sparse reminder is not injected on turn 2+. |
| `disableTurnLimitWarning` | bool | unset (`false`) | -- | When `true`, the turn-limit wind-down message is not injected. |
| `disableMaxTokenContinue` | bool | unset (`false`) | -- | When `true`, the max-tokens continue prompt is not injected. |

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
