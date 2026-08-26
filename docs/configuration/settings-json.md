---
title: Profile Configuration
description: How to define and use engine profiles in settings.json.
sidebar_position: 4
---

# Profile Configuration

Profiles let you define named sets of engine configuration -- extension directories and display names -- and switch between them. Profiles are stored in `~/.ion/settings.json`, separate from `engine.json`.

## File location

`~/.ion/settings.json`

## Structure

```json
{
  "engineProfiles": [
    {
      "id": "default",
      "name": "Default",
      "extensions": ["~/.ion/extensions/default"]
    }
  ]
}
```

The engine reads the `engineProfiles` array (with `harnessProfiles` as a legacy fallback).

## Profile fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier for the profile. Used for programmatic lookups. |
| `name` | string | Yes | Display name. Also used for lookup -- you can reference a profile by either `id` or `name`. |
| `extensions` | string[] | Yes | Paths to extension directories for this profile. Tilde (`~`) is expanded to the user's home directory. |

## How profiles are resolved

When a client starts a session, it can specify a profile by name or ID. The engine calls `FindProfile()`, which searches the `engineProfiles` array and returns the first match on either `name` or `id`.

If no profile is specified, behavior depends on the client. The desktop app typically selects a default profile on the user's behalf.

## Multiple profiles

Define multiple profiles to switch between different extension sets:

```json
{
  "engineProfiles": [
    {
      "id": "coding",
      "name": "Coding",
      "extensions": ["~/.ion/extensions/coding"]
    },
    {
      "id": "research",
      "name": "Research",
      "extensions": [
        "~/.ion/extensions/coding",
        "~/.ion/extensions/research-tools"
      ]
    },
    {
      "id": "minimal",
      "name": "Minimal",
      "extensions": []
    }
  ]
}
```

Model selection is handled by the `model_select` hook or per-prompt overrides, not by the profile.

## Desktop power-user overrides

The `desktop` key in `settings.json` holds desktop-harness-specific overrides. These keys are **not** exposed in the renderer Settings UI — they are power-user escape hatches for advanced scenarios. Edit `~/.ion/settings.json` directly.

**Posture**: settings.json only, no renderer UI. Per [ADR-004](../architecture/adr/004-enter-plan-mode-prose-in-harness.md)'s "Future considerations" section: "doing so would commit Ion to a UX register (multi-line editable text with placeholder validation, 'reset to default' affordance, cross-platform iOS textarea parity) it has not designed for."

### Plan mode framing overrides

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `desktop.planModePrompt` | string | `PLAN_MODE_PROMPT` constant in `prompt-pipeline.ts` | Full system prompt injected at the start of each plan-mode run. Replaces the desktop's reference prose verbatim. Empty or absent uses the desktop default. |
| `desktop.planModeSparseReminder` | string | `PLAN_MODE_SPARSE_REMINDER` constant in `prompt-pipeline.ts` | Per-turn sparse reminder injected every `planModeReminderInterval` turns during plan-mode runs. Replaces the desktop's reference text verbatim. Empty or absent uses the desktop default. |

Both keys follow the same precedence as their wire-contract counterparts (`RunOptions.PlanModePrompt` and `RunOptions.PlanModeSparseReminder`): harness-supplied value > engine default. The desktop reads these keys at session start and passes the non-empty values through on every `send_prompt` dispatch.

**Example**: Suppress the plan-mode prose entirely for a minimal planning workflow:

```json
{
  "engineProfiles": [...],
  "desktop": {
    "planModePrompt": "You are in planning mode. Write a plan to the plan file, then call ExitPlanMode.",
    "planModeSparseReminder": "Plan mode active. End with ExitPlanMode or AskUserQuestion."
  }
}
```

Cross-reference:
- [ADR-004](../architecture/adr/004-enter-plan-mode-prose-in-harness.md) — the policy/mechanism boundary that motivates these knobs
- [Plan mode prose overrides](../sessions/lifecycle.md#plan-mode-prose-overrides) — the three-layer precedence (RunOptions → hook → engine default)
- [client-commands.md#send_prompt](../protocol/client-commands.md#send_prompt) — the wire fields these settings populate

## Desktop browser preview shield

Ion Desktop stores `browserPreviewNetworkShield` in `~/.ion/settings.json`. It defaults to `true`.

When enabled, a local document opened in the Studio Browser Surface cannot load network resources until the user allows them from that preview. This setting sets the default. It does not override an explicit per-preview decision.

```json
{
  "browserPreviewNetworkShield": true
}
```

See [ADR-030](../architecture/adr/030-embedded-browser-surface.md) for browser session modes and partition ownership.

## Desktop browser tools

Ion Desktop stores `studioPlaywrightEnabled` in `~/.ion/settings.json`. It
defaults to `true`. A missing or malformed value reads as `true`, so a damaged
settings file does not remove a feature.

When enabled, and when Ion Studio is the active interface, agents can drive the
Chromium tab in their conversation's Studio Surface panel. Each conversation
exposes exactly one Agent-linked browser tab.

```json
{
  "studioPlaywrightEnabled": true
}
```

Turning this off withdraws the tools only. Browser tabs, sessions, logins,
device emulation, and recorded diagnostics are left as they are, and a later
change re-advertises the tools without restarting any conversation.

Diagnostic limits (retained request count, body size, output caps) are
implementation constants rather than settings. They exist to bound
main-process memory, not to express an operator preference.
