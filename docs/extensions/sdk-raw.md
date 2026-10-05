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
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "init",
  "params": {
    "extensionDir": "/path/to/ext",
    "workingDirectory": "/path/to/project"
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [{ "name": "my_tool", "description": "...", "parameters": {} }],
    "commands": { "my-cmd": { "description": "..." } }
  }
}
```

If you have no tools or commands, respond with an empty result:

```json
{ "jsonrpc": "2.0", "id": 1, "result": {} }
```

## Hook calls

The engine sends `hook/<name>` calls during the session. The params always include a `_ctx` field with session context. Hook-specific data is merged at the top level.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "hook/tool_call",
  "params": {
    "_ctx": { "cwd": "/project" },
    "toolName": "Bash",
    "toolID": "abc",
    "input": { "command": "ls" }
  }
}
```

**Response patterns:**

Return null for hooks you don't handle:

```json
{ "jsonrpc": "2.0", "id": 5, "result": null }
```

Return a value to override behavior (hook-specific):

```json
{ "jsonrpc": "2.0", "id": 5, "result": { "block": true, "reason": "Blocked" } }
```

You can include events to emit alongside your result:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "events": [
      { "type": "engine_notify", "message": "Tool blocked", "level": "warn" }
    ]
  }
}
```

## Tool calls

When the LLM invokes your tool, the engine sends `tool/<name>`. The `_ctx` field is present in params; strip it before processing.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tool/word_count",
  "params": { "_ctx": { "cwd": "/project" }, "text": "hello world" }
}
```

**Response:**

```json
{ "jsonrpc": "2.0", "id": 10, "result": { "content": "Word count: 2" } }
```

Return `isError: true` to signal failure:

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "result": { "content": "Failed to process", "isError": true }
}
```

### Model Boundary hook

Before applying a resolved command's model tier to a conversation with history, the engine sends:

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "hook/before_slash_model_boundary",
  "params": {
    "_ctx": { "sessionKey": "s1" },
    "command": "/benchmark",
    "requestedTier": "reasoning",
    "servingModel": "current-model",
    "hasHistory": true,
    "defaultApply": false
  }
}
```

Return `null` to abstain, or an explicit decision. The last explicit decision across handlers wins.

```json
{ "jsonrpc": "2.0", "id": 6, "result": { "apply": true } }
```

