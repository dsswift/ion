---
title: Raw Protocol (Any Language)
description: Build Ion Engine extensions in any language using the JSON-RPC 2.0 wire protocol.
sidebar_position: 9
---

# Building Extensions in Any Language

Extensions are subprocesses. Any language that can read stdin and write stdout can be an extension. This guide covers the raw JSON-RPC 2.0 protocol you need to implement.

## Requirements

Your extension binary must:

1. Read NDJSON (newline-delimited JSON) from stdin
2. Write NDJSON to stdout
3. Handle the `init` method and respond with tool/command registrations
4. Handle `hook/*`, `tool/*`, and `command/*` methods
5. Be named `main` and placed in the extension directory
6. Be executable (`chmod +x main`) — the engine requires the executable bit and refuses a `main` without it

Write debug output to stderr. Never write non-JSON to stdout.

## Minimal implementation

Here is a complete extension in Python that registers one tool and handles hooks:

```python
#!/usr/bin/env python3
import json
import sys


def respond(msg_id, result):
    msg = json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": result})
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def respond_error(msg_id, code, message):
    msg = json.dumps({"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}})
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def handle_init(msg_id, params):
    respond(msg_id, {
        "tools": [
            {
                "name": "word_count",
                "description": "Count words in a text string",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "description": "Text to count words in"}
                    },
                    "required": ["text"]
                }
            }
        ],
        "commands": {}
    })


def handle_tool(msg_id, tool_name, params):
    if tool_name == "word_count":
        text = params.get("text", "")
        count = len(text.split())
        respond(msg_id, {"content": f"Word count: {count}"})
    else:
        respond_error(msg_id, -32601, f"Tool not found: {tool_name}")


def handle_hook(msg_id, hook_name, params):
    # Handle hooks you care about, return null for the rest
    if hook_name == "session_start":
        sys.stderr.write("[word-count] session started\n")

    respond(msg_id, None)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        msg_id = msg.get("id")
        method = msg.get("method", "")
        params = msg.get("params", {})

        if method == "init":
            handle_init(msg_id, params)
        elif method.startswith("hook/"):
            handle_hook(msg_id, method[5:], params)
        elif method.startswith("tool/"):
            # Strip _ctx from params before passing to tool handler
            tool_params = {k: v for k, v in params.items() if k != "_ctx"}
            handle_tool(msg_id, method[5:], tool_params)
        elif method.startswith("command/"):
            respond(msg_id, None)
        else:
            respond_error(msg_id, -32601, f"Method not found: {method}")


if __name__ == "__main__":
    main()
```

Save as `main`, make executable, and place in your extension directory:

```bash
chmod +x main
```

## Init handshake

The first message the engine sends is always `init`. You must respond with your tool and command registrations.

**Request:**

```json
{"jsonrpc":"2.0","id":1,"method":"init","params":{"extensionDir":"/path/to/ext","workingDirectory":"/path/to/project"}}
```

**Response:**

```json
{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"my_tool","description":"...","parameters":{}}],"commands":{"my-cmd":{"description":"..."}}}}
```

If you have no tools or commands, respond with an empty result:

```json
{"jsonrpc":"2.0","id":1,"result":{}}
```

## Hook calls

The engine sends `hook/<name>` calls during the session. The params always include a `_ctx` field with session context. Hook-specific data is merged at the top level.

**Request:**

```json
{"jsonrpc":"2.0","id":5,"method":"hook/tool_call","params":{"_ctx":{"cwd":"/project"},"toolName":"Bash","toolID":"abc","input":{"command":"ls"}}}
```

**Response patterns:**

Return null for hooks you don't handle:

```json
{"jsonrpc":"2.0","id":5,"result":null}
```

Return a value to override behavior (hook-specific):

```json
{"jsonrpc":"2.0","id":5,"result":{"block":true,"reason":"Blocked"}}
```

You can include events to emit alongside your result:

```json
{"jsonrpc":"2.0","id":5,"result":{"events":[{"type":"engine_notify","message":"Tool blocked","level":"warn"}]}}
```

