---
title: "ADR-035: One wire"
description: The phone becomes a thin client of the Studio wire; the `desktop_*` device transport and the PIN are deleted.
---

# ADR-035: One wire

## Status

Accepted. Supersedes the client-wire half of [ADR-008](008-wire-event-naming-and-ownership.md), which described a `desktop_`-prefixed wire owned by the desktop and spoken only to iOS. That wire no longer exists. ADR-008's core rule — **events are prefixed by the owner of the contract** — is unchanged and still governs the engine wire.

## Context

The server spoke two protocols. Studio, a browser, and a second desktop spoke the [Studio wire](../../protocol/studio-wire.md). The phone spoke an older device transport that carried its own login, encryption envelope, sequence numbers, replay buffer, fragmentation, compression, relay wiring, pairing store, and a second implementation of most features.

Two protocols meant every feature was built twice, and the phone's copy was always the one that lagged. It also meant two security postures: the Studio wire over LAN TCP was plain `ws://` while the phone wire encrypted even on LAN, so moving the phone onto the Studio wire as it stood would have been a downgrade.

A measured comparison of the phone's command surface against the Studio action table found most commands already had an equivalent, a third partially did, and a handful had none at all. The gap was real but bounded.

## Decision

**A phone is an ordinary client of the Studio wire, in a thin view.** A `studio_hello` carries `view: 'mirror' | 'thin'`, defaulting to `mirror`, so every existing client is unchanged. A thin connection receives a server-derived view: the server builds transcript rows out of engine tool events, batches text deltas, and projects tab, worktree, settings and theme state, then sends the result on `studio:thin-event`. Studio keeps the raw mirror.

This is the point of the thin view, and it is what makes one wire cheaper than two: the derivation exists once, on the server, rather than once on the server and once again in Swift.

**Everything the old wire could do was added to the Studio wire first.** New actions for the capabilities that had no equivalent, new arguments and return fields for the ones that were partial, and a paging layer for bodies, plans and transcripts — the old wire fragmented a large payload and the Studio wire does not, so an unpaged whole transcript would have hit the per-connection send cap. A map at `packages/shared/src/studio-wire/phone-command-map.json` names the Studio action for every command the phone used to send. A test on the server and a test in Swift both read that file from disk, so a command with no target fails the build rather than drifting.

**LAN frames are sealed.** A paired client dialing over TCP is wrapped in the same AES-256-GCM envelope the relay path already used, and the hello's proof is verified inside it. The desktop adopts it too, so LAN traffic between desktops is encrypted where it previously was not. `allowUnsealedPaired` (default `false`) is the configurable opinion.

**One pairing exchange.** `POST /auth/pair` with an eight-character code, a link, or a QR of that link. The 6-digit PIN and its codeless recovery re-pair are deleted; recovery admitted a device by name with no code at all. Existing paired phones migrate automatically, because a phone's device id and a credential's client id were always the same derivation — nobody re-pairs.

**Then the old wire was deleted**, on both sides, in the same change: the transport stack, the command dispatcher, the PIN pairing flow, the LAN listener and its Bonjour advertisement, and on the phone the transport manager, the LAN and relay clients, and the chunking, resend, epoch and compression layers.

## Consequences

A feature added to the Studio wire reaches the phone as one Swift mapper case and a view. There is no second protocol to extend, no second pairing system, no second credential store, and no second relay mechanism. The Environment verbs and every future action become reachable from iOS with no new server surface.

The phone can no longer connect to a server that predates this change, and a server can no longer serve a phone that does. Both ship from this repository, so the two install together.

Two capabilities were removed rather than ported, deliberately:

- **Codeless recovery re-pair**, because it authenticated a device by name.
- **Enterprise direct (bearer) connect on iOS**, because its transport was the deleted one. The Studio wire has a `bearer` hello; the phone needs a bearer dial plan to use it, and that is unbuilt.

`settings.pairedDevices` survives the deletion. It is the migration's source, read at every boot and deliberately left in place so an install that has not yet booted the new server is not stranded, and the presence and relay paths still resolve a principal from it.

**The `desktop_` prefix outlived the wire it was named for.** It now marks a server-derived payload on `studio:thin-event`. Renaming a payload type that three clients decode would buy nothing, so it stays; see the wire-naming section of the root `AGENTS.md`.

## References

- [Studio wire protocol](../../protocol/studio-wire.md)
- [ADR-033: Ion Studio Server and Environments](033-ion-studio-server-and-environments.md)
- [ADR-008: Wire event naming and ownership](008-wire-event-naming-and-ownership.md)
- [ADR-027: Contextual per-pairing authentication](027-contextual-per-pairing-authentication.md)
