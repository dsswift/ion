package session

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// Task lifecycle hook tests (task_created / task_completed)
// ---------------------------------------------------------------------------

// taskRecorder captures task_created and task_completed hook payloads.
type taskRecorder struct {
	mu        sync.Mutex
	created   []extension.TaskLifecycleInfo
	completed []extension.TaskLifecycleInfo
}

func (r *taskRecorder) recordCreated(info extension.TaskLifecycleInfo) {
	r.mu.Lock()
	r.created = append(r.created, info)
	r.mu.Unlock()
}

func (r *taskRecorder) recordCompleted(info extension.TaskLifecycleInfo) {
	r.mu.Lock()
	r.completed = append(r.completed, info)
	r.mu.Unlock()
}

func (r *taskRecorder) getCreated() []extension.TaskLifecycleInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]extension.TaskLifecycleInfo, len(r.created))
	copy(out, r.created)
	return out
}

func (r *taskRecorder) getCompleted() []extension.TaskLifecycleInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]extension.TaskLifecycleInfo, len(r.completed))
	copy(out, r.completed)
	return out
}

// newTaskGroup builds an ExtensionGroup whose task_created/task_completed
// hooks record into the returned taskRecorder.
func newTaskGroup(rec *taskRecorder) *extension.ExtensionGroup {
	host := extension.NewHost()
	host.SDK().On(extension.HookTaskCreated, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		info := payload.(extension.TaskLifecycleInfo)
		rec.recordCreated(info)
		return nil, nil
	})
	host.SDK().On(extension.HookTaskCompleted, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		info := payload.(extension.TaskLifecycleInfo)
		rec.recordCompleted(info)
		return nil, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)
	return group
}

func TestFireCliTurnHooks_TaskCreatedOnTextStart(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("task1")

	rec := &taskRecorder{}
	s.extGroup = newTaskGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"task1": s}
	mgr.mu.Unlock()

	// Text chunk starts a turn → task_created fires.
	mgr.fireCliTurnHooks(s, "task1", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "hello"},
	})
	// TaskComplete ends the run → task_completed fires.
	mgr.fireCliTurnHooks(s, "task1", true, types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{Result: "done"},
	})

	created := rec.getCreated()
	completed := rec.getCompleted()

	if len(created) != 1 {
		t.Fatalf("expected 1 task_created, got %d", len(created))
	}
	if created[0].TaskID != "task1-t1" {
		t.Errorf("task_created TaskID = %q, want %q", created[0].TaskID, "task1-t1")
	}
	if created[0].Status != "running" {
		t.Errorf("task_created Status = %q, want %q", created[0].Status, "running")
	}

	if len(completed) != 1 {
		t.Fatalf("expected 1 task_completed, got %d", len(completed))
	}
	if completed[0].TaskID != "task1-t1" {
		t.Errorf("task_completed TaskID = %q, want %q", completed[0].TaskID, "task1-t1")
	}
	if completed[0].Status != "completed" {
		t.Errorf("task_completed Status = %q, want %q", completed[0].Status, "completed")
	}
}

func TestFireCliTurnHooks_TaskCreatedOnToolCallStart(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("task2")

	rec := &taskRecorder{}
	s.extGroup = newTaskGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"task2": s}
	mgr.mu.Unlock()

	// Tool call starts the turn → task_created must fire (this is the fix
	// for PR #162 which only wired task_created in the TextChunkEvent branch).
	mgr.fireCliTurnHooks(s, "task2", true, types.NormalizedEvent{
		Data: &types.ToolCallEvent{ToolName: "Read", ToolID: "t1"},
	})
	mgr.fireCliTurnHooks(s, "task2", true, types.NormalizedEvent{
		Data: &types.TaskUpdateEvent{},
	})
	mgr.fireCliTurnHooks(s, "task2", true, types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{Result: "done"},
	})

	created := rec.getCreated()
	completed := rec.getCompleted()

	if len(created) != 1 {
		t.Fatalf("expected 1 task_created from tool-call turn start, got %d", len(created))
	}
	if created[0].TaskID != "task2-t1" {
		t.Errorf("task_created TaskID = %q, want %q", created[0].TaskID, "task2-t1")
	}

	if len(completed) != 1 {
		t.Fatalf("expected 1 task_completed, got %d", len(completed))
	}
	if completed[0].TaskID != created[0].TaskID {
		t.Errorf("task_completed TaskID %q does not match task_created TaskID %q", completed[0].TaskID, created[0].TaskID)
	}
}

func TestFireCliTurnHooks_NoTaskCompletedWithoutTurn(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("task3")

	rec := &taskRecorder{}
	s.extGroup = newTaskGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"task3": s}
	mgr.mu.Unlock()

	// TaskComplete arrives without any prior text/tool events — no turn
	// was ever started, so neither task_created nor task_completed should fire.
	mgr.fireCliTurnHooks(s, "task3", true, types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{Result: "done"},
	})

	created := rec.getCreated()
	completed := rec.getCompleted()

	if len(created) != 0 {
		t.Errorf("expected 0 task_created without a turn, got %d", len(created))
	}
	if len(completed) != 0 {
		t.Errorf("expected 0 task_completed without a turn, got %d", len(completed))
	}
}

func TestFireCliTurnHooks_MultiTurnTaskPairing(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := NewManager(cb)
	s := newCliSession("task4")

	rec := &taskRecorder{}
	s.extGroup = newTaskGroup(rec)

	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"task4": s}
	mgr.mu.Unlock()

	// Turn 1: text → TaskUpdate (turn end, mid-run)
	mgr.fireCliTurnHooks(s, "task4", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "turn 1"},
	})
	mgr.fireCliTurnHooks(s, "task4", true, types.NormalizedEvent{
		Data: &types.TaskUpdateEvent{},
	})

	// Turn 2: tool call → TaskUpdate (turn end, mid-run)
	mgr.fireCliTurnHooks(s, "task4", true, types.NormalizedEvent{
		Data: &types.ToolCallEvent{ToolName: "Bash", ToolID: "t2"},
	})
	mgr.fireCliTurnHooks(s, "task4", true, types.NormalizedEvent{
		Data: &types.TaskUpdateEvent{},
	})

	// Turn 3: text → TaskComplete (run done)
	mgr.fireCliTurnHooks(s, "task4", true, types.NormalizedEvent{
		Data: &types.TextChunkEvent{Text: "turn 3 final"},
	})
	mgr.fireCliTurnHooks(s, "task4", true, types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{Result: "done"},
	})

	created := rec.getCreated()
	completed := rec.getCompleted()

	// Every turn-start fires task_created.
	if len(created) != 3 {
		t.Fatalf("expected 3 task_created, got %d", len(created))
	}
	for i, expectedID := range []string{"task4-t1", "task4-t2", "task4-t3"} {
		if created[i].TaskID != expectedID {
			t.Errorf("task_created[%d].TaskID = %q, want %q", i, created[i].TaskID, expectedID)
		}
	}

	// task_completed only fires on TaskCompleteEvent (run done), not on
	// TaskUpdateEvent (mid-run turn end). So only one task_completed with
	// the last turn's TaskID.
	if len(completed) != 1 {
		t.Fatalf("expected 1 task_completed (run done), got %d", len(completed))
	}
	if completed[0].TaskID != "task4-t3" {
		t.Errorf("task_completed TaskID = %q, want %q", completed[0].TaskID, "task4-t3")
	}
}
