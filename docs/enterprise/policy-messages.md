---
title: Policy Messages
description: Replace the text shown for a failure that results from enterprise policy, keyed by a stable identifier.
sidebar_position: 9
---

# Policy Messages

When enterprise policy refuses something, the engine reports the refusal with its own text. That text is accurate and generic: the engine cannot know who grants access in your organization or where a request goes.

`messages` replaces that text, one failure at a time.

```json
{
  "allowedModels": ["claude-sonnet-4-6"],
  "messages": {
    "model_not_allowed": "This model is not approved. Request access at https://servicedesk.example.org.",
    "authentication_failed": "Sign in with your work account. Help desk: extension 5000.",
    "subscription_unavailable": "Your account has no AI subscription yet. Open a ticket to request one."
  }
}
```

## How it works

- Each failure has a stable identifier. The identifier is the key in `messages`.
- An identifier with an entry shows your text. An identifier with no entry, or a blank one, shows the engine default.
- The text is presentation only. It never changes whether the failure happens, its `errorCode`, or what the engine does next.
- The identifier travels with the failure in a `policyFailure` field, so a consumer can react to the condition without matching text.
- Identifiers never change between versions.
- With no `messages` block, every message is the engine default.

The text is plain. The engine does not format it and does not substitute values into it. Where a failure is about one named thing, the event carries that name in a field of its own, so your text does not need it: a blocked extension is named in `extensionName`.

The audit record of a failure is not affected by `messages`. An `enforcement.*` telemetry event records the real subject and reason whatever text was shown.

## Identifiers

| Identifier | Failure | Policy that causes it | Where it is reported |
|------------|---------|-----------------------|----------------------|
| `model_not_allowed` | A prompt names a model the policy excludes | `allowedModels`, `blockedModels` | `engine_error`, the `send_prompt` result |
| `provider_not_authorized` | A run ends because its model names a provider the policy removed. Applies to a provider-qualified model (`<provider>/<model>`) | `allowedProviders` | `engine_error` with `errorCode: "invalid_model"` |
| `extension_blocked` | An extension did not load | `extensionAllowlist` | `engine_error` with `errorCode: "extension_blocked"`. `extensionName` on the event names the blocked extension |
| `tool_blocked` | A tool call was refused | `toolRestrictions` | `engine_tool_end`. The text follows `Blocked: ` and is also what the model reads as the tool result |
| `mcp_server_blocked` | An MCP server could not be added or changed | `mcpAllowlist`, `mcpDenylist` | The `mcp_add` and `mcp_update` results |
| `profile_locked` | A session was refused because the locked profile is not installed on the host | `newConversationDefaults` | The `start_session` result |
| `managed_policy_absent` | A prompt was refused because the installation is managed and has no policy | Managed mode | `engine_error` with `errorCode: "managed_policy_absent"`, the `send_prompt` result |
| `authentication_failed` | A sign-in could not start or did not complete, or a session was refused because the required identity is missing | `auth` | The `oidc_begin_login`, `start_session`, and `send_prompt` results |
| `subscription_unavailable` | The subscription lookup returned no subscription for the signed-in identity | `subscriptionLookup` | `engine_provider_subscription` in state `none` |
| `subscription_lookup_failed` | The subscription lookup failed and no cached key exists | `subscriptionLookup` | `engine_provider_subscription` in state `failed` |

`managed_policy_absent` is reported with its identifier, and its text is always the engine default: the failure means no policy resolved, so there is no `messages` block to read.

A dangerous command pattern carries its own text already: the `reason` on each entry of `sandbox.additionalDangerousPatterns`.

## Where the identifier appears

| Surface | Field |
|---------|-------|
| `engine_error` | `policyFailure`, beside `message` and `errorCode` |
| `engine_tool_end` | `policyFailure`, beside `result` |
| Command result | `policyFailure`, beside `error` |
| `engine_provider_subscription` | `providerSubscription.policyFailure`, with `providerSubscription.message` when text is configured |
| `on_error` hook | `policyFailure` on the payload |

The field is absent on any failure that does not result from policy.

For the two subscription states the engine has no text of its own, so `providerSubscription.message` is present only when you configure one. A consumer words the state itself otherwise.

## Identifiers of your own

`messages` accepts any key. The engine applies the ones in the table above and passes the whole map to consumers in the `get_enterprise_policy` response. A consumer that reports a policy failure of its own reads its text from the same map, so one block covers every surface.

## Layering

A drop-in merges `messages` per identifier. It replaces the entries it names and leaves the rest in place. See [MDM](mdm.md) for the sources and their order.

## Observability

The engine logs each override it applies as `policy failure message overridden`, with the identifier and the default text it replaced. At config load it logs `enterprise policy messages loaded`, listing the identifiers it will override and the keys it passes through.
