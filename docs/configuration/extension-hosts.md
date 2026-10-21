---
title: extensionHosts Reference
description: The engine.json block that runs engine-scoped extension hosts and the headless sessions their schedules and webhooks fire into.
sidebar_position: 3
---

# `extensionHosts` Reference

`extensionHosts` names the extensions the engine runs as [engine-scoped hosts](../vocabulary/index.md#engine-extension-host): one process per extension, owned by the engine rather than by a conversation, alive from boot to shutdown. Their schedules and webhooks fire into [headless sessions](../vocabulary/index.md#headless-session) the engine mints per fire. No block means no engine hosts; conversations work exactly as before.

```jsonc
{
  "extensionHosts": {
    "extensions": ["~/.ion/extensions/chief-of-staff"],
    "runAs": {
      "mode": "principal",
      "principal": { "subject": "local:josh", "provider": "os", "kind": "local" }
    },
    "session": {
      "workingDirectory": "/Users/josh/work",
      "model": "",
      "extensions": [],
      "profileId": "",
      "idleReleaseMs": 60000
    }
  }
}
```

## Fields

### `extensions` (required, string array)

Extension paths, resolved like a session's extension list (a directory with an entry point, or the entry file). Each extension's [`extension.json`](../extensions/extension-json.md#scope-optional-session--engine--both) must declare `"scope": "engine"` or `"both"`; a session-scoped extension has no engine half and is refused at boot with an error in the log.

### `runAs` (optional, object)

Who every headless session acts as. Storage partition, per-principal tool policy, telemetry attribution, and git author all key on it.

| `mode` | Meaning |
|---|---|
| `principal` | The literal `principal` object: `subject` and `provider` are required, `kind` defaults to `operator`; `displayName`, `email`, and `username` are optional. A single-tenant deployment names its one operator here. |
| `workload` | The engine's own verified machine identity. `auth.identityProvider` must name an `auth.oauth` entry with `machineIdentity`; the engine proves it at boot and refuses to start engine hosts when it cannot. The principal's `kind` is `workload`; its `subject` is the identity's own subject when the provider reports one (AWS returns the caller ARN), otherwise `workload:<provider>:<clientId>`. |

Unset leaves headless sessions unattributed: no partition, no per-principal policy, and any downstream call that needs an identity fails and is logged.

The engine host receives `identity_changed` with `Reason: "run_as"` and the run-as principal at boot, so an extension that keeps an operator principal from that hook needs no new code.

### `session` (required, object)

The template every headless session is minted from.

| Field | Meaning |
|---|---|
| `workingDirectory` | Required. The session's working directory. |
| `model` | Model override for headless runs. Empty uses the engine default. |
| `extensions` | The session-scoped extensions loaded into each headless session. Empty means the same list as `extensions` above. A `both` extension loads its session half here; an engine-only extension is skipped. |
| `profileId` | The engine profile the session reports as its own. |
| `idleReleaseMs` | How long a headless session may stay quiescent after its fire before the engine releases it. Default 60000. A detached dispatch, a running agent, a background process, or an active run holds the session open regardless. |

## What a fire looks like

1. The scheduler or webhook server resolves the engine host's fire to a context. For an engine host that means a new session keyed `headless:<extension>:<nanos>`, started from the template with a fresh conversation, the session-scoped extensions loaded, and the run-as principal stamped.
2. The handler runs with that session's context. `list_sessions` reports the session with `headless: true`.
3. When the session is quiescent for `idleReleaseMs`, the engine releases it without asking `session_before_release` (no harness owns it). The conversation stays on disk under the principal's partition.

Every step logs under `session.engine_hosts` and `session.headless` in `engine.jsonl`.

## Validation

An unusable block is dropped at load with an `ERROR` log and the engine serves conversations without engine hosts: an empty `extensions` list, an empty path, a missing `session.workingDirectory`, a negative `idleReleaseMs`, or an invalid `runAs` (unknown `mode`, a `principal` mode with no subject or provider, a `workload` mode that also carries a `principal`).
