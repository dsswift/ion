---
title: Session Lifecycle
description: Session creation, prompt dispatch, and shutdown.
sidebar_position: 2
---

# Session Lifecycle

Sessions move through a predictable sequence: create, run, stop. The engine manages transitions and emits events at each stage.

## Create (StartSession)

`StartSession(key, config)` initializes a new session:

1. Allocate the session struct with the provided config.
2. Initialize the process registry for extension-spawned subprocesses.
3. Wire the permission engine (default allow-all, or from engine config).
4. Wire telemetry if configured.
5. Load the extension host if `extensionDir` is set in config.
6. Fire `session_start` hook on the extension.
7. Discover capabilities from extensions.
8. Load skills from `~/.ion/skills/` and `.ion/skills/`.
9. Connect MCP servers from engine config.
10. Emit `engine_status` with state `idle`.

If a session with the same key already exists, `StartSession` returns an error.

## Prompt (SendPrompt)

`SendPrompt(key, text, overrides)` dispatches a prompt to the session's backend:

1. If a run is active, queue the prompt (up to 32 pending prompts).
2. Generate a unique request ID.
3. Build `RunOptions` from session config, per-prompt overrides, and engine defaults.
4. Discover context files (ION.md, CLAUDE.md) from the working directory.
5. Fire `context_inject` hook for extension-provided context.
6. Inject git context from the working directory.
7. Fire `before_agent_start` for system prompt injection.
8. Wire extension hooks (tool_call, turn, compaction, permission, file_changed, workspace_file_changed).
9. Wire MCP tools and agent spawner.
10. Emit `engine_status` with state `running`.
11. Call `backend.StartRun()`.

### System Message Injection

During the agent loop, the engine may inject internal user-role messages for LLM steering:

| Type | When | Default text |
|------|------|-------------|
| Plan mode reminder | Turn 2+ in plan mode | `[SYSTEM] Plan mode still active...` |
| Turn limit warning | 2 turns before `maxTurns` | `[SYSTEM] You are approaching your turn limit...` |
| Max token continue | `max_tokens` stop reason | `Continue from where you left off.` |