## Command calls

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 15,
  "method": "command/my-cmd",
  "params": { "_ctx": { "cwd": "/project" }, "args": "some args" }
}
```

**Response:**

```json
{ "jsonrpc": "2.0", "id": 15, "result": null }
```

## Sending notifications to the engine

Write notifications (no `id` field) to stdout to emit events or send messages:

```json
{
  "jsonrpc": "2.0",
  "method": "ext/emit",
  "params": { "type": "engine_notify", "message": "Done", "level": "info" }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "ext/send_message",
  "params": { "text": "Processing complete" }
}
```

## Sending requests to the engine

For process management and agent dispatch, send requests with an `id` field. The engine will write a response back on your stdin.

```json
{
  "jsonrpc": "2.0",
  "id": 100001,
  "method": "ext/send_prompt",
  "params": {
    "text": "Run the command",
    "slashModelTierApplyMidConversation": true
  }
}
```

`slashModelTierApplyMidConversation` is optional. Omit it to inherit engine configuration; `before_slash_model_boundary` still has final say.

```json
{
  "jsonrpc": "2.0",
  "id": 100001,
  "method": "ext/register_process",
  "params": { "name": "worker", "pid": 54321, "task": "running" }
}
```

Read the response from stdin:

```json
{ "jsonrpc": "2.0", "id": 100001, "result": { "ok": true } }
```

**Recalling an agent:**

```json
{
  "jsonrpc": "2.0",
  "id": 100002,
  "method": "ext/recall_agent",
  "params": { "name": "researcher", "reason": "no longer needed" }
}
```

`ext/recall_agent` addresses a dispatch by agent name and acts only when exactly one live dispatch carries it. Prefer exact-ID `ext/recall_dispatch` when the dispatch ID is available:

```json
{
  "jsonrpc": "2.0",
  "id": 100003,
  "method": "ext/recall_dispatch",
  "params": { "dispatchId": "dispatch-researcher-123", "reason": "superseded" }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 100002,
  "result": { "found": true, "outcome": "recalled" }
}
```

The `found` field is `true` when a running asynchronous dispatch was found and recalled, `false` otherwise. `ext/recall_agent` also carries `outcome`: `recalled`, `not_found`, or `ambiguous`. When several live dispatches share the name, nothing is recalled and the response lists them:

```json
{
  "jsonrpc": "2.0",
  "id": 100002,
  "result": {
    "found": false,
    "outcome": "ambiguous",
    "matchingDispatchIds": [
      "dispatch-researcher-123",
      "dispatch-researcher-456"
    ]
  }
}
```

`ext/steer_dispatch_by_name` answers the same way: `{"delivered":false,"outcome":"ambiguous","matchingDispatchIds":[...]}`, and nothing is delivered. Retry with `ext/steer_dispatch` against one of the IDs. Name lookup searches only the dispatches the caller owns.

**Ownership and finished targets.** Steer and recall act only on dispatches the caller owns: the root context owns every dispatch in its session, a dispatched agent only its own descendants. `ext/steer_dispatch` answers `"outcome":"unauthorized"` otherwise. `ext/recall_dispatch` answers a `-32000` error whose `data.outcome` is `"unauthorized"`:

```json
{
  "jsonrpc": "2.0",
  "id": 100003,
  "error": {
    "code": -32000,
    "message": "dispatch \"dispatch-researcher-123\" is not a descendant owned by the caller",
    "data": { "outcome": "unauthorized" }
  }
}
```

When the target already finished, both answer `"outcome":"completed"` with a `terminal` object shaped like an `ext/list_dispatch_history` entry, instead of `not_found`:

```json
{
  "jsonrpc": "2.0",
  "id": 100003,
  "result": {
    "found": false,
    "outcome": "completed",
    "terminal": {
      "dispatchId": "dispatch-researcher-123",
      "name": "researcher",
      "status": "done",
      "exitCode": 0,
      "depth": 1,
      "startedAt": "2026-09-29T14:00:00Z",
      "completedAt": "2026-09-29T14:02:10Z",
      "durationMs": 130000,
      "toolCount": 12
    }
  }
}
```

`ext/recall_dispatch` results carry `outcome` too: `recalled`, `completed`, or `not_found`.

**Listing ended dispatches:**

```json
{
  "jsonrpc": "2.0",
  "id": 100004,
  "method": "ext/list_dispatch_history",
  "params": {}
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 100004,
  "result": {
    "dispatches": [
      {
        "dispatchId": "dispatch-researcher-123",
        "name": "researcher",
        "status": "cancelled",
        "reason": "superseded",
        "exitCode": 2,
        "depth": 1,
        "startedAt": "2026-09-29T14:00:00Z",
        "completedAt": "2026-09-29T14:02:10Z",
        "durationMs": 130000,
        "toolCount": 12
      }
    ]
  }
}
```

`ext/list_dispatch_history` is the terminal peer of `ext/list_dispatch_state`, which lists only live dispatches. Entries are ordered oldest completion first. `status` is `done`, `error`, `cancelled`, or `lost` (running when the engine process died). `exitCode` is absent when unknown. History survives a session or engine restart. The caller sees the same set it would see live: the root context sees every entry, a dispatched agent only its descendants. Retention is bounded by `dispatchHistory` in `engine.json`.

**Reading a dispatch's conversation:**

```json
{
  "jsonrpc": "2.0",
  "id": 100005,
  "method": "ext/read_dispatch_conversation",
  "params": { "conversationId": "conv-abc", "limit": 2 }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 100005,
  "result": {
    "outcome": "ok",
    "conversationId": "conv-abc",
    "dispatchId": "dispatch-researcher-123",
    "agentName": "researcher",
    "status": "running",
    "terminal": false,
    "entries": [
      {
        "id": "e1",
        "role": "assistant",
        "timestamp": 1790000000000,
        "blocks": [
          { "type": "text", "text": "Reading the file." },
          {
            "type": "tool_call",
            "toolCallId": "t1",
            "toolName": "Read",
            "input": { "path": "/repo/a.go" }
          }
        ]
      },
      {
        "id": "e2",
        "role": "user",
        "timestamp": 1790000001000,
        "blocks": [
          {
            "type": "tool_result",
            "toolCallId": "t1",
            "toolName": "Read",
            "content": "package a"
          }
        ]
      }
    ],
    "nextCursor": "eyJ2IjoxLCJpZCI6ImUyIiwiaSI6MX0",
    "hasMore": true,
    "totalEntries": 9,
    "limits": {
      "entries": 2,
      "bytes": 32768,
      "maxEntries": 200,
      "maxBytes": 262144
    }
  }
}
```

`ext/read_dispatch_conversation` returns one page of the conversation a dispatch wrote. Name the target with `conversationId`, `dispatchId`, or both. With both, they must name the same dispatch. A request with neither is a `-32602` error.

The engine decides who may read from its own dispatch lineage, never from anything the caller claims. The root context may read every dispatch in its session. A dispatched agent may read only its descendants, direct or deeper. This is the same rule as `ext/list_dispatch_state`. It holds while the dispatch runs, after it ends, and after a session or engine restart, for as long as the dispatch is in the record that `dispatchHistory` bounds.

Every refusal is a normal result with an `outcome`, not an error:

| `outcome`        | Meaning                                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`             | `entries` holds the page.                                                                                                                                                                           |
| `unauthorized`   | The target is not a dispatch the caller owns, or its lineage cannot be proven. No other field is set, so the answer does not reveal whether the conversation exists.                                |
| `unavailable`    | The caller owns the dispatch, but there is no conversation to read. `unavailableReason` is `not_created` (the child never started one) or `not_found` (it was removed from the conversation store). |
| `invalid_cursor` | The cursor does not name an entry of this conversation. Read again without a cursor.                                                                                                                |

