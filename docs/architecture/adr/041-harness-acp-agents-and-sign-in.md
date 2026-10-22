---
title: "ADR-041: Harnesses as ACP Agents, and Sign-in over ACP"
description: A harness is its own ACP agent, launched by its own binary, and an ACP client signs the engine in through ACP's authenticate, so a new machine needs no Studio.
---

# ADR-041: Harnesses as ACP Agents, and Sign-in over ACP

## Status

Accepted. Extends [ADR-040](040-acp-agent.md).

## Context

[ADR-040](040-acp-agent.md) made the profile the harness: a client runs `ion acp --profile <name>`, and every agent it lists is the engine, offering a profile picker that can turn a Chief of Staff thread into any other harness or none. A harness that is a product in its own right (a business assistant, a household assistant) should appear in the client as itself, launched by its own path, with no engine profile to configure and no picker that changes what it is.

Operator sign-in was started only by Ion Studio: the engine owns the OIDC grant, but a client must send `oidc_begin_login` and surface the URL. With Studio retired, an engine on a new machine had no way to sign in, and `ion acp` advertised no sign-in to its client.

## Decision

**A harness may be the agent.** `ion acp --harness <path>` pins every session to one extension. The agent reports the extension's manifest name as `agentInfo.name` (and `--title` as its title), offers the model as its only config option, and refuses a profile change. The profile catalog is not consulted. A Go extension serves itself: run as `main acp`, the SDK replaces the process with `ion acp --harness <its directory>` before any extension code runs, so the client's command is the harness binary.

**Sign-in is ACP's authenticate.** With `auth.identityProvider` configured, the agent advertises one agent-type auth method and `logout`. `authenticate` runs the engine's browser login, sends the URL to the client as a url elicitation scoped to the authenticate request (or opens it locally for a client without url elicitation), and answers when the engine broadcasts a signed-in identity. A session the engine refuses for a missing sign-in fails with `-32000`, ACP's authentication-required code; no other failure uses that code, because a client answers it by signing in.

**The terminal has the same flow.** `ion auth login|status|logout` drive the same engine commands for a machine with no ACP client, and `--device` covers a host with no browser.

**Identity stays the engine's.** An ACP session carries no principal of its own; its extensions see the engine's signed-in operator, the same identity every client of the engine sees.

## Consequences

- A client lists Chief of Staff and Jarvis as agents of their own; neither offers a way to become the other.
- A new machine is: install `ion`, write `engine.json`, add the harness in the client, choose Sign in.
- The engine wire is unchanged: harness pinning and sign-in are `ion acp` and CLI behavior over existing commands (`start_session`, `oidc_begin_login`, `oidc_identity`, `oidc_logout`).
- ACP agents built before this used `-32000` for every failure; clients that treat it as authentication required now see it only when signing in would help.
