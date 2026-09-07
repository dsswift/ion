package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// prompt_cli_shell_tools.go bridges the engine's shell and its async primitives
// into a delegated claude-code run.
//
// # Why the engine's shell and not the CLI's
//
// The CLI owns a perfectly good shell. What it cannot own is a background
// command that outlives the turn. Its background tasks live in the subprocess,
// and the subprocess exits when the turn ends: the promised completion notice
// never arrives, and the command itself is torn down mid-run. The engine's
// background shell runs in the engine process, registers on the session's
// outstanding set, and reaches the model through the same park-and-wake cycle
// an API run uses (ADR-023) — a cycle that is already backend-agnostic, because
// a park is expressed on the event stream and the wake is an injected prompt.
//
// So a second shell is added at the layer that survives the turn. The CLI keeps
// its own — foreground work is not broken and the native tool is what the model
// reaches for by reflex. The two are kept apart by the PreToolUse gate
// (backend/cli_async_gate.go), which refuses the native tool's background MODE
// and names this one, so the model never has to guess which shell to use.
//
// # Scope: claude-code only
//
// The gate rides the CLI's PreToolUse hook, which is claude-code's. An ACP
// backend (grok, cursor) has no equivalent seam, so bridging this shell there
// would leave the model holding two shells with no rule to tell them apart. The
// ACP backends carry the same underlying gap; closing it needs their own hook,
// not this one.

// cliShellToolNames are the engine tools bridged to a delegated claude-code run,
// in registration order. Kept as one list so the alias directive, the logging,
// and the test that pins the set all read from the same place.
var cliShellToolNames = []string{"Bash", "Poll", "TaskGet", "TaskStop"}

// wireCliShellToolServer registers the engine's shell and async tools on the
// per-session ToolServer for a delegated claude-code run.
//
// No-op for every other backend, and for a run that SPAWNS in plan mode: a plan
// spawn has no shell today (cliPlanModeDisallowedTools strips the CLI's Bash)
// and this must not hand one back. A run that spawns in auto mode and enters
// plan mode mid-subprocess keeps the tools it spawned with, exactly as it keeps
// the CLI's native tool list — --disallowedTools is fixed at spawn.
//
// Runs AFTER wireAgentToolServer, which has already created, started, and
// attached the ToolServer for a CLI run, so the common path only registers more
// tools on an existing server.
func (m *Manager) wireCliShellToolServer(s *engineSession, key string, opts *types.RunOptions, permEng *permissions.Engine) {
	kind, ok := mcpCapableCli(m.resolvedBackend(opts.Model))
	if !ok || kind != "claude-code" {
		utils.LogWithFields(utils.LevelDebug, "session", "cli shell tool wiring skipped (not claude-code)", map[string]any{
			"key": key, "kind": kind,
		})
		return
	}
	// Park seams first, and unconditionally for this backend. They are what let
	// the run end its turn without completing while work is still in flight, and
	// that decision is not about which tools THIS run was given: a plan-mode
	// spawn can still be holding commands a previous auto turn started.
	opts.OutstandingBackgroundTasks = func() []string {
		return m.OutstandingBackgroundTaskIDs(key)
	}
	opts.OutstandingPolls = func() []string {
		// Root-owned polls only, matching buildRunConfig: a dispatched child's
		// poll belongs to that dispatch and must not hold the root run open.
		return m.OutstandingPollIDsFor(key, "")
	}

	if opts.PlanMode {
		utils.LogWithFields(utils.LevelDebug, "session", "cli shell tool wiring skipped (plan-mode spawn is shell-free); park seams wired", map[string]any{
			"key": key,
		})
		return
	}

	m.mu.Lock()
	ts := s.toolServer
	m.mu.Unlock()

	needsStart := false
	if ts == nil {
		ts = backend.NewToolServer(key)
		needsStart = true
	}

	cwd := opts.ProjectPath
	stamp := m.cliToolContextStamper(s, key)

	bashDef := tools.BashTool()
	ts.RegisterTool("Bash", m.guardBridgedTool("Bash", permEng, key, buildCliEngineToolHandler(stamp, "Bash", cwd)), bashDef.Description, bashDef.InputSchema)

	// Poll is guarded for the same reason Bash is, and the reason is concrete:
	// its check_command is an arbitrary shell string the engine runs before each
	// attempt. An unguarded Poll would be a second, unpoliced shell standing
	// beside the policed one.
	pollDef := tools.PollTool()
	ts.RegisterTool("Poll", m.guardBridgedTool("Poll", permEng, key, buildCliEngineToolHandler(stamp, "Poll", cwd)), pollDef.Description, pollDef.InputSchema)

	// TaskGet and TaskStop are registered from their ToolDefs directly rather
	// than through the global registry. They are harness opt-in there
	// (tools/optional.go), and calling RegisterTaskTools to reach them here
	// would hand them to every API run on the machine as a side effect of
	// wiring one CLI session.
	taskGetDef := tools.TaskGetTool()
	ts.RegisterTool("TaskGet", m.guardBridgedTool("TaskGet", permEng, key, buildCliToolDefHandler(stamp, taskGetDef, cwd)), taskGetDef.Description, taskGetDef.InputSchema)
	taskStopDef := tools.TaskStopTool()
	ts.RegisterTool("TaskStop", m.guardBridgedTool("TaskStop", permEng, key, buildCliToolDefHandler(stamp, taskStopDef, cwd)), taskStopDef.Description, taskStopDef.InputSchema)

	if needsStart {
		if err := ts.Start(); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "toolserver start failed (cli shell tools)", map[string]any{"key": key, "kind": kind, "error": err.Error()})
			return
		}
		if err := m.attachToolServerMcp(opts, ts, key, kind); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "toolserver mcp attach failed (cli shell tools)", map[string]any{"key": key, "kind": kind, "error": err.Error()})
			ts.Stop()
			return
		}
		m.mu.Lock()
		s.toolServer = ts
		m.mu.Unlock()
	}

	directive := buildToolAliasDirective(cliShellToolNames, backend.McpServerName)
	appendDirective(opts, directive, cliShellToolNames)

	utils.LogWithFields(utils.LevelInfo, "session", "engine shell and async tools registered on ToolServer for CLI backend", map[string]any{
		"key": key, "kind": kind, "tools": cliShellToolNames, "cwd": cwd, "perm_engine": permEng != nil,
	})
}