An engine without this method answers `-32601`.

Each entry is one message. `id` is stable across reads. `blocks` keep the order they were written in, so text, tool calls, and tool results stay interleaved. A block's `type` is `text`, `thinking`, `tool_call` (`toolCallId`, `toolName`, `input`), or `tool_result` (`toolCallId`, `toolName`, `content`, `isError`). Any other block keeps its own type name.

`status` is `running` or `suspended` while the dispatch is live, and `done`, `error`, `cancelled`, or `lost` once `terminal` is `true`. `reason` and `exitCode` carry the terminal outcome. They are never part of the transcript.

Paging uses `cursor`, an opaque string. Pass back `nextCursor` to get the entries after the last one returned. It works on a live conversation too: when `hasMore` is `false` and `terminal` is `false`, keep the cursor and read again later to get only what is new. The call never waits for the child.

`limit` and `maxBytes` ask for a page size. The engine lowers either to its maximum, set by `dispatchConversationRead` in `engine.json`, and reports what it used in `limits`. A single entry too large for the page is returned alone, with oversized blocks cut and marked `truncated` with `originalBytes`.

### ext/scan_wiki_links

Runs the read-only [link integrity scan](../architecture/wiki-links.md#link-integrity-scan) over the session's working directory.

```json
{
  "jsonrpc": "2.0",
  "id": 100005,
  "method": "ext/scan_wiki_links",
  "params": {}
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 100005,
  "result": {
    "root": "/work/docs",
    "documentsScanned": 212,
    "linksChecked": 640,
    "broken": [
      {
        "path": "guides/setup.md",
        "line": 14,
        "link": "[[install-notes|notes]]",
        "target": "install-notes",
        "reason": "missing"
      }
    ]
  }
}
```

`broken` is an empty array when every link resolves. `reason` is `missing` or `ambiguous`; an ambiguous entry also carries `candidates`. The call answers with a JSON-RPC error, not an empty report, when the scan is turned off by the `wikiLinks` block in `engine.json`.

### ext/task_suspend

Ends the current LLM run without completing it. Two shapes, distinguished by depth:

```json
{ "jsonrpc": "2.0", "id": 100003, "method": "ext/task_suspend", "params": {} }
```

```json
{
  "jsonrpc": "2.0",
  "id": 100004,
  "method": "ext/task_suspend",
  "params": { "awaitingDispatchIds": ["d-1", "d-2"] }
}
```

Inside a dispatched run (depth >= 1) the agent's LLM exits cleanly and shows as idle/suspended, the parent's `OnComplete` does NOT fire, and the run blocks until a `sendPrompt` to this session arrives — or, when `awaitingDispatchIds` is given, until every listed child dispatch has completed.

At depth 0 (the orchestrator) the root run ends and the session parks on its outstanding background bash commands, resuming when one completes. The root has no child goroutine to revive, so the engine starts a fresh run instead. See [ADR-023](../architecture/adr/023-root-session-park-and-wake.md).

Rejected with an error when there is nothing to park on — at depth 0 that means no active run, or no outstanding commands started with `notify_on_complete: true`. `awaitingDispatchIds` is rejected at depth 0: child dispatches only exist inside a dispatched run.

### ext/get_session_memory

Returns the current session memory content.

**Request:**

```json
{ "jsonrpc": "2.0", "id": 1, "method": "ext/get_session_memory", "params": {} }
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "content": "## Current Task\nWorking on..." }
}
```

### ext/set_session_memory

Replaces the session memory with custom content and persists it to disk.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "ext/set_session_memory",
  "params": { "content": "Custom summary..." }
}
```

**Response:**

```json
{ "jsonrpc": "2.0", "id": 1, "result": {} }
```

Your extension needs to handle both incoming requests (from engine) and incoming responses (to your outgoing requests) on the same stdin stream. Distinguish them by checking whether the message has a `method` field (incoming request) or not (response to your request).

## Dispatch lifecycle notifications

When an asynchronous dispatch is active (default for `ext/dispatch_agent`; `waitForCompletion: true` is explicit foreground opt-in), engine sends lifecycle notifications _to_ extension stdin. Notifications are observational: engine automatic parent delivery does not depend on handlers.

| Method                   | When                                              | Payload                                                                                                                    |
| ------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `dispatch_complete`      | Agent finished successfully (`exitCode` 0)        | `{callbackId, dispatchId, name, output, exitCode, elapsed, cost, inputTokens, outputTokens, toolCount, sessionId}`         |
| `dispatch_error`         | Agent failed, or was declined (`exitCode` 3)      | `{callbackId, dispatchId, name, message, exitCode, elapsed}`                                                               |
| `dispatch_recall`        | Agent was recalled                                | `{callbackId, dispatchId, name, reason, elapsed, toolCount}`                                                               |
| `dispatch_tool_start`    | Tool invocation began in child                    | `{callbackId, dispatchId, name, toolName, toolId}`                                                                         |
| `dispatch_tool_end`      | Tool completed in child                           | `{callbackId, dispatchId, name, toolName, toolId, content}`                                                                |
| `dispatch_tool_error`    | Tool errored in child                             | `{callbackId, dispatchId, name, toolName, toolId, content}`                                                                |
| `dispatch_park_checkin`  | A parked dispatch's check-in interval elapsed (only when the dispatch sent `parkCheckInAsk`). Answer with `ext/answer_dispatch_park_checkin` | `{callbackId, dispatchId, requestId, name, depth, parkedMs, checkInCount, awaitingDispatchIds, awaitingTaskIds, awaitingPollIds, awaitingDispatches}` |
| `dispatch_usage`         | Token usage update from child                     | `{callbackId, dispatchId, name, inputTokens, outputTokens, cumulativeInputTokens, cumulativeOutputTokens, cumulativeCost}` |
| `dispatch_text_delta`    | Streaming text from child                         | `{callbackId, dispatchId, name, delta, accumulated}`                                                                       |
| `dispatch_plan_proposal` | Child agent proposed a plan (called ExitPlanMode) | `{callbackId, dispatchId, name, agentId, planFilePath, planSlug, planRequested}`                                           |

Every lifecycle payload carries `dispatchId` and, when supplied on the request, `callbackId`. Use `callbackId` from request start, then `dispatchId` after stub response, to correlate simultaneous same-name dispatches without a pre-response race.

`toolCount` on `dispatch_complete` is the number of tool calls the child made across its whole run. It is always present, whether or not `requireToolUse` was declared: it is an observed fact about the run, not a verdict. A `0` alongside `"exitCode":0` is the signature of a child that described the work instead of doing it.

### Declaring that a dispatch must produce work

`ext/dispatch_agent` accepts two additional optional params that govern the child's work expectation and its injected context:

```json
{
  "jsonrpc": "2.0",
  "id": 100006,
  "method": "ext/dispatch_agent",
  "params": {
    "name": "implementer",
    "task": "Apply the approved plan",
    "requireToolUse": true,
    "contextPolicy": { "maxContextBytes": 120000 }
  }
}
```

`requireToolUse` is tri-state on the wire — **omit it** to declare nothing, which is the default and leaves an existing client's behavior unchanged:

| Value       | Effect                                                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`      | A completion with zero tool calls is not success. The engine gives the child one continuation naming the expectation; if the retry also calls no tools the dispatch reports `"exitCode":3` and its delivered status is `declined`. |
| `false`     | Explicit exemption for analysis, summarization, and advisory dispatches.                                                                                                                                                           |
| _(omitted)_ | No expectation. The engine reports `toolCount` and passes no judgement.                                                                                                                                                            |