## Tool calls

When the LLM invokes your tool, the engine sends `tool/<name>`. The `_ctx` field is present in params; strip it before processing.

**Request:**

```json
{"jsonrpc":"2.0","id":10,"method":"tool/word_count","params":{"_ctx":{"cwd":"/project"},"text":"hello world"}}
```

**Response:**

```json
{"jsonrpc":"2.0","id":10,"result":{"content":"Word count: 2"}}
```

Return `isError: true` to signal failure:

```json
{"jsonrpc":"2.0","id":10,"result":{"content":"Failed to process","isError":true}}
```

## Command calls

**Request:**

```json
{"jsonrpc":"2.0","id":15,"method":"command/my-cmd","params":{"_ctx":{"cwd":"/project"},"args":"some args"}}
```

**Response:**

```json
{"jsonrpc":"2.0","id":15,"result":null}
```

## Sending notifications to the engine

Write notifications (no `id` field) to stdout to emit events or send messages:

```json
{"jsonrpc":"2.0","method":"ext/emit","params":{"type":"engine_notify","message":"Done","level":"info"}}
```

```json
{"jsonrpc":"2.0","method":"ext/send_message","params":{"text":"Processing complete"}}
```

## Sending requests to the engine

For process management and agent dispatch, send requests with an `id` field. The engine will write a response back on your stdin.

```json
{"jsonrpc":"2.0","id":100001,"method":"ext/register_process","params":{"name":"worker","pid":54321,"task":"running"}}
```

Read the response from stdin:

```json
{"jsonrpc":"2.0","id":100001,"result":{"ok":true}}
```

**Recalling an agent:**

```json
{"jsonrpc":"2.0","id":100002,"method":"ext/recall_agent","params":{"name":"researcher","reason":"no longer needed"}}
```

`ext/recall_agent` is retained for name-addressed compatibility. Prefer exact-ID `ext/recall_dispatch` when the dispatch ID is available:

```json
{"jsonrpc":"2.0","id":100003,"method":"ext/recall_dispatch","params":{"dispatchId":"dispatch-researcher-123","reason":"superseded"}}
```

Response:

```json
{"jsonrpc":"2.0","id":100002,"result":{"found":true}}
```

The `found` field is `true` when a running asynchronous dispatch was found and recalled, `false` otherwise.

### ext/task_suspend

Ends the current LLM run without completing it. Two shapes, distinguished by depth:

```json
{"jsonrpc":"2.0","id":100003,"method":"ext/task_suspend","params":{}}
```

```json
{"jsonrpc":"2.0","id":100004,"method":"ext/task_suspend","params":{"awaitingDispatchIds":["d-1","d-2"]}}
```

Inside a dispatched run (depth >= 1) the agent's LLM exits cleanly and shows as idle/suspended, the parent's `OnComplete` does NOT fire, and the run blocks until a `sendPrompt` to this session arrives — or, when `awaitingDispatchIds` is given, until every listed child dispatch has completed.

At depth 0 (the orchestrator) the root run ends and the session parks on its outstanding background bash commands, resuming when one completes. The root has no child goroutine to revive, so the engine starts a fresh run instead. See [ADR-023](../architecture/adr/023-root-session-park-and-wake.md).

Rejected with an error when there is nothing to park on — at depth 0 that means no active run, or no outstanding commands started with `notify_on_complete: true`. `awaitingDispatchIds` is rejected at depth 0: child dispatches only exist inside a dispatched run.

### ext/get_session_memory

Returns the current session memory content.

**Request:**
```json
{"jsonrpc":"2.0","id":1,"method":"ext/get_session_memory","params":{}}
```

**Response:**
```json
{"jsonrpc":"2.0","id":1,"result":{"content":"## Current Task\nWorking on..."}}
```

### ext/set_session_memory

Replaces the session memory with custom content and persists it to disk.

**Request:**
```json
{"jsonrpc":"2.0","id":1,"method":"ext/set_session_memory","params":{"content":"Custom summary..."}}
```

