---
title: Profile Configuration
description: How to define and use engine profiles in settings.json.
sidebar_position: 3
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