The engine never infers the expectation from the task text; only the caller knows which kind of dispatch it issued. Exit code `3` is distinct from `1`: a declined dispatch ran correctly and produced nothing, so a client that retries failures must not retry it. Because the code is non-zero, an asynchronous declined dispatch arrives as `dispatch_error`, with the engine's verdict and the child's own final text in `message`.

`contextPolicy.maxContextBytes` caps the total context-file bytes injected into this dispatch. Omit it or pass `<= 0` for no cap. Files are admitted whole, nearest-first, until the budget is spent; the rest are skipped entirely and logged by name. A file is never truncated mid-content, because half an instruction file leaves the agent unable to tell which rules it did not receive.

Example incoming notification:

```json
{
  "jsonrpc": "2.0",
  "method": "dispatch_complete",
  "params": {
    "callbackId": "client-local-42",
    "dispatchId": "d-abc123",
    "name": "researcher",
    "output": "Found 12 TODOs",
    "exitCode": 0,
    "elapsed": 8.3,
    "cost": 0.012,
    "inputTokens": 5000,
    "outputTokens": 2000
  }
}
```

Handle these by checking the `method` field on incoming messages alongside the existing `hook/*`, `tool/*`, and `command/*` patterns.

## Key implementation notes

1. **Flush stdout after every write.** Buffered output will cause the engine to hang waiting for responses.
2. **Handle unknown hooks gracefully.** The engine may send any hook to subprocess extensions. Return null for hooks you don't care about.
3. **Respect the RPC timeout.** The engine drops calls that don't respond within the configured timeout (default: 30 seconds, configurable via `timeouts.extensionRpcMs` in `engine.json`).
4. **Never write non-JSON to stdout.** Debug output goes to stderr.
5. **Parse the `_ctx` field** from hook and tool params if you need session context (`cwd`, `sessionKey`, `conversationId`, `conversationRecordPath`, `model`, `config`, and — for dispatched child sessions only — `depth` and `dispatchId`; both keys are omitted for the root session, so treat absence as `depth: 0`).
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
{
  "jsonrpc": "2.0",
  "id": 100010,
  "method": "ext/declare_resource",
  "params": { "kind": "tasks" }
}
```

Response: `{"jsonrpc":"2.0","id":100010,"result":{"ok":true}}`

### ext/publish_resource

Publish a resource operation. The session broker stamps `item.producer` from the extension identity, then fans the attributed delta to the producer-free global broker. Any producer value supplied in `item` is ignored. Multiple extensions can publish the same kind; item identity is `(kind, producer, id)`.

```json
{
  "jsonrpc": "2.0",
  "id": 100011,
  "method": "ext/publish_resource",
  "params": {
    "op": "update",
    "item": { "id": "task-1", "conversationId": "conv-1", "title": "Updated" }
  }
}
```

`op` is one of `"create"`, `"update"`, `"delete"`, `"mark_read"`.

Response: `{"jsonrpc":"2.0","id":100011,"result":{"ok":true}}`

### resource/query

The engine calls this method on your extension when a client subscribes to a resource kind you declared. The `filter` contains the requested `kind` and can include `producer` or `id`. Respond with the current full collection. The engine stamps the producer on every returned item.

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "resource/query",
  "params": { "kind": "tasks" }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "items": [
      { "id": "task-1", "title": "Do the thing" },
      { "id": "task-2", "title": "Do another thing" }
    ]
  }
}
```

