---
title: ACP Agent
description: Serve the engine to any Agent Client Protocol client with `ion acp`, and set it up as a T3 Code provider.
sidebar_position: 5
---

# ACP Agent

`ion acp` serves a running Ion engine to an [Agent Client Protocol](https://agentclientprotocol.com) client over the process's stdin and stdout. An ACP client (T3 Code, Zed, any editor that spawns ACP agents) runs it as an agent; every session it opens is an ordinary session in the engine daemon, beside every other session and the [engine-scoped extension hosts](../configuration/extension-hosts.md). The engine does not know ACP exists: `ion acp` is a client of the engine socket, the same way `ion prompt` is.

```bash
ion acp [--profile <name|id>] [--model <id>]
ion acp --harness <path> [--title <text>] [--model <id>]
```

| Flag | Description |
|------|-------------|
| `--profile` | The [engine profile](../configuration/settings-json.md) every session loads: its extensions run as the session's harness. Omitted, or `none`, loads no extensions. The client can switch it per session. |
| `--harness` | One extension (its directory or entry point) every session loads. The agent is that harness: it reports the extension's manifest name (else its directory name) as `agentInfo.name`, offers no `profile` option, and refuses a profile change. Exclusive with `--profile`. |
| `--title` | With `--harness`, the `agentInfo.title` a client shows. Omitted, the name. |
| `--model` | The model sessions start on. Omitted, the engine's `defaultModel` applies, else the first model the engine lists. |

The daemon is started when it is not already running, as `ion prompt` does. Diagnostics go to `~/.ion/engine.jsonl` under `tag=acp`; stdout carries only the protocol.

## What the client sees

| ACP surface | Engine behavior |
|---|---|
| `session/new` | `start_session` with the client's `cwd` as the working directory, the profile's extensions, a new conversation, and the request's `mcpServers` as the session's own servers (`EngineConfig.mcpServers`): a stdio server's command, args, and env, or an http/sse server's url and headers. They connect at the first prompt beside the engine's configured servers, so a client's tool server (T3 Code's `t3-code`) reaches the model as `mcp__t3-code__<tool>`, the names the client recognizes. |
| `session/load` | The same key resumes its conversation; the transcript is loaded by the conversation the engine bound the key to and replayed as user and agent chunks and completed tool calls, each marked `_meta.isReplay`. Only sessions `ion acp` opened (keys starting `acp-`) load. |
| `session/prompt` | `send_prompt`, or `command` when the text starts with a slash that names a command an extension registered. Text blocks are joined; image blocks become attachments; embedded text resources are appended as attached context. The turn ends on the idle status snapshot of the run the prompt started (a status whose `runEpoch` has not passed the one seen before the prompt describes the session before it and is ignored; the completion idle that carries no epoch is not the settlement signal), or on the command result of a slash command that started no run: `end_turn`, `max_turn_requests`, or `cancelled`. An engine error ends it as a JSON-RPC error. A session the engine released (`engine_session_released`) is reopened on its conversation first, with the plan mode the client set restored. |
| Held turns | An idle that still owes the turn a run keeps it open: the session parked on background commands (`backgroundShells`), waiting on polls, or with agents still working (`backgroundAgents`). The run the engine resumes with streams into the same turn, so the client gets the report the model writes after the work finishes, not a turn that ends on "still building". `session/cancel` on a held turn aborts and ends it at once. |
| Questions | A question the model asks (`AskUserQuestion`, or an `AskUserQuestions` batch) ends its run and rides the idle status as a retained denial. With a client that renders forms, the agent sends `elicitation/create` in form mode (one string field per question, titled by its header, described by its text, the options as `enum`), keeps the turn open, and sends the answer back as the next prompt (`injectionKind: structured_answer`); the turn ends on the run the answer starts. A client without forms, or one that cancels the form, gets the question as agent text and the turn ends, so the person answers in the prompt box. |
| Plans | The plan-mode file reaches the client as `plan_update` (markdown, keyed by the plan slug) as it is written and when the model proposes to exit. The proposal (`engine_plan_proposal`) is a `session/request_permission` of kind `switch_mode` carrying the plan: **Yes, implement the plan** leaves plan mode (`set_plan_mode`), reports `current_mode_update`, and continues the turn with the go-ahead prompt; **No, keep planning** ends the turn still in plan mode, so the next prompt is feedback. A `TodoWrite` call is a `plan` update with its entries. |
| `session/cancel` | `abort`. |
| Modes | `build` (the default) and `plan`, mapped to `set_plan_mode`. A plan-mode change the engine makes itself (the model calling `EnterPlanMode`) reaches the client as `current_mode_update`. |
| Config options | `profile` (every row of `engineProfiles` plus `none`; changing it restarts the engine session on the same key, so the conversation continues under the new harness) and `model` (category `model`, from `list_models`). A `--harness` agent offers `model` only. |
| Sign-in | With `auth.identityProvider` set, the agent advertises one `authMethods` entry (`ion-oidc`, an agent method) and `logout`. `authenticate` runs the engine's browser login: the sign-in URL goes to the client as a request-scoped `elicitation/create` in url mode, or is opened on this machine for a client without url elicitation, and the request answers once the engine reports the operator signed in. `logout` signs the engine out. A session the engine refuses for want of a sign-in (`auth.requireOperatorIdentity`) fails with `-32000`, ACP's authentication-required code; every other failure uses `-32603`. |
| Identity | Sessions carry no principal of their own: extensions see the engine's signed-in operator, the same identity every other client of the engine sees. |
| Streaming | Text and thinking deltas; harness messages; usage with cumulative cost; extension slash commands as `available_commands_update`. A tool call opens as `tool_call` (kind from the tool name, `_meta.claudeCode.toolName` the wire name) and, the moment its streamed input is whole JSON, a `tool_call_update` describes it the way the Claude agent adapter does: a title (the command, the file, the pattern, the query), `locations` for the files it touches, a `diff` for `Edit`/`Write`, `server: tool` for an MCP tool; the result closes it as text content. A sub-agent dispatch is a `tool_call` of kind `think` whose content is the child's transcript as it streams, closed with its outcome and cost. Compaction (the engine's own, or a delegated CLI's) is `compaction_update`. A turn the engine starts on its own is a `user_message_chunk` when a person authored it, else a notice naming its kind; a finished background command, a model fallback, a stalled run, a usage limit, and extension notifications are notices. A declined capability ends the turn with a notice. |
| Permissions | An engine `ask` decision becomes `session/request_permission`; the client's answer becomes `permission_response`. A client that answers by its own permission mode (T3 Code's Auto modes approve automatically) needs no engine-side mode. |
| Elicitation | `ion.elicit` forms and extension dialogs become `elicitation/create` in form mode when the client advertised form elicitation; otherwise the request is cancelled and the client gets a notice. |
| Notices | `engine_notify` becomes a `notice` when the client advertised notices, else an agent message chunk. |

Not carried: resources (briefing and report cards), Studio SDK panels and composer actions, worktree and bench surfaces. Those were Ion Studio's; a harness that relied on them emits plain messages instead.

## A harness as its own agent

A Go extension built on the [Go SDK](../extensions/sdk-go.md) is its own ACP command: run as `main acp`, the binary replaces itself with `ion acp --harness <its directory>`, titled by `ion.WithTitle`, and passes on any further arguments (`--model`). The engine binary is `ION_ENGINE_BINARY`, else `~/.ion/bin/ion`, else `ion` on `PATH`. An ACP client launches the harness by its own path and never names Ion or a profile.

## T3 Code

T3 Code's **Local ACP command** provider runs any ACP agent from an executable and literal arguments. One provider instance is one agent.

1. Install the engine ([Engine Standalone](engine-standalone.md)) and configure it: providers, `auth`, and a `defaultModel` in `~/.ion/engine.json`.
2. In T3 Code open **Settings → Providers → Add provider → Local ACP command**.
3. For a harness: Executable is the harness binary, for example `~/.ion/extensions/cos2/main` (its full path). Arguments: `acp`. Display name: the harness, for example `Chief of Staff`. A harness without a binary of its own uses Executable `ion` with the arguments `acp`, `--harness`, and its path.
4. Add an instance with Executable `ion` and the argument `acp` alone, named `Ion`, for conversations that load no extensions or switch profiles.
5. Per project, **Settings → Providers** with the project selected switches an instance on or off for that project only.
6. Sign in: open the instance's account section in **Settings → Providers** and choose **Sign in**. T3 Code shows the identity provider's URL; open it and finish the login, and T3 Code reports the agent signed in. The engine keeps the grant and refreshes it, so one sign-in serves every instance and every client of the engine. `ion auth login` from a terminal does the same.

Models (and the profile, on a plain `ion acp` instance) appear in the composer's model options menu, from the config options the agent reports. T3 Code's Plan and Build toggle drives the engine's plan mode. Permission prompts follow the thread's permission mode.

Scheduled work does not depend on T3 Code: an extension with `scope: engine` runs its schedules in the daemon whether or not a client is connected.

## Other clients

Any ACP v1 client works the same way: spawn `ion acp` (or a harness binary with `acp`) and speak JSON-RPC over its stdio. The agent advertises `loadSession`, image prompts, embedded context, and, with an identity provider, sign-in; it reads the client's `session.notices`, `elicitation.form`, and `elicitation.url` capabilities to decide how to surface notices, forms, and the sign-in URL.
