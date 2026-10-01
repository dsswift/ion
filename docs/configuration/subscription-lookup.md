---
title: Subscription Lookup
description: Resolve a provider's subscription key from an endpoint with the signed-in identity, and the published request and response contract for that endpoint.
sidebar_position: 9
---

# Subscription Lookup

A subscription lookup lets the engine fetch a provider's key for the person who signed in, instead of someone typing the key into each machine. The engine calls an endpoint you run, with the signed-in identity's token. The endpoint answers with the subscriptions that person may use. The engine applies the key.

It needs an identity provider (`auth.identityProvider`). Without a `subscriptionLookup` block, nothing changes: manual key entry stays the only path.

## Configuration

`subscriptionLookup` is a top-level block in `engine.json`. Enterprise policy can set the same block; when it does, it replaces the user and project blocks whole (see [Sealed Configuration](../enterprise/sealed-config.md)).

```json
{
  "providers": {
    "gateway": { "baseURL": "https://gateway.example.org/v1", "authHeader": "Ocp-Apim-Subscription-Key" }
  },
  "subscriptionLookup": {
    "endpoint": "https://keys.example.org/subscriptions",
    "provider": "gateway",
    "scope": "api://keys/.default"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `endpoint` | string | required | The `http` or `https` URL the engine calls. |
| `provider` | string | required | The provider id the key authenticates, a key under `providers`. |
| `scope` | string | `""` | Scope of the bearer token sent to the endpoint. Empty uses the identity grant's base scope. |
| `audience` | string | `""` | Audience of the bearer token, for identity providers that bind tokens to one. Empty uses the provider default. |
| `timeoutMs` | int | `15000` | Bound on one lookup. |
| `cacheMaxAgeSeconds` | int | `0` | How long a cached key is reused at launch without a lookup. `0` reuses it until a lookup is requested. A positive value makes a launch past that age look the key up again, which is how a rotated key reaches every machine. |
| `requireSelection` | bool | `false` | Makes the operator choose even when the lookup returns exactly one subscription, so they see which key is used before it is applied. A choice already made is reused. |

An invalid block (no provider, a non-http endpoint, a negative number) is logged at `ERROR` and skipped. The engine still starts, and manual keys keep working.

## Behavior

After sign-in, the engine first checks its cache for this identity.

| Situation | What the engine does | State reported |
|-----------|----------------------|----------------|
| A cached key exists and is within `cacheMaxAgeSeconds` | Applies it. No lookup. | `applied`, source `cache` |
| A cached key exists but is older than `cacheMaxAgeSeconds` | Applies it, then looks up in the background. | `applied`, source `cache`, then the lookup result |
| No cached key | Looks up. | `resolving`, then the lookup result |

A lookup result is handled like this:

| Lookup result | What the engine does | State reported |
|---------------|----------------------|----------------|
| One subscription, `requireSelection` off | Applies it and caches it. No prompt. | `applied`, source `lookup` |
| Several, or one with `requireSelection` on; one of them previously chosen | Applies the chosen one with its current key. | `applied`, source `lookup` |
| Several, or one with `requireSelection` on; none chosen before | Applies nothing and offers the list. | `selection_required` |
| None | Removes any applied and cached key. | `none` |
| Failure (network, status, bad body, no token) | Keeps a cached key if one was applied; otherwise applies nothing. | `applied` with `error`, or `failed` |

A looked-up key outranks every manually configured key for that provider (`providers.<id>.apiKey`, environment variables, the keychain, and stored credentials). When no looked-up key is applied, those manual keys serve exactly as before. That is the fallback for a failed lookup.

Signing out removes the applied key. The cache stays on disk for the next sign-in by the same identity. A different identity gets its own cache entry and its own lookup; one person's key never serves another.

The cache lives in the engine's encrypted credential store (`credentials.enc`), in the signed-in identity's own partition. It holds the chosen subscription's id, label, and key, plus the ids and labels of the options offered.

When a key is applied, the engine rediscovers that provider's models with it, so the model list fills even when the key lands after startup.

## Endpoint contract, version 1

Build the endpoint against this contract. The engine never sends anything else, and reads nothing beyond it.

### Request

```http
GET <endpoint>
Authorization: Bearer <access token for the signed-in identity>
Accept: application/json
Ion-Subscription-Lookup-Version: 1
```

The token is minted by the engine's identity provider for `scope` and `audience`. Validate it as you would any access token from your identity provider; the caller is its subject. The request has no body and no query parameters beyond any already in `endpoint`.

`Ion-Subscription-Lookup-Version` names the contract version the engine speaks. A later version of Ion that changes the shape sends a higher number, so one endpoint can serve both.

### Response

HTTP `200` with a JSON array. Each entry is one subscription the caller may use. The published JSON Schema is [`schemas/subscription-lookup-v1.response.schema.json`](schemas/subscription-lookup-v1.response.schema.json).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Stable identifier. The engine remembers the operator's choice by it, so keep it the same when the key rotates. Unique within one response. |
| `label` | string | yes | Display name shown when the operator chooses. |
| `key` | string | yes | The key the engine applies to `provider`. |

Other fields are allowed and ignored, so you can add your own without breaking the engine.

```json
[
  { "id": "sub-standard", "label": "Standard", "key": "0123456789abcdef" },
  { "id": "sub-high-quota", "label": "High quota", "key": "fedcba9876543210" }
]
```

An empty array means the caller has no subscription. That is a success, reported as the `none` state, not a failure.

Any status outside `2xx`, a body that is not an array, an entry missing a required field, or a repeated `id` is a failed lookup. Responses above 1 MiB are refused.

## Choosing and refreshing

Clients drive the lookup through three engine commands, each answered with the complete state:

| Command | Purpose |
|---------|---------|
| `provider_subscription_status` | Read the current state. |
| `provider_subscription_select` | Apply one offered subscription (`subscriptionId`) and remember it. |
| `provider_subscription_refresh` | Look up again now. |

Every change is broadcast as `engine_provider_subscription`, a complete snapshot. The snapshot names subscriptions by id and label; a key never leaves the engine. See [Client Commands](../protocol/client-commands.md#provider_subscription_status) and [Server Events](../protocol/server-events.md#engine_provider_subscription).

In Ion Studio, the state and the choice appear under **Settings > Enterprise sign-in > Provider subscription**. The iPhone app shows the same section in a server's settings.

## When a person has to act

Two states leave no looked-up key applied until someone acts: `selection_required` and `none`. Ion Studio and the iPhone app both show a prompt for them without anyone opening Settings.

| State | What the prompt shows | What it offers |
|-------|-----------------------|----------------|
| `selection_required` | The offered subscriptions, by label. | Choose one (`provider_subscription_select`), look up again, or dismiss. |
| `none` | That the signed-in account has no subscription for the provider, by name. | Look up again (`provider_subscription_refresh`), or dismiss. |

The prompt shows once each time the state is entered. A later snapshot of the same state does not bring it back after it is dismissed. The Settings control stays available either way. The iPhone app shows the prompt for the server it is connected to.

A request to the provider that fails in one of these states says so in the conversation, ahead of the provider's own error. The engine marks such a failure by putting the subscription snapshot on the [`engine_error`](../protocol/server-events.md#engine_error) event, so any consumer can tell it from another failure.

Nothing is shown when `subscriptionLookup` is absent or the state is `applied`.

## Logs

Every step is in `engine.jsonl` under the `subscription` tag: the lookup request, the endpoint's status and body size, each state change, and any cache read or write failure. The resolver logs `subscription key applied` and `resolve key resolved via subscription` under `auth`. No log line carries a key.
