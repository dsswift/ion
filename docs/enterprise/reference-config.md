---
title: Reference enterprise config
description: A working enterprise-config.json to copy, with what each block enforces and what it deliberately leaves to the user.
sidebar_position: 3
---

# Reference enterprise config

The file below is a complete, working enterprise configuration. It ships in
this repository at
[`docs/enterprise/reference/enterprise-config.json`](reference/enterprise-config.json)
and is exercised by a unit test that loads it through the real loader and
asserts it overrides a hostile user config
(`engine/internal/config/reference_enterprise_test.go`). Copy it, change the
tenant and gateway values, deploy it.

It answers one question: **every user on a machine should get the same engine
behaviour, while keeping their own credentials, sessions and preferences.**

## The split

A managed machine has exactly one engine configuration and one Ion install,
but one engine process, one credential store and one set of conversations
*per signed-in user*.

| Machine-wide, identical for every user | Per-user, never shared |
|---|---|
| Providers: gateway URL, auth header, display name | The API key each user authenticates with |
| Identity: tenant, client ID, scopes, PKCE | The user's own tokens and session |
| Allowed models and providers | Conversations and history |
| Telemetry endpoints and privacy level | Studio preferences: theme, layout, fonts |
| Permissions, sandbox, tool restrictions | The engine process itself, on a per-user port |

Nothing needs to be removed from a user's `~/.ion/engine.json` to achieve
this. Enterprise config is applied **after** every other layer, on **every
engine start**, so a user edit is overwritten in memory each launch. The file
on disk may still say anything; it stops being what the engine runs on.

## Where it goes

| Platform | Path |
|---|---|
| Windows | `%ProgramData%\Ion\enterprise-config.json` |
| Windows drop-ins | `%ProgramData%\Ion\enterprise-config.d\*.json`, merged alphabetically |
| Windows registry | `HKLM\SOFTWARE\Policies\IonEngine`, overlaid last and winning |
| macOS | `/Library/Managed Preferences/com.ion.engine.plist` |
| Linux | `/etc/ion/config.json` + `/etc/ion/config.d/*.json` |
| Any platform | `ION_ENTERPRISE_CONFIG=/path/to.json`, wins outright |

On Windows only the machine hive is read. The engine never reads
`HKEY_CURRENT_USER`, so a user cannot author policy that applies to
themselves.

## The file

```json
{
  "allowedProviders": ["gateway"],
  "providers": {
    "gateway": {
      "displayName": "Corporate Gateway",
      "baseURL": "https://ai.example.com",
      "authHeader": "x-api-key"
    }
  },
  "customFields": {
    "ion-desktop": {
      "disableAutoUpdate": true
    }
  },
  "auth": {
    "identityProvider": "entra",
    "requireOperatorIdentity": true,
    "oauth": {
      "entra": {
        "issuerUrl": "https://login.microsoftonline.com/<tenant-id>/v2.0",
        "authorizationUrl": "https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize",
        "tokenUrl": "https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token",
        "deviceAuthorizationUrl": "https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/devicecode",
        "clientId": "<application-client-id>",
        "redirectUri": "http://localhost/callback",
        "usePkce": true,
        "scopes": [
          "openid",
          "profile",
          "offline_access",
          "api://<application-client-id>/Telemetry.Write"
        ]
      }
    }
  }
}
```

## What each block enforces

### `providers`

Each entry **replaces** the user-layer definition for the same key outright.
`baseURL`, `authHeader` and `backend` always come from here, so a
hand-edited `~/.ion/engine.json` cannot point an allowed provider at a
different gateway.

One deliberate exception: an **omitted or empty `apiKey`** preserves whatever
key the user has. That is what makes the split above work — the same provider
definition for everyone, each user's own credential. Setting a non-empty
`apiKey` here pins that instead, for a shared service account.

A provider named here is implicitly allowed and need not repeat in
`allowedProviders`.

### `allowedProviders`

Every provider key not on this list is **stripped** from the merged config. A
user who adds a personal OpenAI provider to their own file gets it removed at
load, not merely ignored.

### `allowedModels` — deliberately absent

`allowedModels` exists and works: every model outside the list is filtered out
of the picker, and a `defaultModel` outside it falls back to the first entry.
This reference does **not** set it, on purpose.

Where models are reached through a gateway, the gateway already returns only
what a given subscription key is entitled to. An allowlist is then a second
copy of that decision, maintained by hand, that goes stale the moment a
subscription changes — and its failure mode is silent: the user simply sees
fewer models with nothing saying why. A one-entry list on a tenant whose
gateway offered sixteen showed exactly one.

Set it when the authority genuinely lives in policy rather than in the
provider — a direct-to-vendor key that can reach models the organisation has
not sanctioned. Otherwise let the provider answer the question it is already
answering.

### `customFields["ion-desktop"]`

The engine carries this namespace verbatim without interpreting it; the
desktop owns the schema. `disableAutoUpdate` stops the application updating
itself, which a managed install needs: MDM pins the version, and an app-level
updater fighting that pin is how a fleet drifts. Without it the desktop checks
for updates on launch and reports the failure to the operator.

### `auth`

The enterprise block replaces user auth wholesale, so tenant, client ID,
endpoints and scopes are uniform. `requireOperatorIdentity` composes one-way:
a lower layer may also require identity, but cannot switch off an enterprise
requirement.

**Set `issuerUrl` even when every endpoint is explicit.** It is `omitempty` in
the schema and the engine still mints access tokens without it, so a config
that omits it looks valid — until identity *verification* runs. Verifying the
`id_token` signature needs the provider's JWKS, reached by OIDC discovery from
`issuerUrl`; without it `newOIDCVerifier` returns `identity: issuerUrl is
required for verified operator identity`, and the failure surfaces in renewal
retries rather than at boot. The engine warns at startup when an operator
provider has no `issuerUrl` — that warning is the only early signal, so do not
let it scroll past.

Scopes are requested at sign-in, so adding one later forces every user to
re-consent.

## What this file deliberately does not set

`backend`, `logLevel` and `limits` are **not** enterprise fields. Writing them
here has no effect — the loader ignores unknown keys silently, which makes a
mistyped policy look deployed while doing nothing. Check the
`EnterpriseConfig` struct in `engine/internal/types/config.go` before adding a
key, and prefer the fields listed in
[the enterprise overview](index.md#what-enterprise-config-controls).

Two adjacent controls are available and left out here only because they are
site-specific rather than universal: `telemetry` pins collection endpoints and
privacy level (see [Telemetry](telemetry.md)), and `logging.egressTargets`
forces operational log egress (see
[Central log collection](central-log-collection.md)). Both follow the same
sealed-ceiling pattern as `auth`.

## Verifying it took effect

Enterprise config is read once, at engine start. After deploying the file,
restart the engine — installing a new build does this automatically, and
otherwise the desktop's Quit All stops the daemon so the next launch reloads.

```bash
# The engine logs each source it read and each value it pinned.
jq -c 'select(.component=="engine" and (.tag|startswith("config")))' ~/.ion/engine.jsonl | tail -20
```

Expected lines: `config.enterprise` naming the file it loaded, then
`config.merge` entries reading `enterprise: pinning provider definition` and
`enterprise: identity configuration applied`. A provider stripped by
`allowedProviders` and a `defaultModel` substitution are logged the same way.

If none of those appear, the file was not found or did not parse — the loader
treats an unreadable policy as absent rather than failing the engine, so the
log is the only signal.
