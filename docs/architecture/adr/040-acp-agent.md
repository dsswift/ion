---
title: "ADR-040: The Engine as an ACP Agent"
description: ion acp serves the daemon to any Agent Client Protocol client as a client of the engine socket, so an editor gets the engine's harnesses without the engine learning a UI.
---

# ADR-040: The Engine as an ACP Agent

## Status

Accepted.

## Context

Ion Studio was the engine's reference client, and the only one that could load a harness into a conversation. With Studio retired to maintenance, an editor that already speaks the Agent Client Protocol is the way a person reaches the engine day to day. ACP is a stdio JSON-RPC protocol an editor uses to drive a coding agent: it opens sessions in a working directory, sends prompts, streams updates, asks the user for approvals and form input, and exposes an agent's modes and configuration.

The engine already speaks ACP as a client (`internal/acp`, for the Cursor and Grok backends). It did not speak it as an agent, and nothing in the engine should: the engine is headless and knows no client.

## Decision

**`ion acp` is a client of the engine, not an engine mode.** The command runs an ACP agent over the process's stdio and holds one connection to the daemon's socket. Every ACP session is an engine session keyed `acp-<id>`, started with the client's working directory and the chosen profile's extensions, so it lives beside every other session and beside the engine-scoped extension hosts. The engine gains no ACP code, no new command, and no new event; the agent is `engine/internal/acpagent`, a peer of `ion prompt`.

**The profile is the harness.** A session loads the extensions of one engine profile from `settings.json`. The profile is chosen on the command line and exposed as an ACP config option, so a client offers one provider instance per harness and a person switches a session's harness from the client. Switching restarts the engine session on the same key; the conversation continues.

**The client decides approvals.** An engine `ask` decision is forwarded as `session/request_permission` and the chosen option is sent back. The engine has no per-session permission mode and gains none: a client's own permission mode answers.

**Modes are plan and build.** The engine's plan mode is the only mode the agent advertises, so a client's plan toggle drives `set_plan_mode` and the engine's own transitions report back as the current mode.

**Everything else is translation.** Text and thinking deltas, tool calls with input and result, harness messages, notices, usage, extension slash commands, elicitation forms, and session load with a replayed transcript all map one engine event to one ACP update. What ACP has no shape for (resources, Studio panels) is not surfaced.

**The turn is the client's unit of work, so the agent keeps it whole.** The engine ends a run where it pauses: a question for the person, a plan awaiting approval, a park on background work. None of those is the end of what the person asked for. The agent keeps the prompt open across them: a question becomes a form and its answer the next prompt, a plan proposal becomes an approval and its go-ahead the next prompt, a parked run is waited on until the engine resumes it. The turn ends on the idle snapshot of the last run, so the client always receives the report that follows the pause.

**The client's servers are the session's.** The MCP servers a client names on `session/new` go to the engine as the session's own (`EngineConfig.mcpServers`) and connect beside the configured ones, so a client's tools reach the model under the names the client expects.

## Consequences

- Any ACP editor gets Ion's harnesses: a Chief of Staff conversation in T3 Code loads the same extension, hooks, tools, and schedules as it did in Studio.
- The engine wire is unchanged. A session a client opens through ACP is indistinguishable, to the engine and to its extensions, from one opened over the socket.
- A harness that relied on Studio-only surfaces (resource cards, composer actions) shows nothing for them through ACP until it emits messages instead.
- ACP v1 is the version served. The v2 preview adds richer messages and compaction updates; adopting it is additive.
