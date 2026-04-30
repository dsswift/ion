# Ion Engine

A headless agent runtime. One binary. Zero opinions. Fifty-five hooks to make it yours.

`~7.8 MB static binary` · `16 LLM providers` · `59 extension hooks` · `14 built-in tools` · `MIT license`

Ion Engine is a headless, multi-provider LLM runtime for building agent systems in any domain. It runs as a single static Go binary with no runtime dependencies. Extensions speak JSON-RPC over stdin/stdout in any language. Your job is the interface, the workflow, and the domain. The engine handles the rest.

---

## The Age of Harness Engineering

The AI agent ecosystem is splitting in two. On one side, opinionated apps that decide how you work. On the other, raw APIs that leave you building the agent loop, the tool execution, the sandboxing, and the conversation management from scratch.

Ion Engine sits in between. It handles the hard parts: the agent loop, parallel tool execution, conversation persistence with branching, and multi-provider abstraction. It ships opt-in security primitives (dangerous command patterns, sensitive path protection, secret redaction, OS-level sandboxing) that you enable when you need them. But it has zero opinions about your interface, your workflow, your permission model, or your deployment target.

You get a raw agent and shape what it becomes.

## Where Ion Fits

Tools like Claude Code and Pi are excellent at what they do. If you want a polished coding assistant or a batteries-included agent toolkit, use them. They're built for that, they're well-supported, and they have strong communities.

Ion is different in kind, not in quality. It's a **foundation**: a headless runtime you build on top of, not a product you use as-is. Think of it as the engine block, not the car.

**What Ion gives you:**

- **A domain-agnostic runtime.** No coding-tool assumptions. Build agent systems for warehouse ops, research pipelines, farm management, incident response, or your own coding assistant.
- **Any-language extensions.** Extensions communicate via JSON-RPC over stdin/stdout. Write them in Go, Python, Rust, TypeScript, or a shell script. If your language can read stdin and write stdout, it's an extension language.
- **Daemon architecture with multi-client broadcast.** Multiple clients connect to the same engine simultaneously. Build a CLI, a desktop app, and a web interface that all share one running daemon.
- **Native parallel sub-agents.** Spawn child agents with different models that run their own tool loops concurrently. A parent on Opus coordinates researchers on Sonnet and formatters on Haiku.
- **Built-in security primitives.** OS-level sandboxing (Seatbelt on macOS, bwrap on Linux), secret redaction, dangerous command blocking, and a permission engine with LLM-based classification.
- **Enterprise policy enforcement.** 4-layer config merge (defaults, user, project, enterprise) where the enterprise layer is sealed. Security sets the floor; developers customize above it.
- **Zero vendor SDK dependencies.** 16 LLM providers via raw HTTP with manual SSE parsing. No transitive dependency chain you don't control. Fork the binary, keep your agents.
- **MCP support.** Dual-transport MCP client (stdio for local servers, SSE for remote) with resource reading exposed as first-class tools.
- **Credential management.** Five-level resolver: programmatic override, environment variables, OS keychain, encrypted file store, and CLI proxy for TOS-compliant subscription access via Claude Code.
- **55 extension hooks** across 15 categories. Intercept and modify behavior at every stage of the agent loop.

You want to build your own coding agent? Use this engine and wrap your own opinions around it. You want non-coding agent orchestrations? Build harnesses that coordinate domain-specific agents. You want to embed an agent runtime in a container sidecar, a CI pipeline, or a web API? It's a single static Go binary with no runtime dependencies.

Ion is a starting point. The runtime handles the hard parts and stays out of the way on everything else.

## Quick Start

```bash
# Install (macOS)
curl -fsSL https://github.com/dsswift/ion/releases/latest/download/ion-darwin-arm64 \
  -o /usr/local/bin/ion && chmod +x /usr/local/bin/ion
```

Ion ships with no default model. That is a deliberate choice. You bring the opinions, including which model runs your agents. Drop a config at `~/.ion/engine.json` before your first prompt:

```json
{
  "defaultModel": "qwen2.5:14b",
  "providers": {
    "ollama": {}
  }
}
```

