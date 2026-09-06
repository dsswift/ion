package session

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// newCliShellTestManager builds a manager whose backend is a real
// ClaudeCodeBackend, which is what mcpCapableCli keys on, plus a started
// session. The backend never spawns a process here — NewClaudeCodeBackend only
// allocates maps; a subprocess appears at StartRun, which these tests do not
// call.
func newCliShellTestManager(t *testing.T, key string) *Manager {
	t.Helper()
	mgr := NewManager(backend.NewClaudeCodeBackend())
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) })
	return mgr
}

func sessionToolServer(t *testing.T, mgr *Manager, key string) *backend.ToolServer {
	t.Helper()
	mgr.mu.RLock()
	defer mgr.mu.RUnlock()
	s, ok := mgr.sessions[key]
	if !ok {
		t.Fatalf("session %q not found", key)
	}
	return s.toolServer
}

// TestCliShellTools_RegisteredOnToolServer pins that a delegated claude-code run
// is offered the engine's shell and async tools. Without them the model has no
// background command that outlives the turn, which is the whole defect: the CLI
// advertises its own, promises a completion notice, and the subprocess dies
// before it can deliver one.
func TestCliShellTools_RegisteredOnToolServer(t *testing.T) {
	key := "cli-shell-register"
	mgr := newCliShellTestManager(t, key)
	opts := &types.RunOptions{ProjectPath: t.TempDir()}

	mgr.wireCliShellToolServer(sessionFor(t, mgr, key), key, opts, nil)

	ts := sessionToolServer(t, mgr, key)
	if ts == nil {
		t.Fatal("no ToolServer was created for the CLI run")
	}
	for _, name := range cliShellToolNames {
		if !ts.HasTool(name) {
			t.Errorf("tool %q not registered on the ToolServer", name)
		}
	}
}

// TestCliShellTools_AliasDirectiveNamesEveryTool pins that the model is told the
// MCP-prefixed name for each bridged tool. The CLI only ever sees
// mcp__ion-extensions__Bash; a directive that omits a tool leaves the model
// unable to call something it can see in its tool list.
func TestCliShellTools_AliasDirectiveNamesEveryTool(t *testing.T) {
	key := "cli-shell-directive"
	mgr := newCliShellTestManager(t, key)
	opts := &types.RunOptions{ProjectPath: t.TempDir()}

	mgr.wireCliShellToolServer(sessionFor(t, mgr, key), key, opts, nil)

	for _, name := range cliShellToolNames {
		want := "mcp__" + backend.McpServerName + "__" + name
		if !strings.Contains(opts.AppendSystemPrompt, want) {
			t.Errorf("append-system-prompt does not name %q:\n%s", want, opts.AppendSystemPrompt)
		}
	}
}

// TestCliShellTools_PlanModeSpawnGetsNoShell pins the read-only boundary. A run
// that spawns in plan mode has no shell today, because cliPlanModeDisallowedTools
// strips the CLI's Bash; bridging the engine's would hand a plan run the exact
// capability that boundary removes.
func TestCliShellTools_PlanModeSpawnGetsNoShell(t *testing.T) {
	key := "cli-shell-plan"
	mgr := newCliShellTestManager(t, key)
	opts := &types.RunOptions{ProjectPath: t.TempDir(), PlanMode: true}

	mgr.wireCliShellToolServer(sessionFor(t, mgr, key), key, opts, nil)

	if ts := sessionToolServer(t, mgr, key); ts != nil && ts.HasTool("Bash") {
		t.Error("a plan-mode spawn was given a shell")
	}
}

// TestCliShellTools_NotifyingBashJoinsOutstandingSet is the regression test for
// the reported bug. A background command started with notify_on_complete must
// land on the session's outstanding set — that set is the only thing that makes
// the turn boundary park instead of completing, and a park is the only reason a
// completion ever reaches the model.
//
// Revert-check: drop WithOutstandingRegistrar from cliToolContextStamper and the
// command still runs, still writes its output file, and still reports success —
// and this assertion goes red, because nothing is tracking it. That is exactly
// the production shape: the work happens, the session completes anyway, and the
// operator types "continue".
func TestCliShellTools_NotifyingBashJoinsOutstandingSet(t *testing.T) {
	key := "cli-shell-notify"
	mgr := newCliShellTestManager(t, key)
	dir := t.TempDir()

	ctx := mgr.cliToolContextStamper(sessionFor(t, mgr, key), key)(context.Background())
	res, err := tools.ExecuteTool(ctx, "Bash", map[string]any{
		"command":            "echo notifying",
		"run_in_background":  true,
		"notify_on_complete": true,
	}, dir)
	if err != nil {
		t.Fatalf("Bash: %v", err)
	}
	if res.IsError {
		t.Fatalf("Bash reported an error: %s", res.Content)
	}

	outstanding := mgr.OutstandingBackgroundTaskIDs(key)
	if len(outstanding) != 1 {
		t.Fatalf("outstanding = %v, want exactly the one notifying command", outstanding)
	}
	if outstanding[0] != res.BackgroundTaskID {
		t.Errorf("outstanding holds %q, want the started task %q", outstanding[0], res.BackgroundTaskID)
	}
}

