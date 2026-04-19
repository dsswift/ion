# Ion Engine

A headless agent runtime that fits in your pocket. One binary. Zero opinions. Fifty hooks to make it yours.

`~2.6 MB static binary` · `14+ LLM providers` · `43 extension hooks` · `15 built-in tools` · `MIT license`

---

## The Age of Harness Engineering

The AI agent ecosystem is splitting in two. On one side, opinionated apps that decide how you work. On the other, raw APIs that leave you building the agent loop, the tool execution, the sandboxing, and the conversation management from scratch.

Ion Engine sits in between. It handles the hard parts: the agent loop, parallel tool execution, conversation persistence with branching, and multi-provider abstraction. It ships opt-in security primitives (dangerous command patterns, sensitive path protection, secret redaction, OS-level sandboxing) that you enable when you need them. But it has zero opinions about your interface, your workflow, your permission model, or your deployment target.

You get a raw agent. You shape what it becomes.

## Quick Start

```bash
# Install (macOS)
curl -fsSL https://github.com/dsswift/ion/releases/latest/download/ion-darwin-arm64 \
  -o /usr/local/bin/ion && chmod +x /usr/local/bin/ion

# Run your first prompt (no daemon, no setup)
ion prompt "What files are in the current directory?"
```

That's it. One command. The engine starts in-process, calls the LLM, executes tools, streams the result to stdout, and exits. No daemon to manage, no socket to connect to, no background process to remember. Set an API key before your first prompt:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

This is the default for scripted workflows: shell scripts, cron jobs, git hooks, CI pipelines, orchestration scripts. Each invocation is self-contained. The engine loads your config, runs the prompt, and gets out of the way.

```bash
# One-shot with JSON output
ion prompt --output json "Summarize the last 5 commits" | jq -r '.result'

# One-shot with streaming NDJSON (for piping to other tools)
ion prompt --output stream-json "Review this diff for security issues"

# Skip configured extensions for this run
ion prompt --no-extensions "What time is it in UTC?"

# Clear configured extensions, load only this one
ion prompt --no-extensions --extension ./my-reviewer "Review the staged changes"
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
  --extension ~/.ion/extensions/ops-harness

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

# Send a follow-up -- the session remembers context
ion prompt --key myproject "Which of those files changed in the last week?"

# Send another -- still the same conversation
ion prompt --key myproject "Show me the diff for the most recent change"

# Start a second session with different extensions
ion start --key infra --dir /path/to/infra-repo \
  --extension ~/.ion/extensions/terraform-tools

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
- **Multiple clients.** A desktop app, a CLI, and a mobile companion connect to the same daemon simultaneously. Every client receives broadcast events. One engine serves all your interfaces.
- **Warm extensions.** Extension subprocesses stay alive between prompts. No spawn/init overhead on each invocation. Custom tools, hooks, and agents are ready instantly.
- **Real-time streaming.** Connect with `ion attach` and watch events flow as the agent works. Pipe NDJSON into `jq`, a monitoring dashboard, or an approval workflow. Build integrations that react to tool calls, text output, and errors in real time.
- **Session management.** Run multiple sessions in parallel, each with its own model, extensions, and working directory. Route prompts to the right session by key. One daemon, many workstreams.

One-shot mode runs a fresh engine per invocation. Daemon mode runs one engine that serves everything. Use one-shot for scripts and automation. Use daemon mode for applications and interactive workflows. Both load the same config, discover the same extensions, and run the same agent loop.

See the [engine docs](engine/README.md) for Linux, Windows, and Docker install instructions.

## One Engine, Many Shapes

Ion Engine is a raw agent. On its own, it takes a prompt, talks to an LLM, executes tools, and streams results back. That's it. No opinions. No workflow. No interface.

The power is in what you build around it.

### A shell script

The simplest harness is a few lines of bash. Send a prompt, get a result. Embed an AI agent in a cron job, a git hook, or a CI pipeline with nothing more than a shell script.

```bash
#!/bin/bash
ion prompt --output json "Review the diff and flag any security concerns" \
  | jq -r '.result' \
  >> review-output.md