The example above runs `qwen2.5:14b` locally on Ollama with no API key required. Other supported models work the same way: `gpt-4o` for OpenAI, `claude-sonnet-4-6` for Anthropic, `mistral-large-latest` for Mistral. Set `defaultModel` to whichever model you want and configure its provider block. See the [Model and Provider Configuration](#model-and-provider-configuration) section below or the [Provider Setup](docs/providers/index.md) docs for the full catalog.

For hosted providers, export the matching credential before running:

```bash
export OPENAI_API_KEY="sk-..."
# or ANTHROPIC_API_KEY, GOOGLE_API_KEY, MISTRAL_API_KEY, etc.
```

Now run your first prompt:

```bash
ion prompt "What files are in the current directory?"
```

One command. The engine starts in-process, calls the LLM, executes tools, streams the result to stdout, and exits. No daemon, no socket, no background process.

One-shot mode works well for scripted workflows: shell scripts, cron jobs, git hooks, CI pipelines, orchestration scripts. Each invocation is self-contained.

```bash
# One-shot with JSON output
ion prompt --output json "Summarize the last 5 commits" | jq -r '.result'

# One-shot with streaming NDJSON (for piping to other tools)
ion prompt --output stream-json "Review this diff for security issues"

# Skip configured extensions for this run
ion prompt --no-extensions "What time is it in UTC?"

# Clear configured extensions, load only this one
ion prompt --no-extensions --extension ./my-reviewer/index.js "Review the staged changes"
```

### Daemon mode

When you need persistent sessions, multiple clients, or real-time event streaming, run the engine as a daemon.

```bash
# Start the daemon
ion serve
# Ion Engine v1.0.0 started (pid 42871)
# Socket: /Users/you/.ion/engine.sock

# Start a session with a working directory and extensions
ion start --key myproject --dir /path/to/project \
  --extension ~/.ion/extensions/my-harness.js

# Send a prompt (routed to the session by key)
ion prompt --key myproject "What files are in the current directory?"
# Prompt sent. Use `ion attach` to stream output.

# Stream events (NDJSON lines flow as the agent works)
ion attach
# {"type":"text_chunk","text":"I can see the following files..."}
# {"type":"tool_call","toolName":"Bash","toolId":"tool_1","index":0}
# {"type":"tool_result","toolId":"tool_1","output":"README.md\nsrc/\ntests/\n"}
# {"type":"text_chunk","text":"The directory contains a README..."}
# {"type":"task_complete","result":"...","costUsd":0.003,"numTurns":1}

# Send a follow-up (the session remembers context)
ion prompt --key myproject "Which of those files changed in the last week?"

# Send another (still the same conversation)
ion prompt --key myproject "Show me the diff for the most recent change"

# Start a second session with different extensions
ion start --key infra --dir /path/to/infra-repo \
  --extension ~/.ion/extensions/terraform-tools.js

# Both sessions run in parallel, each with their own extensions
ion prompt --key infra "Plan the changes in modules/networking"

# Check what sessions are running
ion status
# KEY              DIRECTORY                STATE
# -------------------------------------------------------
# myproject        /path/to/project         active
# infra            /path/to/infra-repo      active

# Filter attach to one session
ion attach --key myproject

# Stop a session when done
ion stop --key myproject

# Shut down the daemon
ion shutdown
```

Why daemon mode:

- **Persistent sessions.** Conversation history survives across prompts. Ask a follow-up without re-sending context. Branch a conversation to explore alternatives. The engine manages session state, compaction, and JSONL persistence automatically.
- **Multiple clients.** Any number of clients connect to the same daemon simultaneously. Every client receives broadcast events. One engine serves all your interfaces.
- **Warm extensions.** Extension subprocesses stay alive between prompts. No spawn/init overhead on each invocation. Custom tools, hooks, and agents are ready instantly.
- **Real-time streaming.** Connect with `ion attach` and watch events flow as the agent works. Pipe NDJSON into `jq`, a monitoring dashboard, or an approval workflow. Build integrations that react to tool calls, text output, and errors in real time.
- **Session management.** Run multiple sessions in parallel, each with its own model, extensions, and working directory. Route prompts to the right session by key. One daemon, many workstreams.

One-shot mode runs a fresh engine per invocation. Daemon mode runs one engine that serves everything. Use one-shot for scripts and automation. Use daemon mode for applications and interactive workflows. Both load the same config, run the extensions you specify (passed with `--extension` or listed in `~/.ion/settings.json` profiles), and run the same agent loop.

See the [engine docs](engine/README.md) for Linux, Windows, and Docker install instructions.

## Documentation

Full technical documentation lives in [`docs/`](docs/index.md). Start here based on what you're building:

| Audience | Start with |
|----------|-----------|
| **Harness engineer** building extensions | [Quick Start](docs/getting-started/quickstart.md), [Extension Guide](docs/extensions/getting-started.md), [Hooks Reference](docs/hooks/reference.md) |
| **IT admin** deploying Ion | [Configuration](docs/configuration/index.md), [Security](docs/security/index.md), [Enterprise](docs/enterprise/index.md) |
| **Contributor** working on the engine | [Architecture](docs/architecture/engine.md), [Contributing](docs/contributing/index.md) |

Key references: [Socket Protocol](docs/protocol/index.md) | [CLI Reference](docs/cli/reference.md) | [Tools Reference](docs/tools/reference.md) | [Provider Setup](docs/providers/index.md) | [MCP Integration](docs/mcp/index.md)

## Model and Provider Configuration

Ion supports 16 providers and lets you plug in your own through a common interface. The engine picks a provider in this order: a registered model in `~/.ion/models.json`, then a built-in name-prefix match (`claude-*`, `gpt-*`, `qwen*`, `llama*`, `gemini-*`, `mistral*`, `grok*`, `deepseek-*`, and so on), then a hard error if neither matches.

Set the model you want in `~/.ion/engine.json` and configure its provider block:

```json
{
  "defaultModel": "qwen2.5:14b",
  "providers": {
    "ollama": {},
    "openai": { "apiKey": "CUSTOM_OPEN_API_KEY_VAR" },
    "anthropic": { "apiKey": "sk-ant-..." }
  }
}
```

> **How `apiKey` is resolved.** The `apiKey` field accepts three forms:
>
> 1. **Omitted** — the engine auto-resolves the key from provider's default environment variables (e.g. `OPENAI_API_KEY`), the system keychain, or its encrypted file store.
> 2. **An environment variable name** (all-caps, digits, and underscores, e.g. `"OPENAI_API_KEY"`) — expanded from the environment at startup.
> 3. **A literal key** (e.g. `"sk-proj-..."`) — used directly as-is.
>
> The examples above use both form 1 and form 2: the value `"CUSTOM_OPEN_API_KEY_VAR"` is not a literal api key — it tells the engine to read the corresponding environment variable.

Need a custom name (a finetune, an OpenRouter route, a tier alias)? Register it under `~/.ion/models.json`:

```json
{
  "tiers": {
    "fast": "qwen2.5:7b",
    "smart": "claude-sonnet-4-6"
  },
  "providers": {
    "ollama": {
      "models": {
        "myteam/qwen-finetune:latest": { "contextWindow": 32768 }
      }
    }
  }
}
```

Need to mix cloud and local models in one workflow? See the [Workflows: Model Routing](#workflows-model-routing) example below.

For the full picture, see the [models.json reference](docs/configuration/models.md), the [engine.json reference](docs/configuration/engine-json.md), and the [provider catalog](docs/providers/index.md).

## One Engine, Many Shapes

Ion Engine is a raw agent. On its own, it takes a prompt, talks to an LLM, executes tools, and streams results back. That's it. No opinions. No workflow. No interface. No system prompt. The engine ships with no guiding instructions. Every behavior is something you bring.

What matters is what you build around it.

### A shell script

The simplest harness is a few lines of bash. Send a prompt, get a result. Embed an AI agent in a cron job, a git hook, or a CI pipeline with nothing more than a shell script.

```bash
#!/bin/bash
ion prompt --output json "Review the diff and flag any security concerns" \
  | jq -r '.result' \
  >> review-output.md
```

### A full application

Any socket client can be a full application. Your UI connects to the engine's Unix socket, sends JSON commands, and renders streamed events. The engine runs every session. Your app is purely an interface.

```
Your App ──[Unix socket]──> Ion Engine
```

The wiring is a thin socket client. Connect, write JSON lines, parse events:

```typescript
// Example socket client (simplified)
import { createConnection } from 'net'
import { join } from 'path'
import { homedir } from 'os'

const SOCKET = join(homedir(), '.ion', 'engine.sock')
const conn = createConnection(SOCKET)

// Send commands as NDJSON
conn.write(JSON.stringify({ cmd: 'start_session', key: 's1', config: { model: 'qwen2.5:14b' } }) + '\n')
conn.write(JSON.stringify({ cmd: 'prompt', key: 's1', text: 'What files are here?' }) + '\n')

// Receive events as NDJSON
let buffer = ''
conn.on('data', (chunk) => {
  buffer += chunk.toString()
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const event = JSON.parse(buffer.slice(0, nl))
    buffer = buffer.slice(nl + 1)
    // Render event.type: 'text', 'tool_use', 'tool_result', 'exit', ...
  }
})
```

The client never calls an LLM or executes a tool. It sends commands to the engine, and the engine handles the rest.

Notice the `key` field in every command. That's session routing. Every session gets a unique key, and any client can send prompts or filter events by key. A tabbed desktop app uses keys for tabs. A container singleton launched by a KEDA scaler uses keys to multiplex queue events. A CI pipeline uses keys to run parallel review sessions. One daemon, many independent sessions, any number of clients.

### A workflow orchestration

An extension can register multiple agents, each with its own model, tools, and system prompt. A single prompt to a well-built harness can trigger an entire workflow: the LLM delegates to specialized agents, they run their tool loops in parallel, and the results flow back to the parent session.

```bash
#!/bin/bash
# Full QA pipeline in two harness invocations

# Step 1: QA harness -- one extension with review, test, and report agents
# The LLM orchestrates internally: reviews the diff, generates tests,
# runs them, and produces a structured report. One prompt, multiple agents.
report=$(ion prompt --output json --extension ./extensions/qa-harness.js \
  "Review the staged diff for security and style issues. Generate tests \
   for anything flagged. Run the tests. Produce a structured QA report \
   with pass/fail status, issue severity, and coverage metrics.")

# Step 2: Publication harness -- different extension, different agents
# This harness has agents for formatting, email drafting, and Slack posting.
# It picks up where the QA harness left off.
echo "$report" | jq -r '.result' | \
  ion prompt --extension ./extensions/publish-harness.js \
  "Format this QA report for stakeholders. Post a summary to #engineering \
   in Slack. Email the full report to the team leads."
```

The QA harness extension registers a code-reviewer agent, a test-writer agent, and a report-generator agent. It also registers tools: `lint`, `run_tests`, `coverage`. When the LLM receives the prompt, it delegates to each agent as needed. The agents run their own tool loops, call the extension's custom tools, and report back. The harness handles the entire review-test-report workflow internally.

The publication harness is a completely different extension with its own agents (formatter, email-drafter, slack-poster) and tools (`send_email`, `post_slack`, `render_pdf`). It knows nothing about code review. It takes structured input and distributes it.

Two invocations, two harnesses. Each one is a self-contained multi-agent system with its own tools, hooks, and orchestration logic. The shell script sequences them and the engine runs each one.

You could also run a single agent per invocation for simple tasks. But the engine supports sub-agents, parallel tool execution, and extension-registered tools specifically so you can build harnesses that do real work in a single prompt, not just wrap one LLM call.

Because the engine communicates over NDJSON on sockets or stdin/stdout, orchestration is language-agnostic. Write the coordinator in Python, Go, bash, or whatever your infrastructure already speaks.

### Workflows: model routing

Pick the right model for each step instead of paying flagship rates for tasks a small local model can finish in a second. The `--model` flag overrides config per invocation, so a single shell pipeline can mix local and hosted models freely.

```bash
#!/bin/bash
# Three-step pipeline that mixes local and hosted models per step.

# Step 1: classify intent on a small local model. Fast, cheap, no API calls.
intent=$(ion prompt --output json --model qwen2.5:14b \
  "Classify the topic of this message in one word: '$1'" | jq -r '.result')

# Step 2: deep reasoning on a hosted model that handles structured tasks well.
analysis=$(ion prompt --output json --model gpt-4o \
  "The intent is '$intent'. Plan a response that addresses it." | jq -r '.result')

# Step 3: long-form writeup on a long-context model.
ion prompt --model claude-sonnet-4-6 \
  "Using this plan, write the final response. Plan: $analysis"
```

Three models, three providers, one shell script. The engine resolves each model via prefix match (`qwen*` to Ollama, `gpt-*` to OpenAI, `claude-*` to Anthropic), pulls the matching credential from the environment or config, and runs each step in turn. See the [models.json reference](docs/configuration/models.md) for tier aliases that let you write `--model fast` instead of pinning a specific model name.

### A web API with an engine sidecar

Run the engine as a sidecar process behind a web server. The API handles auth and routing. The engine handles the agent loop.

```python
# Flask API with Ion Engine sidecar
from flask import Flask, request, jsonify
import subprocess, json

app = Flask(__name__)

@app.route('/chat', methods=['POST'])
def chat():
    prompt = request.json['message']
    result = subprocess.run(
        ['ion', 'prompt', '--output', 'json', prompt],
        capture_output=True, text=True
    )
    return jsonify(json.loads(result.stdout))
```

For streaming, connect to the socket directly and forward NDJSON events over SSE or WebSocket.

### Deployment in containers

Package any of the above patterns into a container and run them wherever containers run.

```dockerfile
FROM alpine:3.20
COPY ion /usr/local/bin/ion
COPY orchestrate.sh /app/orchestrate.sh
COPY extensions/ /app/extensions/
ENTRYPOINT ["/app/orchestrate.sh"]
```

```bash
# Single agent container, pointed at a local Ollama daemon on the host
docker run --network host ion-engine prompt "Analyze this codebase"

# Orchestration script inside a container, using whichever provider you set up
docker run -e $YOUR_PROVIDER_API_KEY ion-orchestrator

# Multiple specialized containers
docker compose up reviewer test-writer deployer
```

## Sub-Agents

A session can spawn child agents that run their own tool loops in parallel, report back, and disappear. Two ways to define them, but in both cases: **the harness decides which agents load.** The engine provides the discovery API and the spawning infrastructure. It never auto-loads agents on its own.

### Inline agents (via extensions)

Register agents in your extension's `init` response. They live in code, ship with the extension, and work anywhere the extension loads.

```javascript
// Inside your extension's init handler
reply(msg.id, {
  name: 'db-explorer',
  agents: [
    { name: 'analyst', description: 'Write and run SQL queries to answer data questions', model: 'gpt-4o' },
    { name: 'summarizer', description: 'Summarize query results into plain language', model: 'qwen2.5:14b' }
  ]
})
```

Good for agents tightly coupled to extension logic. But when agents need long system prompts, specialized tool sets, or per-project customization, files on disk are better.

### Agents from disk

Agent definitions are markdown files with YAML frontmatter. The engine provides a discovery API (`agentdiscovery.Discover()`) that walks directories, parses these files, and builds a dependency graph. But discovery is a library call, not an automatic behavior. An extension or harness must call it, decide which agents to accept, and register them with the session.

```markdown
# ~/.ion/agents/code-reviewer.md

---
name: code-reviewer
description: Review code changes for correctness, style, and security
model: qwen2.5:14b
tools: [Read, Grep, Glob, Bash]
---

You are a senior code reviewer. Focus on:
- Logic errors and edge cases
- Security vulnerabilities (injection, auth bypass, data exposure)
- Style consistency with the surrounding codebase
- Performance: flag O(n²) or worse when linear alternatives exist

Read the diff, read the surrounding code for context, then deliver
a structured review. Be direct. Skip praise for things that are simply correct.
```

The frontmatter declares capabilities and the body becomes the system prompt. Once a harness loads and registers this agent, the LLM can delegate to it by name. It runs its own tool loop with only the tools listed.

**Supported fields:**

| Field | Purpose |
|-------|---------|
| `name` | Agent identifier (defaults to filename if omitted) |
| `description` | What the LLM sees when deciding whether to delegate |
| `model` | LLM model override (smaller model = faster + cheaper) |
| `tools` | Which tools this agent can use |
| `parent` | Parent agent name for building hierarchies |

Any extra fields land in a `Meta` map your harness can read for custom routing, tagging, or policy decisions.

### Layered discovery

The engine's discovery API scans directories in order when called. Project wins.

```go
// Harness calls this -- engine does not call it automatically
graph, err := agentdiscovery.Discover(agentdiscovery.WalkOptions{
    IncludeProjectDir: true,   // .ion/agents/ relative to working directory
    IncludeUserDir:    true,   // ~/.ion/agents/
    ExtraDirs:         []string{"/opt/company/agents"},  // explicit paths
    Recursive:         true,
})
```

```
.ion/agents/          ← project-local (this repo only)
~/.ion/agents/        ← user-global (your harness ships these)
[extra dirs]          ← explicit paths from WalkOptions
```

When two files share the same name, the first directory wins. A project agent overrides a harness agent with the same filename. This is the layering mechanism.

The harness controls everything: which directories to scan, which agents from the graph to register, and how to route delegation. You could have fifty agent files in a project and five different harnesses that each load a different subset. A sixth harness could ignore disk agents entirely and register its own inline. A seventh could run with no agents at all. Same engine, same project, different behavior depending on which harness runs.

```
Discover(opts) -> AgentGraph -> harness filters -> RegisterAgent() for accepted agents
```

**What this means in practice:**

A game studio ships a development harness. It installs standard agents to `~/.ion/agents/`:

```
~/.ion/agents/
├── code-reviewer.md      # Reviews diffs for correctness and security
├── test-writer.md        # Generates tests from implementation code
├── security-scanner.md   # Audits dependencies and code patterns
└── doc-writer.md         # Writes documentation from code and comments
```

Every developer on the team gets these agents in every project, automatically. No per-repo setup.

Now a game engine repository adds project-local agents:

```
game-engine/.ion/agents/
├── shader-analyst.md         # Analyze GLSL/HLSL for GPU performance
├── ecs-optimizer.md          # Review entity-component-system patterns
└── code-reviewer.md          # Override: game-specific review criteria
```

When a developer runs the harness from inside `game-engine/`, they get six agents: the three project-local ones plus `test-writer`, `security-scanner`, and `doc-writer` from the global layer. The project's `code-reviewer.md` overrides the global version because project wins by filename.

Different repo, different agents. Same harness. Same binary.

A research lab uses the same layering for a completely different domain. The lab manager installs shared agents:

```
~/.ion/agents/
├── literature-search.md      # Search and summarize published papers
├── data-analyst.md           # Statistical analysis on lab results
└── report-writer.md          # Format findings into publication drafts
```

Each project adds specialists:

```
materials-lab/.ion/agents/
├── experiment-planner.md     # Design experiments from hypotheses
├── spectroscopy-reader.md    # Parse and interpret XRD/SEM output
└── report-writer.md          # Override: materials science formatting
```

Same mechanism, nothing to do with code. The researcher runs the harness from inside `materials-lab/`, gets the project specialists plus `literature-search` and `data-analyst` from the global layer, and the project's `report-writer.md` overrides the global one.

### Agent hierarchies

Agents can declare a parent. The engine builds a directed graph and catches cycles at discovery time.

```markdown
# .ion/agents/lead.md
---
name: lead
description: Coordinate sub-agents for complex tasks
model: gpt-4o
---

# .ion/agents/researcher.md
---
name: researcher
parent: lead
description: Deep research and analysis
model: claude-sonnet-4-6
tools: [Read, Grep, Glob, WebSearch, WebFetch]
---

# .ion/agents/implementer.md
---
name: implementer
parent: lead
description: Write code based on research findings
model: qwen2.5:14b
tools: [Read, Write, Edit, Bash, Grep, Glob]
---
```

Once the harness registers these agents, the lead can delegate to the researcher and implementer. They run in parallel, each with their own tool loop and model. If an agent references a parent that doesn't exist, `BuildGraph()` logs a warning and promotes it to a root agent. If agents form a cycle, discovery returns an error. No silent loops.

### Everything composes

Sub-agents combine with everything else in the engine.

**Agents + Extensions + Hooks:**

Your extension registers custom tools (deploy, query database, send notifications). Agents loaded from disk inherit access to those tools. A `tool_call` hook enforces policy across all of them. The code-reviewer agent can call `Bash` to run linters. The cost-analyzer agent can call your custom `cloud_billing` tool. The hook blocks any agent from running `rm -rf`. One policy, applied everywhere.

**Agents + Model routing:**

The lead agent runs on a strong reasoner. Researchers run on a long-context model. Formatters and classifiers run on a small fast model. Local or hosted, your choice. Each agent file declares its model. A `model_select` hook can override any of them based on cost budgets or time-of-day routing. Your harness controls the spend without touching the agent definitions.

**Agents + Sealed enterprise config:**

Your security team seals the permission policy at the enterprise layer. All agents run inside those guardrails regardless of where they were loaded from. Teams customize agents freely, but the security floor holds.

### Build any harness

The combination of a raw engine, layered agent discovery, extensions, and hooks means you can build a harness for anything. Not just code.

A **warehouse operations** harness with agents that monitor inventory levels, generate reorder recommendations, and draft supplier communications. Extensions connect to your WMS and ERP. Hooks enforce approval workflows before any purchase order goes out.

A **research lab** harness with agents that search literature databases, summarize papers, cross-reference findings, and draft grant proposals. Project-local agents specialize by research domain. The biology lab and the materials science lab run the same harness with different agent sets.

A **farm management** harness with agents that analyze soil sensor data, plan crop rotations, track equipment maintenance schedules, and generate compliance reports. Extensions integrate with IoT platforms and weather APIs.

A **department operations** harness with agents that triage inbound requests, draft internal communications, track project timelines, and prepare budget summaries. Different departments layer their own agents on top.

The engine handles the agent loop, tool execution, streaming, and multi-provider abstraction. Your harness owns the domain, your agents own the expertise, your extensions own the integrations, and your hooks own the policy.

For tier aliases like `fast` or `smart` that resolve per-agent, see the [models.json reference](docs/configuration/models.md).

### Fork it

MIT license. No cloud dependency. No accounts. No telemetry. No call-home.

The engine is a single static binary with zero runtime dependencies. Every LLM provider is implemented as raw HTTP. No vendor SDK means no transitive dependency chain you don't control.

If you build a harness on Ion Engine and decide tomorrow that you need to go a different direction, fork it. The entire runtime is yours. Your agents are markdown files you already own. Your extensions are standalone processes you already wrote. Nothing is locked inside a platform you can't reach.

Build on it, customize it, ship it to your team or your customers.

## Talk to Any Model

Sixteen providers, zero SDKs. Every provider is raw HTTP with SSE parsing. No transitive dependencies, no version conflicts, no vendor lock-in.

**Native:** Anthropic, OpenAI, Google Gemini, AWS Bedrock, Azure OpenAI, Vertex AI, Azure AI Foundry

**OpenAI-compatible:** Groq, Cerebras, Mistral, OpenRouter, Together, Fireworks, xAI, DeepSeek, Ollama

Point it at your own endpoint, swap models mid-session, or route traffic through your AI gateway.

The provider interface is pluggable. Implement two methods (`ID()` and `Stream()`) and register your own provider for any LLM endpoint the built-in ones don't cover.

## Extend Everything

Extensions are where you make the engine yours. An extension is a subprocess that communicates with the engine over JSON-RPC on stdin/stdout. Write one in any language. The engine spawns it, dispatches lifecycle hooks, and listens for instructions. If it reads JSON and writes JSON, it's an extension.

### Your first extension in 5 minutes

**1. Create the extension:**

```bash
mkdir -p ~/.ion/extensions
```

**2. Write the extension:**

This extension connects the agent to your database. It can explore schemas, run queries, and answer questions about your data. A `tool_call` hook blocks any query that would modify data.

```typescript
// db-explorer.ts
import { createIon } from 'ion-sdk'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const ion = createIon()

// Block any query that could modify data
ion.on('tool_call', (ctx, payload) => {
  if (payload.tool === 'query') {
    const sql = (payload.input?.sql || '').toUpperCase()
    if (/\b(DROP|DELETE|TRUNCATE|ALTER|INSERT|UPDATE)\b/.test(sql))
      return { block: true, reason: 'Read-only access. Destructive queries are blocked.' }
  }
})

ion.registerTool({
  name: 'query',
  description: 'Run a read-only SQL query and return the results',
  parameters: { type: 'object', properties: {
    sql: { type: 'string', description: 'SQL query to execute' }
  }, required: ['sql'] },
  execute: async (params) => {
    const result = await pool.query(params.sql)
    return { content: JSON.stringify(result.rows, null, 2) }
  },
})

ion.registerTool({
  name: 'schema',
  description: 'List tables or describe a specific table schema',
  parameters: { type: 'object', properties: {
    table: { type: 'string', description: 'Table name (omit to list all tables)' }
  }},
  execute: async (params) => {
    const sql = params.table
      ? `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${params.table}' ORDER BY ordinal_position`
      : `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    const result = await pool.query(sql)
    return { content: JSON.stringify(result.rows, null, 2) }
  },
})
```

Two tools and one hook. The agent can explore your schema, write queries to answer questions, and dig into the results. The hook ensures it stays read-only. The SDK handles the rest.

**3. Use it:**

```bash
ion prompt --extension ~/.ion/extensions/db-explorer.ts \
  "What are the top 10 customers by revenue this quarter? Break it down by region."
```

The agent calls `schema` to understand your tables, writes SQL to answer the question, runs it via `query`, interprets the results, and explains what it found. You get analysis from someone who can read your actual data, not a generic chatbot working from a description of it.

**4. Chain it into a pipeline:**

```bash
#!/bin/bash
# daily-report.sh -- automated data analysis pipeline

# Step 1: Analyze the data
analysis=$(ion prompt --output json --extension ~/.ion/extensions/db-explorer.ts \
  "Query revenue by region for the current quarter. Identify any regions \
   that dropped more than 10% compared to last quarter. Output a JSON \
   summary with region, current, previous, and percent_change fields.")

# Step 2: Decide whether to escalate
echo "$analysis" | jq -r '.result' | \
  ion prompt --extension ~/.ion/extensions/notify.ts \
  "If any region dropped more than 20%, send an alert to the webhook \
   with the details. Otherwise, send a routine summary."
```

The script sequences two extensions. The db-explorer queries and analyzes; the notifier decides whether to escalate or summarize. Each invocation is self-contained.

### Where extensions live

Extensions are loaded explicitly by file path. Pass `--extension` on the CLI or list them in your `engine.json` config. The engine does not auto-discover extensions. You decide what loads and when.

```bash
# Single extension
ion prompt --extension ~/.ion/extensions/db-explorer.ts "Show me the schema"

# Multiple extensions (repeat the flag)
ion prompt \
  --extension ~/.ion/extensions/guardrails.ts \
  --extension ~/.ion/extensions/db-explorer.ts \
  "What are our top customers?"
```

Or in config:

```json
{
  "extensions": [
    "~/.ion/extensions/guardrails.ts",
    "~/.ion/extensions/db-explorer.ts"
  ]
}
```

All your extensions can live in a single directory as named files:

```
~/.ion/extensions/
├── guardrails.ts       # org-wide safety policy
├── db-explorer.ts      # database query tools
├── notify.ts           # webhook notifications
└── audit-trail         # compiled Go binary
```

Supported file types: `.js` (Node.js), `.ts` (auto-transpiled via esbuild), or a compiled binary (no extension).

### Stacking extensions

Extensions compose. Load a shared guardrails extension alongside a domain-specific one, and hooks from both fire in order. A guardrails extension that blocks destructive commands works across every domain extension without duplicating hook logic.

```bash
# Org-wide guardrails + database tools
ion prompt \
  --extension ~/.ion/extensions/guardrails.ts \
  --extension ~/.ion/extensions/db-explorer.ts \
  "Show me all users created in the last 24 hours"
```

The guardrails extension blocks destructive commands and enforces approval workflows. The db-explorer registers query and schema tools. Both load into the same session. Hooks fire in the order extensions were loaded: guardrails first, then db-explorer. If guardrails blocks a tool call, db-explorer never sees it.

Ship your guardrails extension into containers alongside domain extensions. Configure it in your base `engine.json` so it always loads. Teams add their own extensions on top without worrying about safety policy.

### The protocol

The only requirement is JSON-RPC 2.0 over stdin/stdout:

```
Engine                              Extension
  │                                    │
  │──── init ─────────────────────────>│  "what hooks and tools do you have?"
  │<─── result ────────────────────────│  hooks: [tool_call], tools: [query, schema]
  │                                    │
  │──── tool: query ──────────────────>│  LLM called your custom tool
  │<─── result ────────────────────────│  { output: "[{\"region\": \"west\", \"revenue\": 142000}, ...]" }
  │                                    │
  │──── hook: tool_call ──────────────>│  LLM wants to run "DROP TABLE users"
  │<─── result ────────────────────────│  { blocked: true, reason: "Read-only access." }
  │                                    │
```

Every message is a JSON-RPC 2.0 line on stdin/stdout. Return `{}` or `null` from any hook to express no opinion. The engine proceeds with the original data.

You can also write extensions against this protocol directly in any language, without the SDK. If your language reads stdin and writes stdout, it can be an extension. The SDK examples above and below use TypeScript and Go, but raw JSON-RPC works in Python, Rust, a shell script, or anything else.

Here's a second extension in both TypeScript and Go: a webhook notifier that pings Slack, Discord, or any webhook URL when agents finish work or hit errors.

**TypeScript SDK:**

```typescript
// notify.ts
import { createIon } from 'ion-sdk'
import https from 'https'

const WEBHOOK = process.env.ION_WEBHOOK_URL || ''
const ion = createIon()
let totalCost = 0

function ping(text: string) {
  if (!WEBHOOK) return
  const body = JSON.stringify({ text })
  const url = new URL(WEBHOOK)
  const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  req.end(body)
}

ion.on('turn_end', (ctx, payload) => {
  totalCost += payload?.costUsd || 0
  if (totalCost > 5.0) ping(`Cost alert: session has spent $${totalCost.toFixed(2)}`)
})

ion.on('on_error', (ctx, payload) => {
  ping(`Agent error: ${payload?.message || 'unknown'}`)
})

ion.on('agent_end', (ctx, payload) => {
  ping(`Agent finished: ${payload?.name || 'main'} ($${totalCost.toFixed(2)} total)`)
})
```

**Same extension in Go:**

```go
// go build -o ~/.ion/extensions/notify
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"
    "os"

    "github.com/dsswift/ion/extension"
)

var webhook = os.Getenv("ION_WEBHOOK_URL")
var totalCost float64

func ping(text string) {
    if webhook == "" { return }
    body, _ := json.Marshal(map[string]string{"text": text})
    http.Post(webhook, "application/json", bytes.NewReader(body))
}

func main() {
    ext := extension.New("notify")

    ext.OnHook("turn_end", func(ctx *extension.Context, data any) (any, error) {
        if m, ok := data.(map[string]any); ok {
            if cost, ok := m["costUsd"].(float64); ok { totalCost += cost }
            if totalCost > 5.0 { ping(fmt.Sprintf("Cost alert: session has spent $%.2f", totalCost)) }
        }
        return nil, nil
    })

    ext.OnHook("on_error", func(ctx *extension.Context, data any) (any, error) {
        if m, ok := data.(map[string]any); ok {
            ping(fmt.Sprintf("Agent error: %v", m["message"]))
        }
        return nil, nil
    })

    ext.OnHook("agent_end", func(ctx *extension.Context, data any) (any, error) {
        if m, ok := data.(map[string]any); ok {
            ping(fmt.Sprintf("Agent finished: %v ($%.2f total)", m["name"], totalCost))
        }
        return nil, nil
    })

    ext.Run()
}
```

Both do the same thing. Set `ION_WEBHOOK_URL` and every session sends live updates to your channel. The TypeScript version auto-transpiles when loaded; the Go version compiles to a static binary.

### What extensions can do

| Capability | Hook | Example |
|-----------|------|---------|
| Rewrite prompts | `before_prompt` | Inject system instructions, redact PII, add context |
| Block tool calls | `tool_call` | Policy enforcement, safety gates, approval workflows |
| Modify tool arguments | `tool_call` | Rewrite file paths, add flags, inject environment |
| Transform tool output | `tool_result` | Redact secrets, format results, add metadata |
| Override model selection | `model_select` | Cost routing, capability matching, A/B testing |
| Filter context files | `context_load` | Block sensitive files, inject synthetic context |
| Register custom tools | `init` response | Deploy, database query, API calls, anything |
| Register slash commands | `init` response | `/deploy`, `/status`, `/cost` |
| Gate permissions | `permission_request` | Custom approval workflows, audit logging |

### What extensions cannot do

- Access engine internals or memory directly
- Call the LLM. Only the engine talks to providers.
- Manage persistent state. Extensions handle their own storage.
- Override enterprise policy. Sealed config always wins.

### 55 hooks

| Category | Hooks |
|----------|-------|
| **Lifecycle** (13) | `session_start`, `session_end`, `before_prompt`, `turn_start`, `turn_end`, `message_start`, `message_end`, `tool_start`, `tool_end`, `tool_call`, `on_error`, `agent_start`, `agent_end` |
| **Session** (5) | `session_before_compact`, `session_compact`, `session_before_fork`, `session_fork`, `session_before_switch` |
| **Pre-action** (2) | `before_agent_start`, `before_provider_request` |
| **Content** (7) | `context`, `message_update`, `tool_result`, `input`, `model_select`, `user_bash`, `plan_mode_prompt` |
| **Per-tool call** (7) | `bash_tool_call`, `read_tool_call`, `write_tool_call`, `edit_tool_call`, `grep_tool_call`, `glob_tool_call`, `agent_tool_call` |
| **Per-tool result** (7) | `bash_tool_result`, `read_tool_result`, `write_tool_result`, `edit_tool_result`, `grep_tool_result`, `glob_tool_result`, `agent_tool_result` |
| **Context** (3) | `context_discover`, `context_load`, `instruction_load` |
| **Permission** (2) | `permission_request`, `permission_denied` |
| **File** (1) | `file_changed` |
| **Task** (2) | `task_created`, `task_completed` |
| **Elicitation** (2) | `elicitation_request`, `elicitation_result` |
| **Context injection** (1) | `context_inject` |
| **Capability** (3) | `capability_discover`, `capability_match`, `capability_invoke` |

See the full [extension reference](docs/extensions/index.md) for init handshake format, hook data shapes, and protocol details.

### Ion Meta: build harnesses with a harness

Ion ships with a meta-extension for building new extensions. Ion Meta is both a working example of a multi-agent extension and a practical tool for scaffolding your own.

```bash
# Start a session with ion-meta loaded
ion prompt --extension ~/.ion/extensions/ion-meta.ts \
  "/ion-meta scaffold a new extension for monitoring Kubernetes pods"
```

Ion Meta includes specialist agents (extension architect, agent designer, hook specialist, testing guide) and tools for scaffolding, validation, and hook discovery.

See the [ion-meta README](engine/extensions/ion-meta/README.md) for the full walkthrough.

## Security You Control

The engine ships security primitives. It does not enforce them by default. Your harness decides what gets enabled.

- **Permission engine.** Configure deny or ask mode to evaluate tool calls against rules before execution. In allow mode (the default), the engine executes without gatekeeping.
- **Dangerous command patterns.** A library of 35+ regex patterns that catch destructive bash commands. Enable them in your permission policy or use them as a starting point for your own.
- **OS-level sandboxing.** Seatbelt profiles on macOS, bubblewrap containers on Linux. Opt-in via engine config.
- **Secret redaction.** Credential scanning that catches keys and tokens before they leak into conversation history. Enable it in your security config.

The hook system lets you build your own permission logic on top. Block tool calls, rewrite commands, or gate execution behind approval workflows.

## Enterprise Without the Overhead

Configuration merges across four layers: compiled defaults, user global, project-level, and enterprise policy. The enterprise layer is sealed. Lower layers cannot weaken it.

Deploy managed preferences on macOS, registry policies on Windows, or drop config files in `/etc/ion/` on Linux. Your security team sets the floor. Your developers still get project-level flexibility above it.

## Configuration

The engine resolves credentials in order: environment variable, encrypted credential store (`~/.ion/credentials.enc`), then config file.

```bash
# Environment variables (one per provider you actually use)
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_API_KEY="..."

# Or configure in ~/.ion/engine.json. Lead with a local model that needs no key:
cat > ~/.ion/engine.json << 'EOF'
{
  "defaultModel": "qwen2.5:14b",
  "providers": {
    "ollama": {}
  }
}
EOF

# A hosted variant, mixing two providers.
# "OPENAI_API_KEY" here is not a literal key — the engine sees the all-caps
# name and expands it from the environment variable exported above.
# You can also pass a literal key: { "apiKey": "sk-proj-..." }
cat > ~/.ion/engine.json << 'EOF'
{
  "defaultModel": "gpt-4o",
  "providers": {
    "openai": { "apiKey": "OPENAI_API_KEY" },
    "ollama": {}
  }
}
EOF
```

### Config files

| File | Purpose |
|------|---------|
| `~/.ion/engine.json` | Global config: default model, providers, limits, permissions |
| `.ion/engine.json` | Project-level overrides (merged on top of global) |
| `~/.ion/settings.json` | Extension paths, harness settings |
| `~/.ion/models.json` | Custom model tiers and aliases |

### Layered merge

Config merges across four layers: compiled defaults, user global (`~/.ion/engine.json`), project-level (`.ion/engine.json`), then enterprise (sealed). Each layer can override anything from the layers below it. Project config can set a different default model, add MCP servers, or tighten limits without touching global settings.

### Default limits

The engine ships unopinionated. No turn cap, no budget ceiling, no idle timeout. Set them in `engine.json` under `"limits"` (or via per-call options) when you need them:

| Setting | Default | Notes |
|---------|---------|-------|
| `maxTurns` | unset (unlimited) | Set to a positive int to cap turns. |
| `maxBudgetUsd` | unset (unlimited) | Set to a positive float to cap spend in USD. |
| `idleTimeoutMs` | unset (unlimited) | Set to a positive int (ms) if your harness wants idle session culling. |

### CLI overrides

Flags override config for a single invocation:

```bash
ion prompt --model gpt-4.1-mini --max-turns 5 --max-budget 0.50 "Quick question"
```

See the [configuration reference](docs/configuration/engine-json.md) for the full config schema. To register custom models or tier aliases, see the [models.json reference](docs/configuration/models.md).

## Architecture

```
Client ──[Unix socket, NDJSON]──> Engine Server
  ──> SessionManager ──> ExtensionHost + ApiBackend
                                          │
                                    LlmProvider.Stream()
                                          │
                                    Tool execution (parallel)
```

Clients connect over a Unix socket and send NDJSON commands. The engine runs the agent loop: call the LLM, parse tool calls, execute tools in parallel, feed results back. Extensions hook into every stage. Multiple clients connect to the same daemon and receive broadcast events simultaneously.

For non-socket integrations, `ion rpc` reads commands from stdin and writes events to stdout.

## 14 Built-in Tools

Read, Write, Edit, Bash, Grep, Glob, Agent, WebFetch, WebSearch, NotebookEdit, LSP, Skill, ListMcpResources, and ReadMcpResource. Task tools (TaskCreate, TaskList, TaskGet, TaskStop) are opt-in via harness configuration. Extensions can register additional tools or replace the built-ins entirely.

## Reference Clients

This repo includes example applications built on the engine. They show what you can build on the engine, but the engine itself is the product.

- **[Desktop](desktop/)**: Electron overlay that connects to the engine over Unix socket.
- **[iOS Remote](ios/)**: iPhone companion for remote session monitoring.
- **[Relay](relay/)**: WebSocket relay for bridging clients across networks.

## Build from Source

```bash
make install    # build and install engine to ~/.ion/bin/ion
```

```bash
make desktop    # build and install desktop app
make relay      # docker build relay server
make ios        # xcodebuild iOS app
```

## License

MIT. Copyright (c) 2025-2026 Joshua Sprague.