// TestCliShellTools_NonNotifyingBashStaysUntracked pins the other side of the
// branch: a fire-and-forget background command must NOT hold the session open.
// Tracking it would park every turn that ever started a detached command and
// wait for something the model never asked to be told about.
func TestCliShellTools_NonNotifyingBashStaysUntracked(t *testing.T) {
	key := "cli-shell-no-notify"
	mgr := newCliShellTestManager(t, key)
	dir := t.TempDir()

	ctx := mgr.cliToolContextStamper(sessionFor(t, mgr, key), key)(context.Background())
	res, err := tools.ExecuteTool(ctx, "Bash", map[string]any{
		"command":           "echo detached",
		"run_in_background": true,
	}, dir)
	if err != nil {
		t.Fatalf("Bash: %v", err)
	}
	if res.IsError {
		t.Fatalf("Bash reported an error: %s", res.Content)
	}

	if outstanding := mgr.OutstandingBackgroundTaskIDs(key); len(outstanding) != 0 {
		t.Fatalf("outstanding = %v, want empty for a non-notifying command", outstanding)
	}
}

// TestCliShellTools_BashOwnedBySession pins that a bridged shell command is
// attributed to its session, which is what StopSession uses to kill the
// session's processes. An unowned background command outlives the conversation
// that started it.
func TestCliShellTools_BashOwnedBySession(t *testing.T) {
	key := "cli-shell-owner"
	mgr := newCliShellTestManager(t, key)

	ctx := mgr.cliToolContextStamper(sessionFor(t, mgr, key), key)(context.Background())
	if got := tools.BackgroundTaskOwnerFromContext(ctx); got != key {
		t.Fatalf("background-task owner = %q, want %q", got, key)
	}
}

// TestCliShellTools_TaskToolsReportedAvailable pins that the bridged context
// tells the Bash tool the task tools are reachable. They are registered on the
// MCP ToolServer and deliberately not in the global registry, so the registry
// probe that serves an API run answers "no" here and the model would be told to
// read an output file when TaskGet is one call away.
func TestCliShellTools_TaskToolsReportedAvailable(t *testing.T) {
	key := "cli-shell-tasktools"
	mgr := newCliShellTestManager(t, key)

	ctx := mgr.cliToolContextStamper(sessionFor(t, mgr, key), key)(context.Background())
	if !tools.TaskToolsAvailable(ctx) {
		t.Fatal("task tools reported unavailable on a bridged CLI context")
	}
	if tools.TaskToolsAvailable(context.Background()) {
		t.Fatal("task tools reported available on an unstamped context with an empty registry")
	}
}

func sessionFor(t *testing.T, mgr *Manager, key string) *engineSession {
	t.Helper()
	mgr.mu.RLock()
	defer mgr.mu.RUnlock()
	s, ok := mgr.sessions[key]
	if !ok {
		t.Fatalf("session %q not found", key)
	}
	return s
}

// TestCliShellTools_ParkSeamsReportBridgedWork closes the loop between the
// bridged shell and the turn boundary. A command started through the engine's
// Bash must be visible to the backend through the RunOptions seams, because
// that read is the entire input to the park decision
// (backend.parkDelegatedRun). Registration that the backend cannot see parks
// nothing.
//
// Revert-check: leave opts.OutstandingBackgroundTasks nil and the seam reports
// nothing, the run completes with work in flight, and the completion arrives at
// an idle session with no park to claim — the reported bug, exactly.
func TestCliShellTools_ParkSeamsReportBridgedWork(t *testing.T) {
	key := "cli-shell-seams"
	mgr := newCliShellTestManager(t, key)
	opts := &types.RunOptions{ProjectPath: t.TempDir()}
	s := sessionFor(t, mgr, key)

	mgr.wireCliShellToolServer(s, key, opts, nil)
	if opts.OutstandingBackgroundTasks == nil || opts.OutstandingPolls == nil {
		t.Fatal("park seams were not wired onto RunOptions")
	}
	if got := opts.OutstandingBackgroundTasks(); len(got) != 0 {
		t.Fatalf("seam reports %v before anything started, want empty", got)
	}

	ctx := mgr.cliToolContextStamper(s, key)(context.Background())
	res, err := tools.ExecuteTool(ctx, "Bash", map[string]any{
		"command":            "echo seam-check",
		"run_in_background":  true,
		"notify_on_complete": true,
	}, opts.ProjectPath)
	if err != nil {
		t.Fatalf("Bash: %v", err)
	}
	if res.IsError {
		t.Fatalf("Bash reported an error: %s", res.Content)
	}

	// The seam is read LIVE at the turn boundary, which is why it is a function:
	// the command started after the run did.
	got := opts.OutstandingBackgroundTasks()
	if len(got) != 1 || got[0] != res.BackgroundTaskID {
		t.Fatalf("seam reports %v, want the task started during the run (%s)", got, res.BackgroundTaskID)
	}
}

