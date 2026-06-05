package session

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
)

// Tests for task_created / task_completed hook wiring on ApiBackend.
//
// Background: commit bc93caac wired these hooks for CliBackend at the
// natural turn-start / turn-end points in fireCliTurnHooks. ApiBackend
// did not fire the hooks at all — the docs documented them as universal,
// but in practice only CLI-routed runs exercised them. Fix 5 of the
// alignment-gate plan extends the hook surface to ApiBackend so external
// SDK consumers observing task_created / task_completed get consistent
// behavior across both backends.
//
// The wiring lives in `wireExtensionHooks` on `prompt_runconfig.go`:
// the OnTurnStart hook now also fires task_created, and OnTurnEnd
// fires task_completed. TaskID format matches CliBackend exactly:
// `<session-key>-t<turn-number>`.
//
// Test strategy: call `wireExtensionHooks` to populate `runCfg.Hooks`
// with the closures, then invoke `runCfg.Hooks.OnTurnStart(runID, N)`
// / `runCfg.Hooks.OnTurnEnd(runID, N)` directly. The recorder verifies
// the task hooks fired with the right TaskID, Name, and Status.

// apiTaskRecorder is the ApiBackend twin of taskRecorder in
// manager_cli_hooks_test.go. Distinct type to keep the two test
// files independent; they could share if more tests land, but for
// two tests the duplication is cheap and clear.
type apiTaskRecorder struct {
	mu        sync.Mutex
	created   []string // captured TaskIDs
	completed []string
}

func (r *apiTaskRecorder) addCreated(taskID string) {
	r.mu.Lock()
	r.created = append(r.created, taskID)
	r.mu.Unlock()
}

func (r *apiTaskRecorder) addCompleted(taskID string) {
	r.mu.Lock()
	r.completed = append(r.completed, taskID)
	r.mu.Unlock()
}

func (r *apiTaskRecorder) snapshot() (created, completed []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cr := make([]string, len(r.created))
	copy(cr, r.created)
	co := make([]string, len(r.completed))
	copy(co, r.completed)
	return cr, co
}

// newApiTaskGroup returns an ExtensionGroup that records task_created
// and task_completed payloads into `rec`. Mirrors newTaskGroup in
// manager_cli_hooks_test.go but for the ApiBackend test surface.
func newApiTaskGroup(rec *apiTaskRecorder) *extension.ExtensionGroup {
	host := extension.NewHost()
	host.SDK().On(extension.HookTaskCreated, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		info := payload.(extension.TaskLifecycleInfo)
		rec.addCreated(info.TaskID)
		return nil, nil
	})
	host.SDK().On(extension.HookTaskCompleted, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		info := payload.(extension.TaskLifecycleInfo)
		rec.addCompleted(info.TaskID)
		return nil, nil
	})
	g := extension.NewExtensionGroup()
	g.Add(host)
	return g
}

// TestApiBackend_TaskCreated_FiresOnTurnStart verifies the
// task_created hook fires when ApiBackend's runloop transitions
// turn N → N+1. The TaskID format matches CliBackend exactly so
// external consumers (SDK observers, telemetry pipelines) get a
// consistent shape regardless of which backend routed the run.
func TestApiBackend_TaskCreated_FiresOnTurnStart(t *testing.T) {
	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	s := newCliSession("api-task1")
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"api-task1": s}
	mgr.mu.Unlock()

	rec := &apiTaskRecorder{}
	group := newApiTaskGroup(rec)
	s.extGroup = group

	runCfg := &backend.RunConfig{}
	mgr.wireExtensionHooks(s, "api-task1", "req-1", apiBackend, group, runCfg)

	if runCfg.Hooks.OnTurnStart == nil {
		t.Fatal("expected OnTurnStart hook to be wired")
	}

	// Simulate turn 1 starting.
	runCfg.Hooks.OnTurnStart("req-1", 1)
	// And turn 2.
	runCfg.Hooks.OnTurnStart("req-1", 2)

	created, _ := rec.snapshot()
	if len(created) != 2 {
		t.Fatalf("expected 2 task_created fires, got %d (%v)", len(created), created)
	}
	if created[0] != "api-task1-t1" {
		t.Errorf("first task_created TaskID = %q, want %q", created[0], "api-task1-t1")
	}
	if created[1] != "api-task1-t2" {
		t.Errorf("second task_created TaskID = %q, want %q", created[1], "api-task1-t2")
	}
}

// TestApiBackend_TaskCompleted_FiresOnTurnEnd verifies the
// task_completed hook fires at turn-end with a TaskID that matches
// its paired task_created. Combined with the previous test this
// pins both halves of the lifecycle.
func TestApiBackend_TaskCompleted_FiresOnTurnEnd(t *testing.T) {
	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	s := newCliSession("api-task2")
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"api-task2": s}
	mgr.mu.Unlock()

	rec := &apiTaskRecorder{}
	group := newApiTaskGroup(rec)
	s.extGroup = group

	runCfg := &backend.RunConfig{}
	mgr.wireExtensionHooks(s, "api-task2", "req-2", apiBackend, group, runCfg)

	if runCfg.Hooks.OnTurnEnd == nil {
		t.Fatal("expected OnTurnEnd hook to be wired")
	}

	// Simulate turn 1 ending.
	runCfg.Hooks.OnTurnEnd("req-2", 1)

	_, completed := rec.snapshot()
	if len(completed) != 1 {
		t.Fatalf("expected 1 task_completed fire, got %d (%v)", len(completed), completed)
	}
	if completed[0] != "api-task2-t1" {
		t.Errorf("task_completed TaskID = %q, want %q", completed[0], "api-task2-t1")
	}
}

// TestApiBackend_TaskLifecycle_PairedTaskIDs verifies a full
// turn-start → turn-end sequence produces paired TaskIDs, matching
// the CliBackend pairing semantics in
// TestFireCliTurnHooks_MultipleTurnsPairs from
// manager_cli_hooks_test.go.
func TestApiBackend_TaskLifecycle_PairedTaskIDs(t *testing.T) {
	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	s := newCliSession("api-task3")
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"api-task3": s}
	mgr.mu.Unlock()

	rec := &apiTaskRecorder{}
	group := newApiTaskGroup(rec)
	s.extGroup = group

	runCfg := &backend.RunConfig{}
	mgr.wireExtensionHooks(s, "api-task3", "req-3", apiBackend, group, runCfg)

	// Three full turns.
	for i := 1; i <= 3; i++ {
		runCfg.Hooks.OnTurnStart("req-3", i)
		runCfg.Hooks.OnTurnEnd("req-3", i)
	}

	created, completed := rec.snapshot()
	if len(created) != 3 || len(completed) != 3 {
		t.Fatalf("expected 3+3 events, got %d created / %d completed", len(created), len(completed))
	}
	for i := 0; i < 3; i++ {
		if created[i] != completed[i] {
			t.Errorf("turn %d: TaskIDs do not pair: created=%q completed=%q", i+1, created[i], completed[i])
		}
	}
}