These messages are hookable via [`system_inject`](../hooks/reference.md#system-message-injection-1), individually disableable via `limits.disable*` flags, and suppressible from persistence via `limits.suppressSystemMessages`. See [System Message Control](../configuration/limits.md#system-message-control) for full details.

### Per-prompt overrides

Clients can override these fields per prompt without changing the session config:

| Field | Description |
|-------|-------------|
| `Model` | Use a different model for this prompt only |
| `MaxTurns` | Limit tool loop iterations |
| `MaxBudgetUsd` | Cost cap for this run |
| `ExtensionDir` | Load an extension for this prompt (if session has none) |
| `NoExtensions` | Skip extension hooks for this prompt |

### Prompt queue

When a run is active, new prompts enter a FIFO queue. The queue holds up to 32 prompts. Exceeding the limit returns an error to the client.

After a run completes (`handleRunExit`), the manager dequeues the next prompt and dispatches it in a goroutine. This means queued prompts execute sequentially with no gap.

## Run completion (handleRunExit)

When a backend run exits:

1. Clear the session's active request ID.
2. Mark all sub-agents terminal (done/error/cancelled) in the registry — see [Agent State Contract](../architecture/agent-state.md).
3. Store the conversation/session ID returned by the backend.
4. Emit `engine_agent_state` with the final snapshot. When no agents remain live, the snapshot is `agents: []`. Consumers replace their local view with whatever the engine reports.
5. Emit `engine_status` with state `idle`.
6. If the exit code is non-zero or a signal was received, emit `engine_dead`.
7. Dequeue and dispatch the next pending prompt if one exists.

## Stop (StopSession)

`StopSession(key)` tears down the session:

1. Cancel the active run if one exists.
2. Drop all pending prompts from the queue.
3. Kill child processes (SIGTERM, escalate to SIGKILL after 5 seconds).
4. Stop the tool server if one is running.
5. Fire `session_end` hook on the extension.
6. Dispose the extension host (kills subprocess).
7. Close MCP connections.
8. Flush telemetry.
9. Close the session recorder.
10. Emit `engine_dead`.

## Plan Mode

### Plan ID lifetime

When plan mode is enabled and a prompt is sent, the engine allocates a `planFilePath` for the session:

- **CLI / hybrid backends:** `<project>/.ion/plans/<hash>.md`
- **API backend:** `~/.ion/plans/<hash>.md`

The plan ID is **preserved** across plan-mode toggles. Toggling plan mode off — via the dropdown, keyboard shortcut, or any client command — does not retire the ID. When plan mode is re-enabled on the same session, the engine reuses the same plan file.

The plan ID is only retired when the engine **session itself is replaced**. On the desktop this happens when the user clicks Implement, which calls `resetTabSession()` and creates a fresh engine session. The next plan-mode enable then allocates a new hash.

On re-entry (plan mode re-enabled after a prior exit within the same session), `SendPrompt` sets `PlanModeReentry=true` on the run options. The plan-mode system prompt is prepended with reentry guidance that instructs the LLM to read the existing plan before making changes.

### Plan mode prose overrides

The engine's plan-mode framing — both the full system prompt injected at run start and the sparse reminder injected periodically during the run — can be overridden at three levels, in decreasing priority:

1. **`RunOptions.PlanModePrompt` / `RunOptions.PlanModeSparseReminder`** (per-prompt, highest priority)
   Set on each `send_prompt` dispatch via the `planModePrompt` and `planModeSparseReminder` fields in the [client command](../protocol/client-commands.md#send_prompt). When non-empty, the engine uses these strings verbatim. When empty, the engine falls through to the next layer.

2. **`plan_mode_prompt` SDK hook** (per-extension)
   Extensions can return a `PlanModePromptResult{Prompt, Tools, SparseReminder}` from the `plan_mode_prompt` hook. `Prompt` replaces the full prompt; `Tools` overrides the allowed tool list; `SparseReminder` overrides the per-turn reminder text. Empty fields inherit the engine default. See [`plan_mode_prompt`](../hooks/reference.md#plan-mode-3) for the hook reference. The hook only fires when `RunOptions.PlanModePrompt` is empty (i.e. the RunOptions layer did not override).

3. **Engine defaults** (lowest priority)
   `buildPlanModePrompt(planFilePath, planFileExists)` builds the full prompt; `buildPlanModeSparseReminder(planFilePath)` builds the per-turn reminder. Both include the end-of-turn discipline text (`AskUserQuestion` or `ExitPlanMode`) and the Forbidden Prose Patterns callout. These are the values used when no override is set at any layer.

The desktop ships its reference prose as `ENTER_PLAN_MODE_DESCRIPTION` (full prompt framing for `EnterPlanMode` tool), and forwards `PLAN_MODE_SPARSE_REMINDER` as the sparse-reminder override on every engine-tab and CLI prompt dispatch (see `desktop/src/main/prompt-pipeline.ts`). Third-party harnesses set their own values or omit these fields to inherit the engine defaults.

Power users can customize the desktop's defaults via `~/.ion/settings.json` `desktop.*` keys — see the [desktop power-user overrides](../configuration/settings-json.md) section.

Per [ADR-004](../architecture/adr/004-enter-plan-mode-prose-in-harness.md): the engine provides the mechanism (prompt builder, sparse-reminder injection, hook firing), the harness provides the policy (what the prose says). The three-layer precedence is symmetric between `PlanModePrompt` and `PlanModeSparseReminder` by design.

### Model-initiated plan-mode entry

In auto mode the engine injects the [`EnterPlanMode`](../tools/reference.md#enterplanmode) sentinel tool so the model can request a plan-mode transition mid-conversation.

When the model calls `EnterPlanMode`:

1. The engine fires the [`before_plan_mode_enter`](../hooks/reference.md#plan-mode-3) hook. Extensions can veto by returning `Allow: &false`. Default is auto-approve.
2. If denied, the run continues in auto mode and the denial reason is returned to the model as the tool result.
3. If allowed, the session flips to plan mode and the run **continues** (unlike `ExitPlanMode`, which terminates the run). The plan-mode framing is returned as the tool result so the model sees it immediately.
4. The desktop and iOS UI reflect the transition via `engine_plan_mode_changed{enabled: true}`.

### Model-initiated plan-mode exit

When the model calls `ExitPlanMode` to signal the plan is ready for review:

1. The engine fires the [`before_plan_mode_exit`](../hooks/reference.md#plan-mode-3) hook with the plan file path. Extensions can veto by returning `Allow: &false` with a `Reason` that is returned to the model (e.g. "plan is too short, add verification steps"). Default is auto-approve.
2. If denied, the run **continues** in plan mode. The model receives the denial reason and can continue planning.
3. If allowed, the engine records a `PermissionDenial` (so the run-end signal carries the exit context on `task_complete.permissionDenials`) and emits the typed `engine_plan_proposal{kind: "exit", planFilePath, planSlug}` workflow event. The run then terminates.
4. The engine does **not** emit `engine_plan_mode_changed{enabled: false}` at this point. The model's `ExitPlanMode` call is a *proposal*, not a confirmed state transition — the mode does not actually change until the consumer's user-approval chokepoint (e.g. the desktop's Implement button) approves the exit and calls `SetPlanMode(false)`, which then fires `engine_plan_mode_changed{enabled: false}` as a state event.

### Auto-exit safety net

In long-running or large-context plan-mode runs, the model occasionally ends its final turn with `end_turn` / `stop` without invoking `ExitPlanMode` — it may call `Bash` with an echo, emit a text-only turn, or call a different tool entirely. The run completes cleanly, the plan file exists on disk, but the session is parked in plan mode with no approval card surfaced to the user.

Per [ADR-007](../architecture/adr/007-plan-mode-auto-exit.md), the engine deterministically synthesizes an `ExitPlanMode` call whenever a plan-mode run terminates with stop reason `end_turn` or `stop` and the final assistant turn contains no `ExitPlanMode` or `AskUserQuestion` tool_use.

**Synthesis sequence:**

1. The engine fires the [`before_plan_mode_auto_exit`](../hooks/reference.md#plan-mode-3) hook with `{SessionID, RunID, StopReason, PlanFilePath, AssistantText, EmittedTools}`. Extensions can suppress synthesis (`Suppress: true`) or override the `PlanFilePath` or `Reason` on the approval card. Last writer wins per field across handlers.
2. If not suppressed, the engine emits `engine_plan_mode_auto_exit` — a typed event that lets consumers distinguish engine-synthesized exits from model-driven ones.
3. The engine then emits `engine_plan_proposal{kind: "exit", planFilePath, planSlug}` via the same path as a model-driven exit, so existing consumers render the approval card unchanged.
4. `TaskCompleteEvent` carries the synthetic `PermissionDenial` in `permissionDenials`. The `ToolUseID` is engine-generated (`synth-exit-plan-{runID}-t{turn}-{ns}`); the `ToolInput` carries `{synthesized: true}` so consumers that correlate denial IDs against provider logs can detect the synthetic origin.

**Configuration** follows the same three-layer precedence as [ADR-002](../architecture/adr/002-engine-vs-harness-early-stop.md):

| Layer | Field | Default |
|-------|-------|---------|
| `engine.json` | `limits.planModeAutoExitOnEndTurn` | `true` |
| `RunOptions` | `planModeAutoExit` (`*bool`) | `nil` (inherit config) |
| Extension SDK | `before_plan_mode_auto_exit` hook | no opinion (allow by default) |

The safety net is **on by default**. A run that gets stuck without it is strictly worse than the (cheap, idempotent) synthesis. Harnesses with automation policies that should treat a missing `ExitPlanMode` as an error condition can set `planModeAutoExitOnEndTurn: false` in `engine.json`, set `PlanModeAutoExit: &false` on `RunOptions`, or return `Suppress: true` from the hook.

> **Note:** The synthesis fires only when the preconditions all hold: the run is in plan mode, the final turn has stop reason `end_turn` / `stop`, no `ExitPlanMode` or `AskUserQuestion` tool_use appears in the final turn, and a plan file path is resolvable. Multi-turn runs in the middle of investigation end with stop reason `tool_use` and are unaffected.

### State events vs workflow events

The plan-mode lifecycle is the canonical example of [ADR-003](../architecture/adr/003-state-events-vs-workflow-events.md)'s split between state-machine notifications and workflow proposals:

- **`engine_plan_mode_changed`** — fires only on confirmed state transitions (harness `SetPlanMode`, run start with `PlanMode: true`, plan-mode abort, user-approval chokepoint). Carries `planModeEnabled` so consumers can mirror the engine's current mode.
- **`engine_plan_proposal{kind: "exit"}`** — fires when the model proposes an exit by calling `ExitPlanMode`. Does **not** change the engine's mode; the consumer is responsible for deciding whether to call `SetPlanMode(false)` based on user input.

Consumers should listen for both events with distinct handlers: one updates cached mode state, the other surfaces the approval UI. The two events never produce conflicting state transitions because only `engine_plan_mode_changed` is authoritative about the engine's actual mode.

### Extension-initiated plan-mode control

Extensions have full imperative control over plan mode via the `Context` object passed to every hook handler:

```typescript
// Enter plan mode from a slash command or hook handler
ctx.setSessionPlanMode(true, "slash_command")

// Exit plan mode programmatically
ctx.setSessionPlanMode(false, "extension")

// Read current state — useful for conditional logic
const { enabled, planFilePath } = ctx.getPlanMode()
if (enabled) {
  // currently in plan mode; planFilePath is the active plan file
}
```

`setSessionPlanMode` applies the same plan-ID-preservation semantics as a manual toggle: disabling keeps the `planFilePath` alive so a subsequent re-enable reuses it. The plan ID is only retired when the session is reset.

`getPlanMode` returns the current `(enabled, planFilePath)` state at the time of the call. The path is non-empty whenever a plan file has been allocated for the session, even if plan mode is currently off.

## Event flow diagram

```
StartSession
  -> engine_status(idle)

SendPrompt
  -> engine_status(running)
  -> engine_text_delta (streaming)
  -> engine_tool_start / engine_tool_end (tool use)
  -> engine_message_end (usage stats)
  -> engine_status(idle)

StopSession
  -> engine_dead
```

## Error handling

Backend errors during a run emit `engine_error` events. The session remains alive after an error. If the backend process dies (non-zero exit code or signal), the session emits `engine_dead` and the client should consider the session unusable.