### ext/notify

Send a push notification through the engine/relay pipeline.

```json
{
  "jsonrpc": "2.0",
  "id": 100012,
  "method": "ext/notify",
  "params": {
    "kind": "task_complete",
    "title": "Task finished",
    "body": "Analysis complete.",
    "sound": true
  }
}
```

Response: `{"jsonrpc":"2.0","id":100012,"result":{"ok":true}}`

### ext/list_sessions

List sessions running the same extension type.

```json
{ "jsonrpc": "2.0", "id": 100013, "method": "ext/list_sessions", "params": {} }
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 100013,
  "result": {
    "sessions": [
      {
        "key": "abc-123",
        "hasActiveRun": true,
        "extensionName": "my-ext",
        "conversationId": "conv-1"
      }
    ]
  }
}
```

### ext/send_to_session

Send a structured message to another session. The engine enforces same extension type. The target session's `session_message` hook fires with `{senderSessionKey, kind, payload}`.

```json
{
  "jsonrpc": "2.0",
  "id": 100014,
  "method": "ext/send_to_session",
  "params": {
    "targetKey": "abc-123",
    "kind": "task_update",
    "payload": { "taskId": "t-1", "status": "done" }
  }
}
```

Response: `{"jsonrpc":"2.0","id":100014,"result":{"ok":true}}`