// cliToolContextStamper returns the function that turns an MCP request context
// into an engine tool context.
//
// These are the same stamps the API run loop applies (runloop_tools.go) and they
// are what make the tools more than a remote shell:
//
//   - the background-task owner attributes a started command to this session, so
//     StopSession kills it (stop_types.go);
//   - the outstanding registrar is what lets a notify_on_complete command hold
//     the session open at the turn boundary — without it the command runs and
//     the session completes anyway, which is the defect this file exists to fix;
//   - the poll starter gives Poll a session to report back to;
//   - the timeouts config carries the sleep gate's threshold and the foreground
//     timeout ceiling;
//   - the task-tools flag tells the Bash tool that TaskGet is reachable here,
//     which a global-registry probe cannot see (tools/task_tools_available.go).
func (m *Manager) cliToolContextStamper(s *engineSession, key string) func(context.Context) context.Context {
	return func(ctx context.Context) context.Context {
		ctx = tools.WithBackgroundTaskOwner(ctx, key)
		ctx = tools.WithOutstandingRegistrar(ctx, func(taskID, command string) {
			m.registerOutstandingBackgroundTask(key, taskID, command)
		})
		// The MCP request context is deliberately not threaded into startPoll:
		// a poll outlives the tool call that started it, and cancelling it when
		// the call returns would end every poll the moment it began. Owner "":
		// the root run is not a dispatch, so it parks only on the polls it
		// started itself — the same argument buildRunConfig passes.
		ctx = tools.WithPollStarter(ctx, func(_ context.Context, request tools.PollRequest, cwd string) (string, error) {
			return m.startPoll(s, key, "", request, cwd)
		})
		ctx = tools.WithTaskToolsAvailable(ctx)
		if m.config != nil && m.config.Timeouts != nil {
			ctx = types.WithTimeouts(ctx, m.config.Timeouts)
		}
		return ctx
	}
}

// buildCliEngineToolHandler routes an MCP call to a tool in the global registry
// under the stamped context.
func buildCliEngineToolHandler(stamp func(context.Context) context.Context, name, cwd string) backend.ToolHandler {
	return func(ctx context.Context, input map[string]interface{}) (*types.ToolResult, error) {
		return tools.ExecuteTool(stamp(ctx), name, input, cwd)
	}
}

// buildCliToolDefHandler routes an MCP call straight to a ToolDef's Execute,
// bypassing the global registry. Used for the task tools, which are not
// registered globally.
func buildCliToolDefHandler(stamp func(context.Context) context.Context, def *types.ToolDef, cwd string) backend.ToolHandler {
	return func(ctx context.Context, input map[string]interface{}) (*types.ToolResult, error) {
		return def.Execute(stamp(ctx), input, cwd)
	}
}