```

### A full application

As an example, the Ion Desktop is a transparent Electron overlay built on top of the engine. It connects to the daemon over a Unix socket, sends NDJSON commands, and renders streamed events in React. The engine runs every session. The desktop is purely an interface.

```
Desktop (React) ──[IPC]──> EngineBridge ──[Unix socket]──> Ion Engine
```

The wiring is a thin socket client. Connect, write JSON lines, parse events:

```typescript
// desktop/src/main/engine-bridge.ts (simplified)
import { createConnection } from 'net'
import { join } from 'path'
import { homedir } from 'os'

const SOCKET = join(homedir(), '.ion', 'engine.sock')
const conn = createConnection(SOCKET)

// Send commands as NDJSON
conn.write(JSON.stringify({ cmd: 'start_session', key: 's1', config: { model: 'claude-sonnet-4-6' } }) + '\n')
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

The desktop never calls an LLM. It never executes a tool. It asks the engine, and the engine handles everything. You could replace the desktop with a web app, a terminal UI, a VS Code extension, or a mobile app, and the engine wouldn't know the difference.

Notice the `key` field in every command. That's session routing. Ion Desktop uses this to manage tabs: each tab starts a session with a unique key, sends prompts to that key, and filters incoming events by key to render in the correct tab. One socket connection, one daemon, many independent sessions running in parallel. The same mechanism that powers `ion prompt --key` and `ion attach --key` from the CLI is what powers a full multiplexed and tabbed application.

### A workflow orchestration

An extension can register multiple agents, each with its own model, tools, and system prompt. A single prompt to a well-built harness can trigger an entire workflow: the LLM delegates to specialized agents, they run their tool loops in parallel, and the results flow back to the parent session.

```bash
#!/bin/bash
# Full QA pipeline in two harness invocations

# Step 1: QA harness -- one extension with review, test, and report agents
# The LLM orchestrates internally: reviews the diff, generates tests,
# runs them, and produces a structured report. One prompt, multiple agents.
report=$(ion prompt --output json --extension ./extensions/qa-harness \
  "Review the staged diff for security and style issues. Generate tests \
   for anything flagged. Run the tests. Produce a structured QA report \
   with pass/fail status, issue severity, and coverage metrics.")

# Step 2: Publication harness -- different extension, different agents
# This harness has agents for formatting, email drafting, and Slack posting.
# It picks up where the QA harness left off.
echo "$report" | jq -r '.result' | \
  ion prompt --extension ./extensions/publish-harness \
  "Format this QA report for stakeholders. Post a summary to #engineering \
   in Slack. Email the full report to the team leads."
```

The QA harness extension registers a code-reviewer agent, a test-writer agent, and a report-generator agent. It also registers tools: `lint`, `run_tests`, `coverage`. When the LLM receives the prompt, it delegates to each agent as needed. The agents run their own tool loops, call the extension's custom tools, and report back. The harness handles the entire review-test-report workflow internally.

The publication harness is a completely different extension with its own agents (formatter, email-drafter, slack-poster) and tools (`send_email`, `post_slack`, `render_pdf`). It doesn't know or care about code review. It takes structured input and distributes it to the right channels.

Two invocations. Two harnesses. Each harness is a self-contained multi-agent system with its own tools, hooks, and orchestration logic. The shell script sequences them; the engine runs each one.

You could also run a single agent per invocation for simple tasks. But the engine supports sub-agents, parallel tool execution, and extension-registered tools specifically so you can build harnesses that do real work in a single prompt, not just wrap one LLM call.

Because the engine communicates over NDJSON on sockets or stdin/stdout, orchestration is language-agnostic. Write the coordinator in Python, Go, bash, or whatever your infrastructure already speaks.

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
# Single agent container
docker run -e ANTHROPIC_API_KEY ion-engine prompt "Analyze this codebase"