**Response:**
```json
{"jsonrpc":"2.0","id":1,"result":{}}
```

Your extension needs to handle both incoming requests (from engine) and incoming responses (to your outgoing requests) on the same stdin stream. Distinguish them by checking whether the message has a `method` field (incoming request) or not (response to your request).

## Dispatch lifecycle notifications

When an asynchronous dispatch is active (default for `ext/dispatch_agent`; `waitForCompletion: true` is explicit foreground opt-in), engine sends lifecycle notifications *to* extension stdin. Notifications are observational: engine automatic parent delivery does not depend on handlers.

| Method | When | Payload |
|--------|------|---------|
| `dispatch_complete` | Agent finished successfully | `{callbackId, dispatchId, name, output, exitCode, elapsed, cost, inputTokens, outputTokens, sessionId}` |
| `dispatch_error` | Agent failed | `{callbackId, dispatchId, name, message, exitCode, elapsed}` |
| `dispatch_recall` | Agent was recalled | `{callbackId, dispatchId, name, reason, elapsed, toolCount}` |
| `dispatch_tool_start` | Tool invocation began in child | `{callbackId, dispatchId, name, toolName, toolId}` |
| `dispatch_tool_end` | Tool completed in child | `{callbackId, dispatchId, name, toolName, toolId, content}` |
| `dispatch_tool_error` | Tool errored in child | `{callbackId, dispatchId, name, toolName, toolId, content}` |
| `dispatch_usage` | Token usage update from child | `{callbackId, dispatchId, name, inputTokens, outputTokens, cumulativeInputTokens, cumulativeOutputTokens, cumulativeCost}` |
| `dispatch_text_delta` | Streaming text from child | `{callbackId, dispatchId, name, delta, accumulated}` |
| `dispatch_plan_proposal` | Child agent proposed a plan (called ExitPlanMode) | `{callbackId, dispatchId, name, agentId, planFilePath, planSlug, planRequested}` |

Every lifecycle payload carries `dispatchId` and, when supplied on the request, `callbackId`. Use `callbackId` from request start, then `dispatchId` after stub response, to correlate simultaneous same-name dispatches without a pre-response race.

Example incoming notification:

```json
{"jsonrpc":"2.0","method":"dispatch_complete","params":{"callbackId":"client-local-42","dispatchId":"d-abc123","name":"researcher","output":"Found 12 TODOs","exitCode":0,"elapsed":8.3,"cost":0.012,"inputTokens":5000,"outputTokens":2000}}
```

Handle these by checking the `method` field on incoming messages alongside the existing `hook/*`, `tool/*`, and `command/*` patterns.

## Key implementation notes

1. **Flush stdout after every write.** Buffered output will cause the engine to hang waiting for responses.
2. **Handle unknown hooks gracefully.** The engine may send any hook to subprocess extensions. Return null for hooks you don't care about.
3. **Respect the RPC timeout.** The engine drops calls that don't respond within the configured timeout (default: 30 seconds, configurable via `timeouts.extensionRpcMs` in `engine.json`).
4. **Never write non-JSON to stdout.** Debug output goes to stderr.
5. **Parse the `_ctx` field** from hook and tool params if you need session context (`cwd`, `sessionKey`, `conversationId`, `model`, `config`, and — for dispatched child sessions only — `depth` and `dispatchId`; both keys are omitted for the root session, so treat absence as `depth: 0`).
6. **Use unique IDs for outgoing requests.** Start from a high number (e.g., 100000) to avoid collisions with engine-assigned IDs.

## Workspace Context

Clients can supply workspace context via the `clientWorkspaceContext` field on `send_prompt` (per-prompt) or `start_session` (session-wide default) commands. The engine routes it to extensions through hook calls:

- `hook/system_inject` with `kind: "workspace_context"` -- the `workspace` field carries structured bench/client data. Return `{"text": "..."}` to replace the default prose, or `{"suppress": true}` to suppress injection.
- `hook/context_inject` -- the `workspace` field on the payload carries the same structure.

