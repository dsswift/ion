---
title: iOS
description: Build and install the Ion iOS companion app.
sidebar_position: 6
---

# iOS

Ion Remote is a SwiftUI companion app for controlling agent conversations from a phone. It is a client of the [Studio wire](../protocol/studio-wire.md), the same protocol Ion Studio and a browser speak to an [Ion Studio Server](studio-server.md) — see [ADR-035](../architecture/adr/035-one-wire.md).

It asks for the **thin view** at hello. The server derives what the phone renders (transcript rows out of engine tool events, batched text deltas, tab and worktree state, settings, themes, presence) and sends the result on one channel, so the phone renders that work rather than repeating it.

## Requirements

- Xcode 15+
- iOS 17+
- Apple Developer account (for device deployment)

## Build

```bash
cd ios
xcodebuild -project IonRemote.xcodeproj -scheme IonRemote \
  -destination 'generic/platform=iOS' build
```

For device installation, open `ios/IonRemote.xcodeproj` in Xcode, select your device, and run.

### Verify build

```bash
cd ios && xcodebuild -project IonRemote.xcodeproj -scheme IonRemote \
  -destination 'generic/platform=iOS' build 2>&1 | grep -E "error:|BUILD (SUCCEEDED|FAILED)"
```

## How a pairing reaches its server

A pairing is one credential, and it works over either route. The phone picks the route the same way a desktop does: it probes `GET <url>/auth/config` on the stored address, uses the LAN when that answers, and the relay when it does not. While on the relay it re-probes periodically and moves back. The phone does not depend on the server advertising itself to reconnect, so a silent server still works.

### LAN

The phone finds a server on the local network by mDNS and matches it to a stored pairing by the host's machine id, then dials the server's Studio port.

A paired client's LAN socket is **sealed**: the frames are wrapped in the same AES-256-GCM envelope the relay path uses, keyed by the pairing's shared secret, and the hello's proof is verified inside the envelope. A server can accept an unsealed paired hello over TCP only if it is configured to (`listen.tcp.allowUnsealedPaired`, default `false`).

### Relay

When the LAN address does not answer, the phone joins the server's relay channel. The relay forwards opaque frames and cannot read them. A relay that authenticates with OIDC has the phone sign in for the server's issuer, audience and scope, and the token is renewed automatically for the life of the pairing.

## Pairing

One exchange, three ways to start it, all of them the same `POST /auth/pair`:

- **A code.** The host shows an eight-character code; type it into the app.
- **A link or its QR.** `Settings → Servers → the server → Access & pairing → Pair a phone` shows both, on the desktop or on another phone already paired with `admin`. Scanning the QR carries the whole link, so nothing is typed.
- **Over the relay.** For a server you cannot reach on the LAN, Studio can present a relay pairing code carrying `{relayUrls, channelId, issuer, audience, scope, expiresAt}`.

A phone paired before this app moved onto the Studio wire does **not** re-pair. The server copies each old record into its credential store at boot, keyed the same way it always was.

There is no PIN. The 6-digit PIN and its codeless recovery re-pair are gone; recovery admitted a device by name with no code at all.

### Managed App Configuration

An MDM profile can push a list of environments so operators do not type server URLs by hand. Set the `ion.environments` key to an array of `{label, url}` objects:

```json
{
  "ion.environments": [
    { "label": "Acme Prod", "url": "wss://ion.acme.example.com" },
    { "label": "Acme Staging", "url": "wss://ion-staging.acme.example.com" }
  ]
}
```

iOS reads this from `UserDefaults(suiteName: "com.apple.configuration.managed")` and merges it with any manually added environments; a manual entry for a URL the managed list already carries collapses into the managed row. Managed rows cannot be removed from the app — they are removed by updating the MDM profile.

**Enterprise bearer connections are not implemented on iOS.** The Studio wire accepts a `bearer` hello, and the desktop uses it, but the phone has no bearer dial plan yet: every socket it opens is a sealed one keyed by a pairing secret. A managed environment list is therefore useful today only for a server the phone can also pair with.

## Administering a server

The phone administers a server the way the desktop does, with no desktop needed. Open **Settings → Servers → a server**. Its pages are the desktop's, in the same order: Overview, Projects, Git access, Providers & models, Agent rules, Integrations, Workflow, Access & pairing, and Health. Each page shows the server's settings for it and the screens that manage it: restart, update and purge; add, clone, trust and remove projects; git credentials; providers and model tiers; MCP servers, automations and enterprise sign-in; paired devices, pairing links, discovery and the relay; metrics, processes, host tools, telemetry and logs.

Every paired server has its pages, not only the one the phone chats on. For another server, the phone opens a connection of its own while its pages are on screen and closes it shortly after they leave.

### What needs admin

A server's configuration (providers, MCP servers, Entra, pairing, discovery, the relay, restart, update, purge, logs) needs the `admin` scope. Projects and git credentials need `git:write`. Automations need `conversations:operate`. A pairing's scopes come from the link or code it was paired with:

- A **pairing link** (Access & pairing → Devices), an eight-character **discovery code**, and `ion studio pair` grant the server's default scopes, `pairing.defaultScopes`. On an install with shared tenancy (one person's machine, including every desktop's own server) those include `admin`. On an isolated install they do not; an admin grants it per link (`auth.createPairingLink` with `scopes`, or `ion studio pair --scopes`). See [`pairing.defaultScopes`](../configuration/server-json.md).
- **Pair a phone** (the QR on Access & pairing) asks for no scopes of its own, so the phone gets the server's `pairing.defaultScopes`, like any other device the server pairs. On a shared-tenancy install that includes `admin`, and the phone can run the server; on an isolated install it does not.

Without a scope, a setting shows read-only and an action says which scope it needs instead of failing. To get admin on a phone paired without it, pair it again with a pairing link that grants it.

### Signing in from the phone

The phone is not on the server's host, so a sign-in that finishes on a browser callback on the host cannot finish from it. What each sign-in does:

- **Enterprise sign-in (Entra).** A device code: the phone shows a code and the page to enter it at.
- **MCP servers.** The provider's page opens in a sheet in the app and returns to it by itself. If a provider will not return to the app, open the page, sign in, and paste the address the browser lands on.
- **Google.** Open the page, sign in, and paste the address the browser lands on, even if the page shows an error.
- **Provider CLIs.** Only sign-ins that take a pasted code or a device code. A sign-in that opens a browser on the host is refused off the host; sign in on the host, or use an API key.
- **Git hosts.** The git host's OAuth sign-in (when the server has an exchange configured) opens on the phone. Minting an SSH key, pasting a key and storing a token work as on the desktop.

### Relay setup

Any admin can set up the relay, from any device: **Access & pairing → Phone and relay**. Testing a relay, discovering relays on the LAN, and probing a relay's sign-in need `admin`, not the host's own desktop.

## Security

- A pairing's frames are sealed end to end on both routes, LAN and relay alike.
- The shared secret is established by the pairing exchange and is never sent to a relay.
- The relay forwards opaque byte sequences and cannot decrypt them.
- A revoked pairing is closed by the server and forgotten by the phone; a phone can also unpair itself, which needs no administrative scope because it can only ever name its own pairing.