# Orchestration script inside a container
docker run -e ANTHROPIC_API_KEY ion-orchestrator

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
  name: 'ops-harness',
  agents: [
    { name: 'triage-agent', description: 'Assess issue priority', model: 'claude-haiku-4-5-20251001' },
    { name: 'comms-agent', description: 'Draft status updates', model: 'claude-sonnet-4-6' }
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
model: claude-sonnet-4-6
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

That's a complete agent definition. The frontmatter declares capabilities. The body becomes the system prompt. Once a harness loads and registers this agent, the LLM can delegate to it by name, and it runs its own tool loop with only the tools you listed.

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

Your platform team ships a development harness. It installs standard agents to `~/.ion/agents/`:

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

When a developer runs the harness from inside `game-engine/`, they get six agents: the three project-local ones plus `test-writer`, `security-scanner`, and `doc-writer` from the harness. The project's `code-reviewer.md` overrides the harness version because project wins by filename.

Different repo, different agents. Same harness. Same binary.

An infrastructure repository layers differently:

```
infra/.ion/agents/
├── terraform-planner.md      # Plan and validate Terraform changes
├── cost-analyzer.md          # Estimate cloud spend from config changes
├── drift-detector.md         # Compare live state against declared state
└── security-scanner.md       # Override: infra-specific security checks
```

Same harness, same four base agents, completely different specialization. The developer doesn't configure anything. They `cd` into the repo, the harness calls `Discover()` with `IncludeProjectDir: true`, and the right agents are there.

### Agent hierarchies

Agents can declare a parent. The engine builds a directed graph and catches cycles at discovery time.

```markdown
# .ion/agents/lead.md
---
name: lead
description: Coordinate sub-agents for complex tasks
model: claude-sonnet-4-6
---

# .ion/agents/researcher.md
---
name: researcher
parent: lead
description: Deep research and analysis
model: claude-haiku-4-5-20251001
tools: [Read, Grep, Glob, WebSearch, WebFetch]
---

# .ion/agents/implementer.md
---
name: implementer
parent: lead
description: Write code based on research findings
model: claude-sonnet-4-6
tools: [Read, Write, Edit, Bash, Grep, Glob]
---
```

Once the harness registers these agents, the lead can delegate to the researcher and implementer. They run in parallel, each with their own tool loop and model. If an agent references a parent that doesn't exist, `BuildGraph()` logs a warning and promotes it to a root agent. If agents form a cycle, discovery returns an error. No silent loops.

### Everything composes

This is where it clicks. Sub-agents aren't a standalone feature. They combine with everything else.

**Agents + Extensions + Hooks:**

Your extension registers custom tools (deploy, query database, send notifications). Agents loaded from disk inherit access to those tools. A `tool_call` hook enforces policy across all of them. The code-reviewer agent can call `Bash` to run linters. The cost-analyzer agent can call your custom `cloud_billing` tool. The hook blocks any agent from running `rm -rf`. One policy, applied everywhere.

**Agents + Model routing:**

The lead agent runs on Opus for complex reasoning. Researchers run on Haiku for speed. The security scanner runs on Sonnet for the right balance. Each agent file declares its model. A `model_select` hook can override any of them based on cost budgets or time-of-day routing. Your harness controls the spend without touching the agent definitions.

**Agents + Sealed enterprise config:**

Your security team seals the permission policy at the enterprise layer. Every agent, whether loaded from the harness, from the project, or registered inline by an extension, runs inside those guardrails. Teams customize agents freely. The security floor never moves.

### Build any harness

The combination of a raw engine, layered agent discovery, extensions, and hooks means you can build a harness for anything. Not just code.

A **warehouse operations** harness with agents that monitor inventory levels, generate reorder recommendations, and draft supplier communications. Extensions connect to your WMS and ERP. Hooks enforce approval workflows before any purchase order goes out.

A **research lab** harness with agents that search literature databases, summarize papers, cross-reference findings, and draft grant proposals. Project-local agents specialize by research domain. The biology lab and the materials science lab run the same harness with different agent sets.

A **farm management** harness with agents that analyze soil sensor data, plan crop rotations, track equipment maintenance schedules, and generate compliance reports. Extensions integrate with IoT platforms and weather APIs.

A **department operations** harness with agents that triage inbound requests, draft internal communications, track project timelines, and prepare budget summaries. Different departments layer their own agents on top.

The engine handles the agent loop, tool execution, streaming, and multi-provider abstraction. Your harness handles the domain. Your agents handle the expertise. Your extensions handle the integrations. Your hooks handle the policy.

One binary. Any domain. Layer what you need.

### Fork it

MIT license. No cloud dependency. No accounts. No telemetry. No call-home.

The engine is a single static binary with zero runtime dependencies. Every LLM provider is implemented as raw HTTP. No vendor SDK means no transitive dependency chain you don't control.

If you build a harness on Ion Engine and decide tomorrow that you need to go a different direction, fork it. The entire runtime is yours. Your agents are markdown files you already own. Your extensions are standalone processes you already wrote. Nothing is locked inside a platform you can't reach.

This is a starting point and a core. Build on it, customize it, ship it to your team, ship it to your customers. It's yours.

## Talk to Any Model

Fourteen providers. Zero SDKs. Every provider is implemented as raw HTTP with SSE parsing, so there are no transitive dependencies to audit, no version conflicts to untangle, and no vendor lock-in to negotiate your way out of.

**Native:** Anthropic, OpenAI, Google Gemini, AWS Bedrock, Azure OpenAI, Vertex AI, Azure AI Foundry

**OpenAI-compatible:** Groq, Cerebras, Mistral, OpenRouter, Together, Fireworks, xAI, DeepSeek, Ollama

Point it at your own endpoint. Swap models mid-session. Route traffic through your AI gateway. The engine doesn't care where the tokens come from.

## Extend Everything

Extensions are where you make the engine yours. An extension is a subprocess that communicates with the engine over JSON-RPC on stdin/stdout. Write one in any language. The engine spawns it, dispatches lifecycle hooks, and listens for instructions. If it reads JSON and writes JSON, it's an extension.

### Your first extension in 5 minutes

**1. Create the extension:**

```bash
mkdir -p ~/.ion/extensions/ops-harness
```

**2. Register tools and hooks:**

This extension gives the engine access to your calendar, issue tracker, and team chat. It also hooks into tool calls to enforce a policy: no sending messages outside business hours.

```javascript
// ~/.ion/extensions/ops-harness/index.js
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin })

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

rl.on('line', (line) => {
  const msg = JSON.parse(line)

  if (msg.method === 'init') {
    reply(msg.id, {
      name: 'ops-harness',
      hooks: ['tool_call'],
      tools: [
        { name: 'calendar', description: 'List calendar events for a date range',
          parameters: { type: 'object', properties: {
            start: { type: 'string' }, end: { type: 'string' }
          }}},
        { name: 'issues', description: 'Search issue tracker (open, assigned, priority)',
          parameters: { type: 'object', properties: {
            assignee: { type: 'string' }, status: { type: 'string' }
          }}},
        { name: 'notify', description: 'Send a message to a Teams channel or person',
          parameters: { type: 'object', properties: {
            to: { type: 'string' }, message: { type: 'string' }
          }}}
      ],
      // Register specialized agents the LLM can delegate to
      agents: [
        { name: 'triage-agent', description: 'Analyze open issues, assess priority, recommend actions',
          model: 'claude-haiku-4-5-20251001' },
        { name: 'comms-agent', description: 'Draft status updates, meeting prep notes, and team notifications',
          model: 'claude-sonnet-4-6' }
      ]
    })
    return
  }

  // Tool execution -- the engine calls these when the LLM invokes them
  if (msg.method === 'tool' && msg.params) {
    const { name, input } = msg.params
    if (name === 'calendar')  reply(msg.id, { output: fetchCalendar(input) })
    if (name === 'issues')    reply(msg.id, { output: searchIssues(input) })
    if (name === 'notify')    reply(msg.id, { output: sendNotification(input) })
    return
  }

  // Hook: block outbound messages outside business hours
  if (msg.method === 'hook' && msg.params.hook === 'tool_call') {
    const { tool } = msg.params.data
    if (tool === 'notify') {
      const hour = new Date().getHours()
      if (hour < 8 || hour > 18) {
        reply(msg.id, { blocked: true, reason: 'Outbound messages blocked outside 8am-6pm.' })
        return
      }
    }
    reply(msg.id, {}) // no opinion on other tools
    return
  }

  reply(msg.id, {})
})

// -- Your integrations (replace with real API calls) --
function fetchCalendar(input)    { /* Microsoft Graph, Google Calendar, etc. */ }
function searchIssues(input)     { /* YouTrack, Linear, Jira, GitHub Issues */ }
function sendNotification(input) { /* Teams, Slack, email */ }
```

The extension registers three tools and two sub-agents. The triage agent runs on a smaller model (fast, cheap) to sort through issues. The comms agent runs on a stronger model to draft polished updates. Both agents inherit the extension's tools, so they can pull from your calendar, query your issue tracker, and send notifications. The engine runs each agent in its own tool loop and feeds the results back to the parent session.

**3. Use it from a single prompt:**

```bash
ion prompt --extension ~/.ion/extensions/ops-harness \
  "What's on my calendar today? Triage my open issues and draft status updates \
   for anything that's moved since yesterday."
```

The LLM sees the calendar, issues, and notify tools alongside the built-in Agent tool. It can call your custom tools directly, or delegate to the triage and comms agents for focused work. The agents run their own tool loops in parallel, then report back.

**4. Chain it into a multi-step pipeline:**

```bash
#!/bin/bash
# morning-briefing.sh -- daily ops pipeline

# Step 1: Gather and triage (agents work in parallel)
briefing=$(ion prompt --output json --extension ~/.ion/extensions/ops-harness \
  "Pull my calendar for today. Dispatch the triage-agent to assess my open \
   P0/P1 issues. Summarize what I need to focus on and flag any conflicts.")

# Step 2: Draft comms based on triage results
actions=$(echo "$briefing" | jq -r '.result' | \
  ion prompt --output json --extension ~/.ion/extensions/ops-harness \
  "Dispatch the comms-agent to draft status updates for each triaged issue. \
   If any meetings need prep, have it list what I should review beforehand.")

# Step 3: Send everything out
echo "$actions" | jq -r '.result' | \
  ion prompt --extension ~/.ion/extensions/ops-harness \
  "Send the status updates to the #engineering channel. \
   Send the meeting prep notes to me directly."
```

Three sequential prompts. Same extension, same tools, same policy hooks. Each invocation loads the ops-harness extension, runs the prompt, and exits. The engine handles the LLM interaction and tool execution at each step. The script handles the flow.

### Where extensions live

The engine looks for extensions in three places, in order:

| Location | Scope | Use case |
|----------|-------|----------|
| `.ion/extensions/` | Project | Project-specific behavior (CI guards, team conventions) |
| `~/.ion/extensions/` | User global | Personal workflow (cost limits, model preferences) |
| Profile config path | Explicit | Referenced by absolute path in `~/.ion/settings.json` |

Each extension directory needs an entry point: `index.js` (Node.js), `main` (native binary), or any executable the engine can spawn.

### The protocol

Extensions don't use an SDK. They speak a simple protocol:

```
Engine                              Extension
  │                                    │
  │──── init ─────────────────────────>│  "what hooks and tools do you have?"
  │<─── result ────────────────────────│  hooks: [tool_call], tools: [calendar, issues, notify]
  │                                    │
  │──── tool: calendar ───────────────>│  LLM called your custom tool
  │<─── result ────────────────────────│  { output: "9am: standup, 2pm: design review..." }
  │                                    │
  │──── hook: tool_call ──────────────>│  LLM wants to call "notify" at 11pm
  │<─── result ────────────────────────│  { blocked: true, reason: "outside business hours" }
  │                                    │
```

Every message is a JSON-RPC 2.0 line on stdin/stdout. Return `{}` or `null` from any hook to express no opinion. The engine proceeds with the original data.

This means you can write extensions in anything: Python, Go, Rust, a shell script. No SDK required. If your language can read stdin and write stdout, you can build an extension.

### Extension SDKs

Helper libraries that wrap the JSON-RPC protocol so you can focus on logic instead of parsing.

**Go SDK:**

```go
// ~/.ion/extensions/audit-log/main.go
package main

import "github.com/dsswift/ion/extension"

func main() {
    ext := extension.New("audit-log")
    ext.OnHook("tool_call", func(ctx *extension.Context, data any) (any, error) {
        // Log every tool call to an audit trail
        logToAuditService(data)
        return nil, nil // nil = no opinion, don't modify
    })
    ext.Run() // blocks, reads JSON-RPC from stdin
}
```

**TypeScript / JavaScript:**

```javascript
// ~/.ion/extensions/cost-router/index.js
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin })

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

rl.on('line', (line) => {
  const msg = JSON.parse(line)

  if (msg.method === 'init') {
    reply(msg.id, {
      name: 'cost-router',
      hooks: ['model_select', 'tool_call'],
      tools: [
        { name: 'deploy', description: 'Deploy the current branch to staging',
          parameters: { type: 'object', properties: { branch: { type: 'string' } } } }
      ]
    })
    return
  }

  if (msg.method === 'hook' && msg.params.hook === 'model_select') {
    if (msg.params.data.costUsd > 0.50) {
      reply(msg.id, { model: 'claude-haiku-4-5-20251001' })
      return
    }
    reply(msg.id, {})
    return
  }

  if (msg.method === 'hook' && msg.params.hook === 'tool_call') {
    const { tool, input } = msg.params.data
    if (tool === 'Bash' && input.command.includes('rm -rf')) {
      reply(msg.id, { blocked: true, reason: 'Destructive command blocked by policy.' })
      return
    }
    reply(msg.id, {})
    return
  }

  if (msg.method === 'tool' && msg.params.name === 'deploy') {
    reply(msg.id, { output: runDeploy(msg.params.input.branch) })
    return
  }

  reply(msg.id, {})
})
```

Name the entry point `index.js` for Node.js or `extension.ts` for TypeScript (auto-bundled via esbuild). Both speak the same JSON-RPC protocol.

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

### 43 hooks

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

See the full [extension reference](engine/README.md#extensions) for init handshake format, hook data shapes, and protocol details.

## Security You Control

The engine ships security primitives. It does not enforce them by default. Your harness decides what gets enabled.

- **Permission engine.** Configure deny or ask mode to evaluate tool calls against rules before execution. In allow mode (the default), the engine executes without gatekeeping.
- **Dangerous command patterns.** A library of 35+ regex patterns that catch destructive bash commands. Enable them in your permission policy or use them as a starting point for your own.
- **OS-level sandboxing.** Seatbelt profiles on macOS, bubblewrap containers on Linux. Opt-in via engine config.
- **Secret redaction.** Credential scanning that catches keys and tokens before they leak into conversation history. Enable it in your security config.

The hook system gives you the seams to build your own permission logic from scratch. Block tool calls, rewrite commands, gate execution behind approval workflows. The engine provides the tools. You enforce the policy.

## Enterprise Without the Overhead

Configuration merges across four layers: compiled defaults, user global, project-level, and enterprise policy. The enterprise layer is sealed. Lower layers cannot weaken it.

Deploy managed preferences on macOS, registry policies on Windows, or drop config files in `/etc/ion/` on Linux. Your security team sets the floor. Your developers still get project-level flexibility above it.

## Configuration

The engine resolves credentials in order: environment variable, encrypted credential store (`~/.ion/credentials.enc`), then config file.

```bash
# Environment variables (one per provider)
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export GOOGLE_API_KEY="..."

# Or configure in ~/.ion/engine.json
cat > ~/.ion/engine.json << 'EOF'
{
  "defaultModel": "claude-sonnet-4-6",
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "openai": { "apiKey": "sk-..." }
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

Override in `engine.json` under `"limits"`:

| Setting | Default |
|---------|---------|
| `maxTurns` | 50 |
| `maxBudgetUsd` | 10.00 |
| `idleTimeoutMs` | 300000 (5 min) |

### CLI overrides

Flags override config for a single invocation:

```bash
ion prompt --model claude-haiku-4-5-20251001 --max-turns 5 --max-budget 0.50 "Quick question"
```

See the [engine docs](engine/README.md) for the full config reference.

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

## 15 Built-in Tools

Read, Write, Edit, Bash, Grep, Glob, Agent, WebFetch, WebSearch, Task management, NotebookEdit, and LSP. Extensions can register additional tools or replace the built-ins entirely.

## Companion Products

This monorepo includes three products built on top of the engine.

| Product | Description |
|---------|-------------|
| [Desktop](desktop/) | Electron overlay for macOS. Transparent, always-on-top, click-through. Connects to the engine over Unix socket. |
| [iOS Remote](ios/) | iPhone companion. View sessions, approve permissions, send prompts. End-to-end encrypted. |
| [Relay](relay/) | WebSocket relay for remote access between Desktop and iOS. Stateless, never decrypts content. |

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
