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
6. Be executable (`chmod +x main`)

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

Your extension needs to handle both incoming requests (from engine) and incoming responses (to your outgoing requests) on the same stdin stream. Distinguish them by checking whether the message has a `method` field (incoming request) or not (response to your request).

## Key implementation notes

1. **Flush stdout after every write.** Buffered output will cause the engine to hang waiting for responses.
2. **Handle unknown hooks gracefully.** The engine sends all 55 hooks to subprocess extensions. Return null for hooks you don't care about.
3. **Respect the 30-second timeout.** The engine drops calls that don't respond within 30 seconds.
4. **Never write non-JSON to stdout.** Debug output goes to stderr.
5. **Parse the `_ctx` field** from hook and tool params if you need session context (cwd, model, config).
6. **Use unique IDs for outgoing requests.** Start from a high number (e.g., 100000) to avoid collisions with engine-assigned IDs.

## Compiled binary extensions

For compiled languages (Go, Rust, C, etc.), build a static binary named `main`:

```bash
# Go
go build -o main .

# Rust
cargo build --release && cp target/release/my-ext main

# C
gcc -o main extension.c
```

Place the binary in the extension directory. The engine executes it directly without any runtime dependency.
