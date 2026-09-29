---
title: "ADR-033: Ion Studio Server and Environments"
description: One server plus one engine is an Environment; the desktop becomes a Studio client of many; the Overlay is deleted.
---

# ADR-033: Ion Studio Server and Environments

## Status

Accepted. Supersedes [ADR-021](021-studio-shell-mirror-store.md).

## Context

Before this program, "Ion Studio" named a presentation inside the desktop's own Electron main process: the session store, the wire to the engine, worktree/bench orchestration, and every other piece of desktop-owned state all lived in one process that also owned the window. That coupling meant the only way to run a shared, always-on Ion instance — a home-lab pod two people sign into, a work machine a phone dials into directly, a browser tab with no desktop behind it — was to run a whole Electron app somewhere and treat its window as a service, which nothing about Electron is suited for.

ADR-021 solved a narrower problem: keeping the desktop's Overlay window and its Studio window in parity while both were **presentations of the same owning renderer**. That problem disappears once the owning code stops being a renderer at all.

## Decision

**An Environment is one Ion Studio Server plus one Ion Engine**, sharing one `ION_DATA_DIR`. The server (`server/`, the `@ion/server` workspace) is the extraction of the desktop's former main-process store, auth, and orchestration layers into a headless process that runs identically on a developer's Mac, inside Docker Compose, or as a Kubernetes pod — see [Ion Studio Server](../../deployment/studio-server.md).

**The desktop becomes a Studio client of many Environments at once**, not the owner of one. It holds a catalog of Environment targets (`EnvironmentTarget`: `local`, `paired`, `bearer`; manifest C10) and speaks the [Studio wire protocol](../../protocol/studio-wire.md) (manifest C3) to each. **Server owns the store, Studio renders** (see root `AGENTS.md`) is now literally true across a process boundary, not just an architectural convention inside one process.

**Every Overlay feature lands in Studio, then the Overlay is deleted** (spec 17). The desktop's only window is the Studio shell; `activeUi`, `surface-launch.ts`, and the Overlay renderer tree are gone. Windows, which already clamped to Studio (`lockedBy: 'platform'`), needed no migration.

