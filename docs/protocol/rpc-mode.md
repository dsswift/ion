---
title: RPC Mode
description: Using ion rpc to bridge stdin/stdout with the engine socket.
sidebar_position: 5
---

# RPC Mode

The `ion rpc` command connects stdin and stdout to the engine's Unix socket (or TCP port on Windows), creating a bidirectional NDJSON pipe. This lets external tools interact with the engine without implementing socket logic.

## How It Works

```
External tool                    ion rpc                     Engine daemon
 (stdin) -----> read line -----> write to socket -----> process command
 (stdout) <---- write line <---- read from socket <---- broadcast event
```

1. `ion rpc` connects to the running engine daemon.
2. Lines read from stdin are forwarded to the socket.
3. Lines received from the socket are written to stdout.
4. Status messages (connection confirmation) go to stderr.
5. When stdin closes, the socket is closed and the process exits.

## Usage

Start the engine daemon first, then run `ion rpc` in a separate process:

```bash
# Terminal 1: start the daemon
ion serve

# Terminal 2: interact via RPC
ion rpc
```

Once connected, write NDJSON commands to stdin and read responses and events from stdout:

```bash
echo '{"cmd":"list_sessions","requestId":"r1"}' | ion rpc
```

For interactive use, pipe both directions:

```bash
ion rpc <<'EOF'
{"cmd":"start_session","key":"s1","config":{"profileId":"default","extensionDir":"~/.ion/extensions/my-ext","workingDirectory":"/tmp"},"requestId":"r1"}
{"cmd":"send_prompt","key":"s1","text":"Hello","requestId":"r2"}
EOF
```

## Integration Patterns

### Scripting

Combine `ion rpc` with tools like `jq` to build scripts:

```bash
#!/bin/bash
# Start a session, send a prompt, wait for task_complete

ion rpc < <(
  echo '{"cmd":"start_session","key":"s1","config":{"profileId":"default","extensionDir":"~/.ion/extensions/my-ext","workingDirectory":"."},"requestId":"r1"}'
  sleep 1
  echo '{"cmd":"send_prompt","key":"s1","text":"What is 2+2?","requestId":"r2"}'
) | while IFS= read -r line; do
  type=$(echo "$line" | jq -r '.event.type // .cmd // empty')
  if [ "$type" = "result" ] && echo "$line" | jq -e '.event.subtype == "success"' > /dev/null 2>&1; then
    echo "$line" | jq '.event.result'
    break
  fi
done
```

### Embedding in Other Tools

Any language that can spawn a subprocess and read/write its stdio can use `ion rpc`:

```python
import subprocess, json

proc = subprocess.Popen(
    ["ion", "rpc"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
)

# Send a command
cmd = {"cmd": "list_sessions", "requestId": "r1"}
proc.stdin.write(json.dumps(cmd) + "\n")
proc.stdin.flush()

# Read the response
line = proc.stdout.readline()
result = json.loads(line)
```

### Long-Running Connections

For a persistent connection that sends multiple commands over time, keep the `ion rpc` process running and write commands as needed. Events from all sessions stream continuously on stdout.

## Notes

- The engine must be running before `ion rpc` connects. If the socket does not exist, `ion rpc` exits with an error.
- All output on stdout is valid NDJSON. Diagnostic messages go to stderr.
- The RPC process exits when the engine disconnects or when stdin is closed.
- On Windows, `ion rpc` connects via TCP to `127.0.0.1:21017` instead of a Unix socket.