### ext/read_conversation

Read one page of a conversation record by conversation ID. The engine reads the record from disk, so the conversation may be the caller's own, another live one, or one that has ended. Read-only. `offset` is the zero-based first message; `limit` caps the page, and `0` (or absent) returns every message from `offset` onward.

```json
{"jsonrpc":"2.0","id":100014,"method":"ext/read_conversation","params":{"conversationId":"1780093348767-c1c03e998388","offset":0,"limit":200}}
```

Response:

```json
{"jsonrpc":"2.0","id":100014,"result":{"messages":[{"id":"e1","role":"user","content":"hi","timestamp":1780093348767}],"total":1,"hasMore":false}}
```

`total` is the record's full message count. A missing `conversationId` answers `-32602`. An unknown conversation, or one principal partitioning refuses the calling session, answers `-32000`.

### ext/set_plan_mode

Enter or exit plan mode for the current session. The request takes the same path as a client's `set_plan_mode`: `before_plan_mode_enter` / `before_plan_mode_exit` fire with `source: "extension"` (and this call's `source` as `clientSource`), and any handler may veto it. An allowed change emits `engine_plan_mode_changed` and switches a run in flight in the current turn. A veto leaves the mode where it is and emits `engine_plan_mode_change_rejected`. A request for the mode the session is already in fires nothing and reports `allowed: true, changed: false`.

| Param     | Type    | Required | Description                                                                                                                      |
| --------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `enabled` | boolean | yes      | `true` to enter plan mode, `false` to exit                                                                                       |
| `source`  | string  | no       | Free-form audit string logged with the transition (e.g. `"extension"`, `"slash_command"`). Defaults to `"extension"` when blank. |

```json
{
  "jsonrpc": "2.0",
  "id": 100020,
  "method": "ext/set_plan_mode",
  "params": { "enabled": true, "source": "safety_gate" }
}
```

Response: `{"jsonrpc":"2.0","id":100020,"result":{"ok":true,"allowed":true,"changed":true}}`

| Field     | Type    | Description |
| --------- | ------- | ----------- |
| `ok`      | boolean | Always `true` when the request was handled |
| `allowed` | boolean | `false` when a `before_plan_mode_*` handler vetoed the change. An engine that predates the veto omits it; treat absent as `true` |
| `changed` | boolean | `true` when the session's mode actually flipped |
| `reason`  | string  | The vetoing handler's explanation (omitempty) |

### ext/walk_context_files

Walk the context files (AGENTS.md, ION.md, CLAUDE.md, and their `.ion/` / `.claude/` forms) the engine would load from a directory, without injecting anything. Fires no hooks.

