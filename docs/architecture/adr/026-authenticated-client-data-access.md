---
title: "ADR-026: Authenticated Client Data Access"
description: Desktop data visibility is per-pairing authority, not transport availability.
---

# ADR-026: Authenticated Client Data Access

## Status

Accepted.

## Context

Ion Remote caches desktop tabs, layouts, conversations, and resources. Temporary network loss should not destroy useful context, but an explicit refusal, cancelled sign-in, revoked pairing, or wrong OIDC account means the phone has no current authority to expose that desktop's cached data.

A single connection enum cannot express both facts. Treating every disconnect as a lock destroys offline continuity; treating explicit authentication failure like packet loss may expose stale or revoked data.

## Decision

Access is stored **per paired desktop** in `DesktopAccessRecord`. Transport state remains separate.

- A decrypted `desktop_snapshot` is authority proof. It can only arrive after relay bearer validation plus E2E validation, or LAN challenge-response plus E2E validation.
- Socket loss, network transition, relay outage, desktop restart, and silent credential recovery preserve cached visibility with stale disclosure.
- User-cancelled auth, missing/terminally rejected credentials, sign-out, relay subject mismatch, and definitive LAN pairing rejection lock the pairing.
- A valid authenticated LAN snapshot authorizes the pairing even if its relay OIDC path is failing.
- Locked data is hidden, not deleted. Unpair/revocation/reset remain the destructive cache lifecycle.
- Root routing mounts a recovery shell rather than any desktop-owned tabs, conversations, resources, terminals, or desktop settings while locked.
- Locks persist on `PairedDevice` so relaunch cannot flash cache before rediscovering the same refusal.
- External navigation carries pairing identity and queues behind the same gate.

## Rejected

- Warning-only display after explicit auth failure: warnings do not establish authority.
- Cache deletion on auth failure: destructive and does not improve authority proof.
- Age thresholds: a heuristic cannot replace authenticated snapshot evidence.
- OIDC-only gate: LAN is independently authenticated and sufficient.