The `workspace` object in hook payloads has this shape:

```json
{
  "kind": "workspace_context",
  "cwd": "/path/to/project",
  "worktree": { "...engine-owned data..." },
  "bench": { "...client-supplied bench facts..." },
  "client": { "...generic consumer data..." }
}
```

`bench` comes from `ClientWorkspaceContext.bench` on the client command; `client` comes from `ClientWorkspaceContext.data`. Both are opaque pass-through maps. See [client-commands.md](../protocol/client-commands.md) for the wire shape.

## Compiled binary extensions

For compiled languages, build a binary named `main`:

```bash
# Go
go build -o main .

# Rust
cargo build --release && cp target/release/my-ext main

# C
gcc -o main extension.c
```

Place the binary in the extension directory. The engine executes it directly, with no runtime dependency.

Two details of entry-point resolution matter here:

- **Script entry points win.** The engine probes `extension.ts`, `index.ts`, `extension.js`, `index.js`, `extension.mjs`, and `index.mjs` before it looks for `main`. A directory holding both a script and a compiled binary is a source tree with its build output beside it, and the script is the authored entry point.
- **The executable bit is required.** A `main` without it does not resolve; the engine fails at load naming the candidates it probed, rather than at spawn with a bare permission denial.

**In Go, do not implement this protocol by hand.** The [Go SDK](sdk-go.md) is a dependency-free module that handles the framing, the hook dispatch, the context surface, and the init handshake:

```bash
go get github.com/dsswift/ion/sdk/go
```

This page remains the reference for every other language, and for anyone who wants to know exactly what the SDKs put on the wire.

## Resources, Notifications, and Cross-Session Messaging

Raw-protocol extensions access the resource subsystem, notifications, and cross-session messaging via these JSON-RPC methods. Send them as requests (with an `id`) and read the response from stdin.

### ext/declare_resource

Declare a resource collection for this extension. Call once at startup (inside or shortly after `init`).

```json
{"jsonrpc":"2.0","id":100010,"method":"ext/declare_resource","params":{"kind":"tasks"}}
```

Response: `{"jsonrpc":"2.0","id":100010,"result":{"ok":true}}`

### ext/publish_resource

Publish a resource operation. The session broker stamps `item.producer` from the extension identity, then fans the attributed delta to the producer-free global broker. Any producer value supplied in `item` is ignored. Multiple extensions can publish the same kind; item identity is `(kind, producer, id)`.

```json
{"jsonrpc":"2.0","id":100011,"method":"ext/publish_resource","params":{"op":"update","item":{"id":"task-1","conversationId":"conv-1","title":"Updated"}}}
```

`op` is one of `"create"`, `"update"`, `"delete"`, `"mark_read"`.

Response: `{"jsonrpc":"2.0","id":100011,"result":{"ok":true}}`

### resource/query

The engine calls this method on your extension when a client subscribes to a resource kind you declared. The `filter` contains the requested `kind` and can include `producer` or `id`. Respond with the current full collection. The engine stamps the producer on every returned item.

```json
{"jsonrpc":"2.0","id":5,"method":"resource/query","params":{"kind":"tasks"}}
```

Response:

```json
{"jsonrpc":"2.0","id":5,"result":{"items":[{"id":"task-1","title":"Do the thing"},{"id":"task-2","title":"Do another thing"}]}}
```

### ext/notify

Send a push notification through the engine/relay pipeline.

```json
{"jsonrpc":"2.0","id":100012,"method":"ext/notify","params":{"kind":"task_complete","title":"Task finished","body":"Analysis complete.","sound":true}}
```

Response: `{"jsonrpc":"2.0","id":100012,"result":{"ok":true}}`

### ext/list_sessions

List sessions running the same extension type.

```json
{"jsonrpc":"2.0","id":100013,"method":"ext/list_sessions","params":{}}
```

Response:

```json
{"jsonrpc":"2.0","id":100013,"result":{"sessions":[{"key":"abc-123","hasActiveRun":true,"extensionName":"my-ext","conversationId":"conv-1"}]}}
```

### ext/send_to_session

Send a structured message to another session. The engine enforces same extension type. The target session's `session_message` hook fires with `{senderSessionKey, kind, payload}`.

```json
{"jsonrpc":"2.0","id":100014,"method":"ext/send_to_session","params":{"targetKey":"abc-123","kind":"task_update","payload":{"taskId":"t-1","status":"done"}}}
```

Response: `{"jsonrpc":"2.0","id":100014,"result":{"ok":true}}`

### ext/set_plan_mode

Enter or exit plan mode for the current session. Emits `engine_plan_mode_changed` to all subscribers. No-op when the session is already in the requested state.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | yes | `true` to enter plan mode, `false` to exit |
| `source` | string | no | Free-form audit string logged with the transition (e.g. `"extension"`, `"slash_command"`). Defaults to `"extension"` when blank. |

```json
{"jsonrpc":"2.0","id":100020,"method":"ext/set_plan_mode","params":{"enabled":true,"source":"safety_gate"}}
```

Response: `{"jsonrpc":"2.0","id":100020,"result":{"ok":true}}`

### ext/set_run_recovery

Set extension-owned recovery policy for later runs in current session. This policy overrides `start_session` and `engine.json` values. `enabled` is required. `maxAttempts: 0` uses engine default. This call does not change journal for active run.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | yes | Enable or disable durable recovery for later runs in this session. |
| `maxAttempts` | number | no | Maximum durable restart attempts. `0` or omitted uses engine default. |

```json
{"jsonrpc":"2.0","id":100022,"method":"ext/set_run_recovery","params":{"enabled":true,"maxAttempts":3}}
```

Response: `{"jsonrpc":"2.0","id":100022,"result":{"ok":true}}`

### ext/get_plan_mode

Query the current plan-mode state for this session.

**Params:** none

```json
{"jsonrpc":"2.0","id":100021,"method":"ext/get_plan_mode","params":{}}
```

Response: `{"jsonrpc":"2.0","id":100021,"result":{"enabled":true,"planFilePath":"/Users/josh/.ion/plans/abc-123.md"}}`

`planFilePath` is non-empty whenever a plan file has been allocated for the session, even when plan mode is currently off — the path is preserved across toggles until the session resets.

### ext/intercept

Emit an `engine_intercept` event on a target session's stream. The engine stamps `interceptSource` from the calling extension's name.

```json
{"jsonrpc":"2.0","id":100015,"method":"ext/intercept","params":{"level":"banner","title":"Task complete","message":"The analysis finished.","targetSessionKey":"abc-123"}}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `level` | string | yes | `"banner"` (informational) or `"redirect"` (urgent) |
| `title` | string | yes | Short headline |
| `message` | string | no | Body content |
| `targetSessionKey` | string | no | Target session; defaults to caller's session |
| `metadata` | object | no | Opaque map forwarded to clients unchanged |

Response: `{"jsonrpc":"2.0","id":100015,"result":{"ok":true}}`

### ext/run_once_check

Check whether this instance should execute a cross-instance dedup operation.

```json
{"jsonrpc":"2.0","id":100016,"method":"ext/run_once_check","params":{"id":"daily-sync","debounceMs":60000}}
```

Response: `{"jsonrpc":"2.0","id":100016,"result":{"execute":true,"reason":""}}` or `{"jsonrpc":"2.0","id":100016,"result":{"execute":false,"reason":"debounced"}}`

### ext/run_once_complete

Record the outcome of a dedup operation. Call after `ext/run_once_check` returned `execute: true`.

```json
{"jsonrpc":"2.0","id":100017,"method":"ext/run_once_complete","params":{"id":"daily-sync","failed":false}}
```

When `failed` is `true`, the lock is released without updating the last-run timestamp so the next instance retries immediately.

Response: `{"jsonrpc":"2.0","id":100017,"result":{"ok":true}}`
