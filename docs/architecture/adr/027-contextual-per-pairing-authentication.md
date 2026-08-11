---
title: "ADR-027: Contextual Per-Pairing Authentication"
description: Interactive OIDC is user-initiated with pairing context; desktop stores last-reported phone identity.
---

# ADR-027: Contextual Per-Pairing Authentication

## Status

Accepted.

## Context

One iPhone may pair with desktops behind different OIDC tenants. Apple's `ASWebAuthenticationSession` owns its system prompt text and cannot explain which Ion desktop or tenant requested sign-in. Automatically escalating reconnect attempts into browser UI is therefore blind and disruptive.

The desktop also needs operator-facing visibility into which account a paired phone last reported, without treating that report as current authorization.

## Decision

- Automatic connection uses cache and silent refresh only. If interaction is needed, it locks the pairing and routes to an Ion-owned recovery/context screen.
- The context screen names desktop, issuer/tenant, account context, and the result of cancelling before user chooses Continue to Microsoft.
- Apple retains control over system authorization-sheet text; Ion controls the preflight and Microsoft controls provider content.
- Switch Account is explicit. Credential deletion and lock semantics are visible, and a cancelled flow never leaves a stale “Signed in as” label.
- iOS reports display-only account summary to desktop after authenticated snapshot. No access token or refresh token crosses the wire.
- Desktop labels the persisted summary **Last reported by phone**. It is context, never live authorization truth.
- Phone identity fields are encrypted in desktop paired-device storage through the existing safe-storage funnel.

## Consequences

A cancelled prompt cannot silently reappear from reconnect machinery. Users can immediately retry through contextual recovery. Desktop operators can distinguish desktop relay identity from each phone's independently reported identity.