// TestCliShellTools_PlanModeStillWiresParkSeams pins that a plan-mode spawn
// keeps its park seams even though it gets no shell. A plan run can be holding
// commands an earlier auto turn started; completing it while they run would
// abandon them for the same reason the shell-bearing case does.
func TestCliShellTools_PlanModeStillWiresParkSeams(t *testing.T) {
	key := "cli-shell-plan-seams"
	mgr := newCliShellTestManager(t, key)
	opts := &types.RunOptions{ProjectPath: t.TempDir(), PlanMode: true}

	mgr.wireCliShellToolServer(sessionFor(t, mgr, key), key, opts, nil)

	if opts.OutstandingBackgroundTasks == nil || opts.OutstandingPolls == nil {
		t.Fatal("a plan-mode spawn must still be able to park on work already in flight")
	}
	mgr.registerOutstandingBackgroundTask(key, "bash-earlier", "make build")
	if got := opts.OutstandingBackgroundTasks(); len(got) != 1 || got[0] != "bash-earlier" {
		t.Fatalf("plan-mode seam reports %v, want [bash-earlier]", got)
	}
}

// TestCliShellTools_EveryBridgedToolIsPolicyChecked is the regression test for
// the guard the registration is supposed to apply. A deny policy must stop all
// four bridged tools before they execute — not just Bash.
//
// Poll is the one that made this necessary: its check_command is an arbitrary
// shell string the engine runs before every attempt, so an unguarded Poll is a
// second, unpoliced shell standing beside the policed one.
//
// The call goes through the ToolServer rather than the guard directly, because
// the defect being pinned is a REGISTRATION that forgot its wrapper. Invoking
// the handler the server actually holds is the only way to see that; HasTool
// would stay green with every guard removed.
//
// Revert-check: drop guardBridgedTool from any one RegisterTool call and that
// tool executes under a deny policy — this goes red naming it.
func TestCliShellTools_EveryBridgedToolIsPolicyChecked(t *testing.T) {
	key := "cli-shell-policy"
	mgr := newCliShellTestManager(t, key)
	opts := &types.RunOptions{ProjectPath: t.TempDir()}
	denyAll := permissions.NewEngine(&types.PermissionPolicy{Mode: "deny"})

	mgr.wireCliShellToolServer(sessionFor(t, mgr, key), key, opts, denyAll)
	ts := sessionToolServer(t, mgr, key)

	// One input per tool that would do real work if the guard were missing.
	inputs := map[string]map[string]interface{}{
		"Bash":     {"command": "echo unguarded"},
		"Poll":     {"intent": "watch something", "check_command": "echo unguarded"},
		"TaskGet":  {"taskId": "bash-nonexistent"},
		"TaskStop": {"taskId": "bash-nonexistent"},
	}
	for _, name := range cliShellToolNames {
		input, ok := inputs[name]
		if !ok {
			t.Fatalf("no probe input for bridged tool %q — add one when the set grows", name)
		}
		res, found, err := ts.InvokeTool(context.Background(), name, input)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !found {
			t.Fatalf("%s is not registered on the ToolServer", name)
		}
		if !res.IsError || !strings.Contains(res.Content, "Permission denied for "+name) {
			t.Errorf("%s ran under a deny policy: IsError=%v content=%q", name, res.IsError, res.Content)
		}
	}
}

// TestCliShellTools_NilPolicyEngineDoesNotBlock pins the other arm. No policy
// configured means no policy enforced, which is what the engine does
// everywhere else — a guard that refused on a nil engine would break every
// default conversation.
func TestCliShellTools_NilPolicyEngineDoesNotBlock(t *testing.T) {
	key := "cli-shell-nilpolicy"
	mgr := newCliShellTestManager(t, key)
	opts := &types.RunOptions{ProjectPath: t.TempDir()}

	mgr.wireCliShellToolServer(sessionFor(t, mgr, key), key, opts, nil)
	ts := sessionToolServer(t, mgr, key)

	res, found, err := ts.InvokeTool(context.Background(), "Bash", map[string]interface{}{"command": "echo allowed"})
	if err != nil {
		t.Fatalf("Bash: %v", err)
	}
	if !found {
		t.Fatal("Bash is not registered on the ToolServer")
	}
	if res.IsError {
		t.Fatalf("Bash refused with no permission engine configured: %s", res.Content)
	}
	if !strings.Contains(res.Content, "allowed") {
		t.Errorf("Bash did not run: %q", res.Content)
	}
}