// guardBridgedTool wraps a bridged tool handler with the session's permission
// check. Every tool this file puts on the ToolServer goes through it.
//
// # Why the handler, and not the CLI's PreToolUse hook
//
// Both rails can see a bridged call, and for a while both evaluated it. That is
// not defence in depth: on an "ask" policy the operator was asked twice for one
// command, with no way to tell the second prompt from a second command, and the
// audit trail carried two records for one decision.
//
// The handler is the rail that survives. When the hook settings file cannot be
// written (prompt_cli_hooks.go), the hook server is torn down while the
// permission engine stays live — the hook is absent exactly when something has
// already gone wrong, which is the worst moment to have no policy. The handler
// is also the only rail that exists for a tool the hook never sees. So the hook
// short-circuits names carrying the engine's MCP prefix (permission_hook_server.go)
// and this is where the decision is taken.
//
// A nil engine means no policy is configured and the call proceeds, which is
// what the engine does everywhere else.
func (m *Manager) guardBridgedTool(name string, permEng *permissions.Engine, key string, inner backend.ToolHandler) backend.ToolHandler {
	return func(ctx context.Context, input map[string]interface{}) (*types.ToolResult, error) {
		if decision, reason := m.checkBridgedToolPermission(ctx, permEng, key, name, input); decision == "deny" {
			return &types.ToolResult{
				Content: fmt.Sprintf("Permission denied for %s: %s", name, reason),
				IsError: true,
			}, nil
		}
		return inner(ctx, input)
	}
}

// newBridgedQuestionID mints the correlation ID a bridged permission prompt
// travels under, in the same shape and with the same entropy the claude-code
// hook server uses for its own prompts.
func newBridgedQuestionID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is not recoverable here and not worth failing the
		// tool call over: fall back to a time-derived ID, which is still unique
		// per prompt within a session because prompts are serialized by the
		// user answering them.
		utils.LogWithFields(utils.LevelWarn, "session", "crypto/rand unavailable for permission question id; using time-derived id", map[string]any{
			"error": err.Error(),
		})
		return fmt.Sprintf("bridged-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// checkBridgedToolPermission evaluates a bridged tool call against the session's
// permission policy, prompting the user when the policy says "ask". Returns the
// resolved decision ("allow" or "deny") and the reason behind it.
//
// The ask arm reuses permissionAskClosure — the same bridge the claude-code hook
// server and the codex approval path use — so a bridged tool's prompt is
// indistinguishable from any other permission prompt on the wire. It waits as
// long as the configured human-wait allows, indefinitely by default, and applies
// the configured fail-action on expiry. The request context is honored so a
// cancelled run does not leave the handler blocked on a human.
func (m *Manager) checkBridgedToolPermission(ctx context.Context, permEng *permissions.Engine, key, tool string, input map[string]interface{}) (decision, reason string) {
	if permEng == nil {
		return "allow", "no permission engine configured"
	}

	result := permEng.Check(permissions.CheckInfo{Tool: tool, Input: input})
	if result.Decision != "ask" {
		utils.LogWithFields(utils.LevelDebug, "session", "bridged tool permission resolved by policy", map[string]any{
			"key": key, "tool": tool, "decision": result.Decision, "layer": result.Layer,
		})
		return result.Decision, result.Reason
	}

	askFn := m.permissionAskClosure(key)
	questionID := newBridgedQuestionID()
	ch := askFn("", questionID, tool, "", input, []types.PermissionOpt{
		{ID: "allow", Label: "Allow"},
		{ID: "deny", Label: "Deny"},
		{ID: "allow_always", Label: "Allow always"},
	})
	if ch == nil {
		utils.LogWithFields(utils.LevelWarn, "session", "bridged tool permission ask could not register; allowing", map[string]any{
			"key": key, "tool": tool, "question_id": questionID,
		})
		return "allow", "permission prompt could not be registered"
	}

	var timerCh <-chan struct{}
	var timeouts *types.TimeoutsConfig
	if m.config != nil {
		timeouts = m.config.Timeouts
	}
	if d, finite := timeouts.HumanWait(); finite {
		done := make(chan struct{})
		timer := time.AfterFunc(d, func() { close(done) })
		defer timer.Stop()
		timerCh = done
	}

	select {
	case optionID := <-ch:
		if optionID == "deny" {
			utils.LogWithFields(utils.LevelInfo, "session", "bridged tool denied by user", map[string]any{
				"key": key, "tool": tool, "question_id": questionID,
			})
			return "deny", "denied by the user"
		}
		utils.LogWithFields(utils.LevelInfo, "session", "bridged tool allowed by user", map[string]any{
			"key": key, "tool": tool, "question_id": questionID, "option": optionID,
		})
		return "allow", "allowed by the user"
	case <-ctx.Done():
		// The subprocess or the run is gone; there is no longer anyone to
		// receive a decision. Refuse rather than run a command nobody approved.
		m.UnregisterPendingPermission(key, questionID)
		utils.LogWithFields(utils.LevelInfo, "session", "bridged tool permission abandoned (request cancelled)", map[string]any{
			"key": key, "tool": tool, "question_id": questionID,
		})
		return "deny", "the run was cancelled while awaiting approval"
	case <-timerCh:
		action := timeouts.PermissionTimeoutAction()
		m.UnregisterPendingPermission(key, questionID)
		utils.LogWithFields(utils.LevelInfo, "session", "bridged tool permission timed out, applying fail-action", map[string]any{
			"key": key, "tool": tool, "question_id": questionID, "action": action,
		})
		return action, "the approval request timed out"
	}
}