**The engine gains a per-session principal** (`SessionPrincipal`, manifest C1/C2) so one shared engine can serve several signed-in people without conflating whose conversation is whose. `identity_changed` gains an optional `sessionKey` so hooks and extensions can resolve identity per session (manifest C1/C2, consumed by the cos2 harness's multi-tenant mode).

**Two enterprise policies, two owners, two enforcement points.** *Device policy* (`customFields['ion-desktop']`) governs what a person's own desktop may do and is read only from the LOCAL environment — a remote server can never narrow what the desktop UI itself permits. *Environment policy* (`EnterpriseConfig.allowedModels`, `allowedProviders`, etc.) governs what a shared engine permits and is enforced by that engine itself, then republished to every connected client on `studio_welcome.enterprisePolicy` (manifest C5, C6) so the model picker and every other policy-gated surface narrows per-Environment, not per-desktop. A remote admin changes what their engine allows; they can never change what a visiting desktop's own UI offers.

**Relay trust is announced per channel, not configured once for the whole relay.** An Ion peer (a server) sends `relay_announce` as its first frame after the WebSocket upgrade (manifest C7), naming its own issuer/audience/scope. The relay validates a joining mobile/client peer against that announcement when the issuer is in `RELAY_TRUSTED_ISSUERS`, and falls back to its own org-wide OIDC/PSK exactly as before when no announcement exists. This is what lets one relay broker connections for many Environments across different Entra tenants without every person needing enrollment in the relay operator's own tenant.

**Two-tier Entra**: one public client registration (desktop + iOS, PKCE, no secret) signs a person in once; each server is its own resource registration with its own scope and app roles (`Studio.Admin`, `Studio.User` → scope sets), so "assignment required" on a server's registration is what actually gates who can reach that Environment.

**The browser Studio client's sign-in is server-held, not client-held.** Desktop and iOS keep their own bearer tokens (Two-tier Entra above); a browser tab cannot, since anything in page JS is one XSS away from readable. The server itself runs the PKCE authorization-code exchange (`server/src/auth/browser-oidc.ts`) against the same public client registration and hands the browser only a random session id in an HttpOnly/SameSite=Lax cookie (`ion_session`) — never a token. The session (principal, scopes, and both tokens, encrypted at rest) persists under `ION_DATA_DIR` (`server/src/auth/browser-session-store.ts`), the same durability model as `credentials.json`'s paired-client secrets, so a pod restart does not force every browser tab to sign in again. Token refresh happens server-side using the stored refresh token, transparent to the browser: the Studio wire's `{kind:'session'}` credential (resolved from the cookie captured at the WebSocket upgrade, never from anything the client claims in the frame) is the only door that can silently renew itself without a client-visible `studio_reauth` round trip.

## Consequences

- A conversation's host binds to exactly one Environment, chosen at draft time and locked on first prompt; Transfer is the explicit verb that moves it, never an implicit migration.
- A Studio window is connected to every catalogued Environment at once and holds all of their tabs in one **union store** (`desktop/src/renderer/studio/state/secondary-store.ts`), each tab tagged with its `environmentId`. A forwarded action goes to the server that owns the tab it names, a file or git call goes to the server that owns the active conversation, a terminal keystroke goes to the server that owns the terminal's tab (`connection/tab-environment.ts`). The Inbox shows every Environment's conversations together; a remote row wears a badge naming its host, and the `All | Local | <environment>` view is a filter over the union, never a reconnect. Creating a conversation on another Environment names it explicitly; nothing in the window switches.
- An Environment is reached three ways, all ending in the same paired credential: a pairing link (LAN), the desktop's **SSH door** (`user@host`: the desktop installs the Studio Server Bundle on the host over ssh, tunnels a loopback port to it, and pairs itself through the tunnel), and a **relay** (one end-to-end encrypted channel per paired desktop, keyed by the pairing secret, on which the channel itself is the proof). A paired desktop dials the LAN first and falls back to the relay the pairing advertised, returning to the LAN when it answers again. The host side is one line (`install-studio-server.sh`) and one command afterward (`ion studio`); see [Ion Studio Server](../../deployment/studio-server.md).
- Settings surfaces that read per-server state (Providers, AI Models) act on the Environment their selector names, and a conversation's pickers read its own Environment's model catalog, so a remote host is configured from the desktop rather than from a copied config.
- A LAN Environment with no identity provider is reached through the `paired` door: the server mints a self-contained pairing link (an admin over the wire, or `node dist/pair.js` on a headless host) and the desktop redeems it against `POST /auth/pair`.
- The desktop's Engine Supervisor (launchd/Scheduled-Task management of a LOCAL engine) has no cluster-pod equivalent — a pod's engine is unmanaged by design, supervised by Kubernetes instead.
- iOS pairs with a server (never a bare desktop) and gained `environmentId` in its snapshot; no other iOS redesign was needed because each server still carries the full remote bridge.
- The Studio wire (manifest C3) is a new scrutinized-adjacent surface: `studio_action`/`studio_event`/`studio_command` reuse the exact `FORWARDED_ACTIONS`/broadcast tables the mirror-store architecture already classified, so the classification work ADR-021 required was preserved rather than redone.
- A browser build of Studio (manifest, spec 18) is one more Studio wire client; it has no desktop-only capabilities (no Browser Surface, no native window chrome) and reports their absence rather than degrading silently.

## Logging

The server is its own process, so it is its own logging surface: `component=server`
in `<ION_DATA_DIR>/server.jsonl`, with the browser-client lines it forwards for
(`POST /log`) in the same file as `component=web`. The rule is **one process, one
file, one component** — Electron's main process writes `desktop.jsonl` even for the
`@ion/server` modules it runs in-process (`desktop/src/main/server-logger-adapter.ts`),
because what a reader needs to know is which process emitted the line.

Consequences worth naming, because each was a real gap after the split:

- **Collection.** `server.jsonl` is its own file, so every collector needs it by
  name. The reference Alloy config tails it, and a test fails when a file the log
  schema documents is not in that list.
- **Shipping.** The server ships its own lines when `server.json`'s `logging` block
  asks it to. `server` is also a source in the shipping-responsibility matrix, so a
  workstation's desktop or a headless engine can carry the file instead — the
  desktop's default list includes it, because before the split those lines were
  desktop lines.
- **Containers.** `ION_LOG_OUTPUT=both` streams to stdout as well as the file, which
  is what `docker logs` and every container collector read; the file alone dies with
  the pod.
- **iOS.** The diagnostic-log pull is the server's, so a phone's lines land on the
  host it pairs with. With a remote server that is not the operator's Mac.
- **Correlation.** Only the engine and its extensions mint a `trace_id`. Across
  surfaces, join on `conversation_id` or `session_id`.

## Rejected

- **Engine-per-user**: rejected in favor of one engine with a per-session principal — additive to the wire, no per-user process supervision, no N-times resource cost for N people on one pod.
- **Reusing the relay's org-wide OIDC for every server**: rejected because it would force every Environment's people into one Entra tenant; server-announced trust keeps each Environment's identity boundary independent.
- **A single merged enterprise policy**: rejected because a remote admin narrowing a visiting desktop's own UI is a privilege boundary violation; the two policies stay owned, sourced, and enforced separately.
