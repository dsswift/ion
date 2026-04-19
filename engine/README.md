# Ion Engine

Standalone Go agent runtime. Single static binary, zero runtime dependencies. Runs as a socket daemon on Unix or named pipe on Windows. Send prompts, get structured responses, extend behavior with hooks. Works headless. No terminal UI, no interactive mode. Built for embedding into products, CI pipelines, and infrastructure.

## Install

### macOS

```bash
curl -fsSL https://github.com/dsswift/ion/releases/latest/download/ion-darwin-arm64 -o /usr/local/bin/ion
chmod +x /usr/local/bin/ion
```

### Linux

```bash
curl -fsSL https://github.com/dsswift/ion/releases/latest/download/ion-linux-amd64 -o /usr/local/bin/ion
chmod +x /usr/local/bin/ion
```

### Windows

```powershell
Invoke-WebRequest -Uri "https://github.com/dsswift/ion/releases/latest/download/ion-windows-amd64.exe" -OutFile "$env:LOCALAPPDATA\ion\ion.exe"
```

### Docker

```dockerfile
FROM scratch
COPY ion /ion
ENTRYPOINT ["/ion"]
CMD ["serve"]
```

```bash
docker run -e ANTHROPIC_API_KEY=sk-... ion-engine serve
```

### Build from source

```bash
cd engine && make build    # -> bin/ion
```

## CLI Usage

Start the daemon, then interact through commands.

```bash
# Start the daemon
ion serve

# Send a prompt (starts a session automatically)
ion prompt "What files are in the current directory?"

# Stream events from all sessions
ion attach

# List active sessions
ion status

# Stop a specific session
ion stop --key s1

# Shut down the daemon
ion shutdown

# Print version
ion version
```

### Options

| Option | Description |
|--------|-------------|
| `--model <model>` | Model override (e.g. `claude-sonnet-4-6`, `gpt-4.1`) |
| `--max-turns N` | Max LLM turns per session (default: 50) |
| `--max-budget USD` | Cost ceiling in USD |
| `--output text\|json\|stream-json` | Output format for `prompt` command |
| `--profile <name>` | Extension profile to load |
| `--dir <path>` | Working directory for the session |

### RPC Mode

For non-Go integrations, use RPC mode over stdin/stdout:

```bash
ion rpc
```

Reads NDJSON commands from stdin, writes NDJSON events to stdout. Useful for embedding in other languages without socket setup.

## Architecture

```
Client --[Unix socket, NDJSON]--> Server
  --> SessionManager --> ExtensionHost + ApiBackend
                                          |
                                    LlmProvider.Stream()
                                          |
                                    Tool execution (parallel)
```

- **Server** accepts multiple clients over `~/.ion/engine.sock` (Unix) or `\\.\pipe\ion-engine` (Windows). Broadcasts events to all connected clients.
- **SessionManager** handles session lifecycle: create, prompt, stop, fork, compact.
- **ApiBackend** runs the agent loop: send messages to the provider, parse tool calls, execute tools in parallel, feed results back.
- **LlmProvider** is the interface to LLM APIs. Raw HTTP with SSE parsing, no SDK dependencies.
- **ExtensionHost** loads extension subprocesses and dispatches hooks at each lifecycle point.

### Package Layout

| Package | Purpose |
|---------|---------|
| `cmd/ion` | CLI entry point |
| `internal/server` | Unix socket server, multi-client broadcast |
| `internal/session` | SessionManager: session lifecycle, event routing |
| `internal/backend` | RunBackend interface, ApiBackend (agent loop) |
| `internal/providers` | LlmProvider interface, 14+ provider implementations |
| `internal/tools` | Tool registry, 15 built-in tools |
| `internal/extension` | SDK (43 hooks), Host (subprocess JSON-RPC) |
| `internal/conversation` | Tree sessions, JSONL persistence, branching |
| `internal/config` | 4-layer config, enterprise MDM, merge |
| `internal/compaction` | Fact extraction, summary, cascade |
| `internal/sandbox` | OS-level process isolation, opt-in (Seatbelt, bubblewrap) |
| `internal/permissions` | Permission engine, opt-in policy evaluation, path patterns |
| `internal/context` | Context file walker, includes, presets |
| `internal/mcp` | MCP client (stdio + SSE transport) |

