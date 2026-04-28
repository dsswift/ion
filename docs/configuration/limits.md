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
| `maxTurns` | int | `50` | `--max-turns N` | Maximum number of LLM turns before the agent stops. Each turn is one request-response cycle with the model. |
| `maxBudgetUsd` | float | `10.0` | `--max-budget USD` | Cost ceiling in US dollars. The agent stops when estimated spend reaches this value. Cost is calculated from token counts and the model's pricing. |

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

Limits are evaluated independently. The agent stops when any limit is reached:

- If turn 50 is reached before the budget ceiling, the session stops on the turn limit.
- If the budget ceiling is reached before turn 50, the session stops on the budget limit.

The agent reports which limit caused termination in the session end event.

## Enterprise constraints

Enterprise policy can enforce limit values that lower layers cannot weaken. If the enterprise layer sets a budget ceiling, neither the user config nor the project config can raise it above that value.

## Practical guidelines

| Use case | Recommended limits |
|----------|-------------------|
| Quick questions | `maxTurns: 10`, `maxBudgetUsd: 1.0` |
| Standard coding | `maxTurns: 50`, `maxBudgetUsd: 10.0` (defaults) |
| Large refactors | `maxTurns: 200`, `maxBudgetUsd: 50.0` |
| Background agents | `maxTurns: 500`, `maxBudgetUsd: 100.0` |
