---
title: Tool Reference
description: Complete reference for all Ion Engine tools with parameters and behavior.
sidebar_position: 2
---

# Tool Reference

All core tools and the optional task tools. Each entry shows the tool name, description, input parameters, and behavior.

## Core Tools

### Read

Read a file from the filesystem. Returns content with line numbers in `cat -n` format.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | yes | Absolute path to file |
| `offset` | number | no | Line number to start from (1-based) |
| `limit` | number | no | Maximum lines to read |
| `pages` | string | no | Page range for PDF files (e.g. "1-5", "3"). Max 20 pages per request. |

Reads text files with line numbers. For PDF files, extracts text from specified pages. Returns an error if the path is a directory.

### Write

Write content to a file, creating parent directories as needed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | yes | Absolute path to file |
| `content` | string | yes | Content to write |

Creates intermediate directories with `0755` permissions. Writes the file with `0644` permissions. Overwrites existing files.

### Edit

Replace string matches in a file. Supports exact match and fuzzy matching.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | yes | Absolute path to file |
| `old_string` | string | yes | String to find and replace |
| `new_string` | string | yes | Replacement string |
| `replace_all` | boolean | no | Replace all occurrences (default: false) |

Two-phase matching: exact match first, then fuzzy. Fuzzy matching applies NFKC normalization, smart quote replacement, Unicode dash normalization, special space normalization, and per-line trailing whitespace trimming.

### Bash

Execute a bash command and return its output.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | yes | The bash command to execute |
| `timeout` | number | no | Timeout in milliseconds (default: 120000). Ignored when `run_in_background` is true |
| `run_in_background` | boolean | no | Run the command in the background and return immediately with a task ID and output-file path |
| `notify_on_complete` | boolean | no | Only meaningful with `run_in_background`. Deliver the command's result back to the session when it finishes, instead of requiring polling |

Runs through the pluggable `BashOperations` backend. Returns stdout and stderr. Non-zero exit codes are reported as tool errors. The backend supports sandboxing via Seatbelt (macOS) or bubblewrap (Linux).

With `run_in_background: true`, the command starts detached from the tool call in its own process group and the tool returns immediately with a `bash-<n>` task ID and an output file under `~/.ion/tasks/` capturing interleaved stdout+stderr. The task registers in the tasks registry: `TaskGet` shows status, exit code, output path, and a bounded tail of recent output; `TaskStop` kills the process group. When the owning session stops, its running background tasks are killed. The Task tools are harness opt-in — without them, the model reads the output file directly (the result says which hint applies). Backends advertise support via the `BackgroundBashOperations` capability interface; only the local backend implements it today, and unsupported backends return a clean error.

With `notify_on_complete: true` the command additionally joins the session's **outstanding set**, and the engine takes responsibility for delivering its result — the model does not poll. Three consequences follow:

- **The model may keep working.** Starting a notifying command does not commit the session to waiting. It can start more commands, do unrelated work, and end its turn whenever it wants.
- **The engine parks the session at the turn boundary.** When the model finishes its turn with commands still outstanding, the run ends without completing (`engine_task_suspended` carrying `awaitingTaskIds`) and the session consumes no tokens while it waits. A session with an empty outstanding set completes exactly as it always has.
- **Each completion wakes the session once.** The result arrives as an injected prompt naming the command's exit code, output path, output tail, and whatever is still outstanding. If the woken run ends its turn with work still in flight, it parks again. The cycle repeats until the set empties.

A completion that arrives while the session is already running is delivered mid-turn via the steer path instead, so a working orchestrator is never interrupted.

Delivery is an opinion the consumer owns: `engine.json`'s `backgroundTasks.delivery` selects `"wake"` (default), `"queue"` (hold the result for the next run the session starts for another reason), or `"event_only"` (emit the typed event and fire the hook; start nothing). The typed `engine_background_task_complete` event and the `background_task_completed` hook fire under every mode. `backgroundTasks.parkTimeoutMs` bounds how long a session stays parked on a command that never exits; on timeout the session wakes and the command stays tracked.

### Grep

Search file contents using ripgrep, falling back to `grep -rn` if `rg` is unavailable.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | yes | Regex pattern to search for |
| `path` | string | no | Directory or file to search in |
| `glob` | string | no | Glob pattern to filter files (e.g. "*.ts") |
| `output_mode` | string | no | `"content"`, `"files_with_matches"`, or `"count"` |

Uses ripgrep when available for performance. Falls back to `grep -rn` otherwise.

### Glob

Find files matching a glob pattern.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | yes | Glob pattern to match (e.g. "**/*.ts") |
| `path` | string | no | Directory to search in |