## Extensions

### No extension = bare engine

Without extensions, prompts go straight to the LLM. The response comes back, tool calls execute, results feed back into the next turn. That's it. No hooks fire, no behavior is modified. The engine is a clean agent loop.

### With an extension

An extension modifies the engine's behavior by hooking into lifecycle events. Extensions can rewrite prompts before they reach the LLM, block or modify tool calls before execution, transform tool output before the LLM sees it, override model selection, reject context files, register custom tools, register slash commands, and inject entries into the session.

Extensions cannot access engine internals, call the LLM directly, manage persistent state (that's their own responsibility), or override engine policy decisions (like enterprise config enforcement).

### Extension loading

The engine spawns the extension as a subprocess and communicates via JSON-RPC 2.0 over stdin/stdout. This makes extensions language-independent. Any executable that reads JSON-RPC from stdin and writes responses to stdout will work. Python, Go, Rust, JavaScript, a shell script. Doesn't matter.

```
Engine <--stdin/stdout--> Extension subprocess
         JSON-RPC 2.0
```

The engine looks for executables in the extension directory:

```
~/.ion/extensions/my-ext/
  main          # native binary (Go, Rust, etc.)
  # -- or --
  index.js      # Node.js entry point
```

Extensions can also live in project-local `.ion/extensions/` or be referenced by path in a profile config.

### Init handshake

When the engine loads an extension, it sends an `init` request. The extension responds with its name, the hooks it wants to receive, any tools it registers, and any commands it provides.

```json
--> {"jsonrpc":"2.0","id":1,"method":"init","params":{"cwd":"/home/user/project","model":"claude-sonnet-4-6"}}
<-- {"jsonrpc":"2.0","id":1,"result":{"name":"my-ext","hooks":["before_prompt","tool_call"],"tools":[{"name":"deploy","description":"Deploy to staging"}],"commands":["stats"]}}
```

### Hook dispatch

When the engine reaches a lifecycle point, it sends a hook notification to the extension. The extension can respond with modifications or pass through.

```json
--> {"jsonrpc":"2.0","id":2,"method":"hook","params":{"hook":"before_prompt","data":{"text":"deploy to prod"}}}
<-- {"jsonrpc":"2.0","id":2,"result":{"text":"deploy to staging (prod requires approval)"}}
```

Returning `null` or `{}` means "no opinion." The engine proceeds with original data.

```json
--> {"jsonrpc":"2.0","id":3,"method":"hook","params":{"hook":"tool_call","data":{"tool":"Bash","input":{"command":"rm -rf /"}}}}
<-- {"jsonrpc":"2.0","id":3,"result":{"blocked":true,"reason":"Destructive command blocked by policy"}}
```

### What extensions can do

- **Rewrite prompts:** modify user input before it reaches the LLM (`before_prompt`)
- **Block tool calls:** reject specific tool invocations (`tool_call`, per-tool hooks)
- **Modify tool calls:** change arguments before execution (`tool_call`)
- **Transform tool output:** alter results before the LLM sees them (`tool_result`)
- **Override model selection:** swap models per-turn (`model_select`)
- **Filter context:** reject or modify context files (`context_load`, `instruction_load`)
- **Register custom tools:** add tools the LLM can call (`init` response)
- **Register commands:** add slash commands for users (`init` response)
- **Inject session entries:** add messages to the conversation
- **Custom compaction:** control how old turns are summarized (`session_compact`)
- **Permission gates:** approve or deny tool execution (`permission_request`)
- **Sub-agents:** register agent handles for delegated work

### What extensions cannot do

- Access engine internals or memory directly
- Call the LLM. Only the engine talks to providers.
- Manage persistent state. Extensions handle their own storage.
- Override enterprise policy. Sealed config always wins.

### Extension examples

TypeScript:

```typescript
export default function (ion: ExtensionAPI) {
  ion.registerTool({ name: "deploy", description: "Deploy to staging" });
  ion.on("tool_call", async (event, ctx) => {
    if (event.tool === "Bash" && event.input.command.includes("rm -rf")) {
      return { blocked: true, reason: "Nope." };
    }
  });
}
```

Go:

```go
func main() {
  ext := ion.NewExtension()
  ext.RegisterTool("deploy", deployHandler)
  ext.OnHook("tool_call", func(ctx *ion.Context, data any) (any, error) {
    // inspect and modify tool calls
    return nil, nil // nil = no opinion
  })
  ext.Run() // blocks, reads JSON-RPC from stdin
}
```

### Extension hooks (43 total)

| Category | Hooks |
|----------|-------|
| **Session** | `session_start`, `session_end`, `session_before_compact`, `session_compact`, `session_before_fork`, `session_fork`, `session_before_switch` |
| **Prompt** | `before_prompt`, `input`, `before_agent_start` |
| **Turn** | `turn_start`, `turn_end`, `message_start`, `message_end`, `message_update` |
| **Tool** | `tool_start`, `tool_end`, `tool_call`, `tool_result`, `user_bash` |
| **Agent** | `agent_start`, `agent_end` |
| **Provider** | `before_provider_request`, `model_select`, `context` |
| **Error** | `on_error` |
| **Per-tool** | `{bash,read,write,edit,grep,glob,agent}_tool_{call,result}` (14 hooks) |
| **Context** | `context_discover`, `context_load`, `instruction_load` |
| **Permission** | `permission_request`, `permission_denied` |
| **File** | `file_changed` |
| **Task** | `task_created`, `task_completed` |
| **Elicitation** | `elicitation_request`, `elicitation_result` |

## Configuration

### Config file locations

| Location | Scope |
|----------|-------|
| `~/.ion/engine.json` | Global (all projects) |
| `.ion/engine.json` | Project (overrides global) |
| `~/.ion/models.json` | Provider and model configuration |
| `~/.ion/settings.json` | Extension profiles |

### 4-layer merge

Config loads with layered precedence (highest to lowest):

1. **Enterprise** (MDM/system). Sealed, lower layers cannot weaken it.
2. **Project** (`.ion/engine.json` in working directory)
3. **User global** (`~/.ion/engine.json`)
4. **Defaults**

Enterprise config paths:
- **macOS**: Managed Preferences (`com.ion.engine`)
- **Windows**: Registry (`HKLM\SOFTWARE\Policies\IonEngine`)
- **Linux**: `/etc/ion/config.json` + `/etc/ion/config.d/*.json`

## Providers

14+ providers, all implemented as raw HTTP with SSE parsing. No SDK dependencies.

**Native providers:** Anthropic, OpenAI, Google Gemini, AWS Bedrock, Azure OpenAI, Vertex AI, Azure AI Foundry.

**OpenAI-compatible factory:** Groq, Cerebras, Mistral, OpenRouter, Together, Fireworks, xAI, DeepSeek, Ollama.

Custom providers and models via `~/.ion/models.json`.

### API key environment variables

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `GOOGLE_API_KEY` | Google Gemini |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | AWS Bedrock |
| `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` | Azure OpenAI |

## Built-in Tools

| Tool | Description |
|------|-------------|
| `Read` | Read file content (offset/limit, images) |
| `Write` | Create or overwrite files |
| `Edit` | String replacement with fuzzy matching |
| `Bash` | Shell command execution (sandboxable) |
| `Grep` | Regex search (ripgrep when available) |
| `Glob` | File pattern matching (`**` support) |
| `Agent` | Spawn sub-agent processes |
| `WebFetch` | HTTP GET with SSRF guard and markdown conversion |
| `WebSearch` | Web search via configurable backend (Brave, Tavily, SearXNG) |
| `TaskCreate/List/Get/Stop` | Background task management |
| `NotebookEdit` | Jupyter notebook cell editing |
| `LSP` | Language server operations (pluggable) |

Extensions can register additional tools or replace built-ins.

## Build

```bash
make build              # -> bin/ion
make build-linux        # -> bin/ion-linux-amd64
make build-darwin       # -> bin/ion-darwin-arm64
make docker             # -> ion-engine:latest
make test               # unit tests
make test-integration   # integration tests (mock providers)
make test-e2e           # end-to-end (live API keys required)
```

## License

MIT. Copyright (c) 2025-2026 Joshua Sprague.