| Param             | Type    | Required | Description |
| ----------------- | ------- | -------- | ----------- |
| `cwd`             | string  | yes      | Directory to walk from. An empty `cwd` returns `[]` |
| `includeGlobal`   | boolean | no       | Include the home roots (`~/.ion`, and `~/.claude` with `claudeCompat`). Default `true` |
| `includeProject`  | boolean | no       | Include `cwd` and its parents. Default `true` |
| `claudeCompat`    | boolean | no       | Also match the Claude-compat names. Default `false` |
| `includeMaxDepth` | number  | no       | Cap on `@`-include hops per file. Omitted or `0` uses the engine default (5) |

```json
{
  "jsonrpc": "2.0",
  "id": 100023,
  "method": "ext/walk_context_files",
  "params": { "cwd": "/repo", "includeMaxDepth": 2 }
}
```

Response: an array of files, each `{"Path":…,"Content":…,"Source":…,"Level":…}`. `Content` has its includes expanded; `Level` is 0 for `cwd`, 1 for its parent, and so on.

### ext/set_run_recovery

Set extension-owned recovery policy for later runs in current session. This policy overrides `start_session` and `engine.json` values. `enabled` is required. `maxAttempts: 0` uses engine default. This call does not change journal for active run.

| Param         | Type    | Required | Description                                                           |
| ------------- | ------- | -------- | --------------------------------------------------------------------- |
| `enabled`     | boolean | yes      | Enable or disable durable recovery for later runs in this session.    |
| `maxAttempts` | number  | no       | Maximum durable restart attempts. `0` or omitted uses engine default. |

```json
{
  "jsonrpc": "2.0",
  "id": 100022,
  "method": "ext/set_run_recovery",
  "params": { "enabled": true, "maxAttempts": 3 }
}
```

Response: `{"jsonrpc":"2.0","id":100022,"result":{"ok":true}}`

### ext/get_plan_mode

Query the current plan-mode state for this session.

**Params:** none

```json
{ "jsonrpc": "2.0", "id": 100021, "method": "ext/get_plan_mode", "params": {} }
```

Response: `{"jsonrpc":"2.0","id":100021,"result":{"enabled":true,"planFilePath":"/Users/josh/.ion/plans/abc-123.md"}}`

`planFilePath` is non-empty whenever a plan file has been allocated for the session, even when plan mode is currently off — the path is preserved across toggles until the session resets.

### ext/intercept

Emit an `engine_intercept` event on a target session's stream. The engine stamps `interceptSource` from the calling extension's name.

```json
{
  "jsonrpc": "2.0",
  "id": 100015,
  "method": "ext/intercept",
  "params": {
    "level": "banner",
    "title": "Task complete",
    "message": "The analysis finished.",
    "targetSessionKey": "abc-123"
  }
}
```

| Param              | Type   | Required | Description                                         |
| ------------------ | ------ | -------- | --------------------------------------------------- |
| `level`            | string | yes      | `"banner"` (informational) or `"redirect"` (urgent) |
| `title`            | string | yes      | Short headline                                      |
| `message`          | string | no       | Body content                                        |
| `targetSessionKey` | string | no       | Target session; defaults to caller's session        |
| `metadata`         | object | no       | Opaque map forwarded to clients unchanged           |

Response: `{"jsonrpc":"2.0","id":100015,"result":{"ok":true}}`

### ext/run_once_check

Check whether this instance should execute a cross-instance dedup operation.

```json
{
  "jsonrpc": "2.0",
  "id": 100016,
  "method": "ext/run_once_check",
  "params": { "id": "daily-sync", "debounceMs": 60000 }
}
```

Response: `{"jsonrpc":"2.0","id":100016,"result":{"execute":true,"reason":""}}` or `{"jsonrpc":"2.0","id":100016,"result":{"execute":false,"reason":"debounced"}}`

### ext/run_once_complete

Record the outcome of a dedup operation. Call after `ext/run_once_check` returned `execute: true`.

```json
{
  "jsonrpc": "2.0",
  "id": 100017,
  "method": "ext/run_once_complete",
  "params": { "id": "daily-sync", "failed": false }
}
```

When `failed` is `true`, the lock is released without updating the last-run timestamp so the next instance retries immediately.

Response: `{"jsonrpc":"2.0","id":100017,"result":{"ok":true}}`