Uses the `doublestar` library for `**` support. Results are sorted. Defaults to the session working directory when `path` is omitted.

### Agent

Launch a new agent to handle complex, multi-step tasks autonomously.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | yes | The task for the agent to perform |
| `description` | string | no | Short description of what the agent will do |
| `model` | string | no | Model override for the child agent. Invalid values warn and fall back to the session default. |

Spawns a child session via the session-scoped `AgentSpawner`. The child agent has its own context and tool access. Returns the agent's final output.

### WebFetch

Fetch content from a URL. Returns text content from web pages (HTML converted to text) or raw content for APIs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | yes | The URL to fetch |
| `method` | string | no | HTTP method: `"GET"` or `"POST"` (default: GET) |
| `headers` | object | no | HTTP headers as key-value pairs |
| `body` | string | no | Request body for POST requests |
| `maxBytes` | number | no | Max response size in bytes (default: 5MB) |

Includes SSRF protection: blocks requests to private IP ranges (RFC 1918), loopback, and link-local addresses. HTML responses are converted to plain text by stripping scripts, styles, and tags.

### WebSearch

Search the web for information.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `maxResults` | number | no | Maximum number of results (default: 5) |

Requires one of the following environment variables: `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, or `SEARXNG_URL`. The backend is selected based on which key is present.

### NotebookEdit

Read, edit, or run Jupyter notebook (.ipynb) cells.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | yes | `"read"`, `"edit"`, `"run"`, `"add"`, or `"delete"` |
| `path` | string | yes | Path to .ipynb file |
| `cellIndex` | number | no | Cell index (0-based) for edit/run/delete |
| `content` | string | no | New cell content for edit/add |
| `cellType` | string | no | Cell type for add: `"code"` or `"markdown"` (default: code) |

Parses and manipulates Jupyter notebook JSON format directly. The `run` action executes cells via a subprocess.

### LSP

Language Server Protocol operations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `operation` | string | yes | `"definition"`, `"references"`, `"hover"`, `"symbols"`, `"workspace_symbols"`, or `"diagnostics"` |
| `file_path` | string | no | File path (required for most operations) |
| `line` | number | no | Line number (0-based, for definition/references/hover) |
| `character` | number | no | Character offset (0-based, for definition/references/hover) |
| `query` | string | no | Search query (for workspace_symbols) |

Requires an `LspManager` to be configured by the harness. Returns an error if no LSP manager is available.

### Skill

Invoke a loaded skill by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `skill` | string | yes | The name of the skill to invoke |
| `args` | string | no | Optional arguments to pass to the skill |

Returns the skill content for execution, prefixed with the skill's name, description, and — for disk-loaded skills — a `Base directory for this skill:` line so the model can resolve the skill's relative companion files (`references/*.md`, scripts, assets). Skills are loaded from the skills registry, which the engine populates at session start.

Skill roots (always loaded): `~/.ion/skills/` and `{workingDir}/.ion/skills/`. When the consumer enables Claude compatibility, `~/.claude/skills/` is loaded as well. Skills are also user-invocable as slash commands by default (`/name` resolves the SKILL.md and lists it in slash discovery); set `user-invocable: false` in frontmatter to hide a skill from the autocomplete feed (typed resolution still works), or `disable-model-invocation: true` to block the Skill tool path.

Skills can be placed in the roots above in two formats:

- **Flat file**: `<name>.md` — the skill name comes from the `name` frontmatter key, falling back to the filename stem.
- **Subdirectory**: `<name>/SKILL.md` — the skill name is always the directory name. This is the industry-standard layout used by most third-party skill repositories.

Both formats coexist in the same directory. Frontmatter supports single-line values (`key: value`) and YAML block scalars (`key: >` for folded, `key: |` for literal).

### ListMcpResources

List resources available from a connected MCP server. See [MCP Tools](mcp-tools.md).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | yes | Name of the MCP server to list resources from |

### ReadMcpResource

Read a specific resource from a connected MCP server by URI. See [MCP Tools](mcp-tools.md).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | yes | Name of the MCP server |
| `uri` | string | yes | URI of the resource to read |

### SearchHistory

Search the conversation history for content that may have been compacted or cleared from the active context window. Returns matching snippets with context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search term to look for in conversation history. Case-insensitive keyword matching. |
| `max_results` | number | no | Maximum number of results to return. Defaults to 20. Maximum 50. |

### WorktreeList

List every worktree registered for the repository containing the current directory, including this one. Each entry carries its branch, source branch, title, landed status, and (when resolvable) its current HEAD commit and how many commits it holds that have not yet reached its source branch. Read-only: every git query runs in the calling conversation's own directory, never inside another worktree's checkout — cross-worktree data is read through the shared git object store by referencing a sibling's branch name, not by visiting its directory.

No parameters.

### WorktreeCommits

Show the commit log for one worktree's branch (a sibling worktree of the same repository, or this one). Reads through the shared git object store from the calling conversation's own directory. Use before starting work to check whether a sibling worktree has already built what you are about to build.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `worktree` | string | no | Branch name or worktree path to inspect. Defaults to this conversation's own worktree when omitted. |
| `limit` | integer | no | Maximum number of commits to return. Defaults to 20, capped at 100. |
| `path` | string | no | Optional file or directory path to scope the log to. |

### WorktreeDiff

Show a diff for one worktree's branch (a sibling worktree of the same repository, or this one): either one specific commit, or everything the branch has done since it diverged from its source branch. Reads through the shared git object store from the calling conversation's own directory. Large diffs are truncated (stated in the result via `truncated`) after a `stat` summary that always survives.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `worktree` | string | no | Branch name or worktree path to inspect. Defaults to this conversation's own worktree when omitted. |
| `commit` | string | no | Show exactly this commit sha. When omitted, shows everything the branch has done since diverging from its source (or from `against`). |
| `against` | string | no | Comparison ref for the cumulative diff. Ignored when `commit` is set. Defaults to the worktree's recorded source branch. |
| `path` | string | no | Optional file or directory path to scope the diff to. |

## Client tools

A session's owning client can declare tools of its own at `start_session`
(`EngineConfig.toolGate.clientTools`). They join the session's tool list beside
MCP and extension tools; when the model calls one, the engine emits
`engine_tool_gate_request` (kind `tool`) and the client answers with the result
(`tool_gate_response`). This is the third tool provision path beside MCP
servers and extensions — see the protocol reference
([client commands](../protocol/client-commands.md#tool_gate_response)).

Ion's desktop uses this path to provide three read-only bench tools
(`WorkspaceAttribution`, `BenchMemberFile`, `BenchResolutionHistory`) for
conversations rooted in an integration bench — see
[ADR-024](../architecture/adr/024-integration-workspace.md). They are desktop
surface, not engine tools: a consumer without Ion's bench never sees them.
This is a different concern from the generic `WorktreeList`/`WorktreeCommits`/
`WorktreeDiff` tools above, which are engine-core because every consumer with
parallel scoped agents needs them and would build them identically — see
[ADR-025](../architecture/adr/025-client-tool-gate.md) for the ownership split
between generic worktree mechanism (engine) and the bench product (desktop).

## Optional Tools

These tools are not registered by default. Call `RegisterTaskTools()` from harness code to enable them. See [Task Tools](task-tools.md) for details.

| Tool | Description |
|------|-------------|
| TaskCreate | Create an asynchronous sub-task in a separate session |
| TaskList | List all active and recently completed tasks |
| TaskGet | Get status and result of a task by ID |
| TaskStop | Stop a running task |

## Sentinel Tools

Sentinel tools are injected per-run by the engine. They are **not** in the global tool registry and cannot be registered via `RegisterTool`. Each sentinel is guarded to its own mode: calls that arrive in the wrong mode fall through to an "Unknown tool" error rather than triggering the sentinel logic.

### ExitPlanMode

Injected only when `PlanMode=true`. No parameters.

When the model calls `ExitPlanMode`, the engine:

1. Records a `PermissionDenial` to signal plan completion.
2. Emits `PlanModeChangedEvent{Enabled: false}`.
3. **Terminates the run** so the desktop can surface the plan-ready card.

Hallucinated calls in auto mode (`PlanMode=false`) fall through to "Unknown tool" and do not trigger any plan-mode transition.

### EnterPlanMode

Injected only when `PlanMode=false` (auto mode). No parameters.

When the model calls `EnterPlanMode`, the engine:

1. Fires the [`before_plan_mode_enter`](../hooks/reference.md#plan-mode-2) hook. Extensions can veto by returning `Allow: &false` with an optional `Reason`.
2. If denied, the run continues in auto mode and the `Reason` is returned to the model as the tool result.
3. If allowed, the session flips into plan mode, allocates or reuses the `planFilePath`, and emits `PlanModeChangedEvent{Enabled: true}`.
4. **Does not terminate the run.** The full plan-mode prompt is returned as the tool result so the model sees the framing immediately and can begin planning.

Hallucinated calls in plan mode (`PlanMode=true`) fall through to "Unknown tool" and do not trigger any transition.
