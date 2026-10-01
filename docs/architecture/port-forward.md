---
title: Port Forward
description: How Studio reaches a port on another Environment's host from this machine's localhost.
---

# Port Forward

A Port Forward makes a TCP port on an Environment's host reachable at `localhost` on the machine Studio runs on. The services keep running on the host, with the host's network, credentials, and tunnels. The browser runs here.

It exists for one case: the conversation, its Terminals, and the application under test are on another machine, and the person testing is not.

## How it travels

The desktop already holds one Studio connection to each Environment. A forward uses that connection and nothing else, so it works over every route Studio connects by: direct, SSH, or a relay. There is no second tunnel to set up and no port to open on the host.

```
browser ──► localhost:5173 (desktop main) ──► Studio connection ──► server ──► 127.0.0.1:5173 (host)
```

- **Desktop main** (`desktop/src/main/connections/port-forward.ts`) listens on loopback. Each connection it accepts becomes one stream: it picks a stream id and sends `port.open`.
- **Server** (`server/src/port-forward/port-streams.ts`) dials the port on its own loopback and answers.
- **Both ends** run the same `PortStream` (`packages/shared/src/port-forward.ts`) over their socket. Bytes ride the binary channel keyed by the stream id.

Frames, credit, and the actions are specified in [Studio wire § Port Forward](../protocol/studio-wire.md#port-forward).

## Port numbers

The local listener takes the remote port's own number when it is free on both loopback families. A page that calls `localhost:<port>` for its other services then finds each of them at the address it expects, provided those ports are forwarded too. When the number is taken here, the listener takes any free port and Studio shows which.

## Rules

- **Loopback only, at both ends.** The desktop listens on `127.0.0.1` and `::1`. The server dials `127.0.0.1`, then `::1`. A forward never exposes a port to the desktop's network and never reaches past the host's own loopback.
- **Scope.** `port.open` and `port.listeners` take `terminal:operate`, the scope a Terminal takes. A forward reaches what a shell on the host already can.
- **Backpressure is end to end.** A stream sends only what the far end has granted. A slow page slows the service's writes instead of filling the Studio connection.
- **A forward outlives a dropped connection.** The listener stays. Streams in flight end, and new local connections are refused until the Environment is connected again.
- **A forward ends** when it is stopped, when its Environment is disconnected in Settings, or when the desktop quits. Forwards are not saved across launches.

## In Studio

- The **Ports** canvas tab lists what is listening on the active conversation's Environment: first the listeners its own Terminals own, then everything else on that host. Each row forwards, stops, or opens in a Studio Browser tab. Open uses the scheme of the port's confirmed Web Application URL, and HTTPS when there is none. A port can also be typed in.
- The Globe action on a [Web Application](terminal-application-discovery.md) forwards the application's port first when the conversation is on another Environment, then opens it at the local address.

A browser Studio client cannot listen on its machine, so it has no Ports tab. iOS has no equivalent.
