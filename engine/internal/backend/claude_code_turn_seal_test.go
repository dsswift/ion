package backend

import (
	"io"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// A turn-ending tool hands control back to the operator: ExitPlanMode parks a
// plan for approval, a question tool parks a question for an answer. Plan mode
// revokes the mutating tools for exactly that reason, so a model that keeps
// working after the signal gets "No such tool available" on every call and the
// run burns its remaining turns on refusals. These tests pin that the engine
// stops the run at the signal instead of relying on prompt prose.

// fakeStdin records whether the backend closed the CLI's stdin.
type fakeStdin struct {
	mu     sync.Mutex
	closed bool
}

func (f *fakeStdin) Write(p []byte) (int, error) { return len(p), nil }

func (f *fakeStdin) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	return nil
}

func (f *fakeStdin) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

func sealTestRun(pipe io.WriteCloser) *claudeCodeRun {
	return &claudeCodeRun{requestID: "seal-run", planMode: true, stdinPipe: pipe}
}

func TestSealTurnAfterExitPlanModeStopsTheRun(t *testing.T) {
	b := NewClaudeCodeBackend()
	pipe := &fakeStdin{}
	run := sealTestRun(pipe)
	run.sawExitPlanMode = true

	if !b.sealTurnAfterTerminalTool(run, "test") {
		t.Fatal("ExitPlanMode must seal the turn")
	}
	if !run.turnSealed {
		t.Error("turnSealed not latched")
	}
	if !pipe.isClosed() {
		t.Error("stdin must be closed so the CLI cannot be handed another turn")
	}
}

func TestSealTurnAfterQuestionStopsTheRun(t *testing.T) {
	b := NewClaudeCodeBackend()
	pipe := &fakeStdin{}
	run := sealTestRun(pipe)
	run.pendingQuestionDenials = []types.PermissionDenial{{ToolName: "AskUserQuestion"}}

	if !b.sealTurnAfterTerminalTool(run, "test") {
		t.Fatal("a question tool must seal the turn")
	}
	if !pipe.isClosed() {
		t.Error("stdin must be closed after a question parks the turn")
	}
}

// The scanners run per assistant message, so the seal is reached repeatedly for
// one run. Only the first call may act.
func TestSealTurnIsIdempotent(t *testing.T) {
	b := NewClaudeCodeBackend()
	pipe := &fakeStdin{}
	run := sealTestRun(pipe)
	run.sawExitPlanMode = true

	if !b.sealTurnAfterTerminalTool(run, "first") {
		t.Fatal("first seal must act")
	}
	if b.sealTurnAfterTerminalTool(run, "second") {
		t.Error("second seal must be a no-op")
	}
}

// An ordinary working turn must never be sealed — this is the guard against the
// fix stopping healthy runs.
func TestOrdinaryTurnIsNotSealed(t *testing.T) {
	b := NewClaudeCodeBackend()
	pipe := &fakeStdin{}
	run := sealTestRun(pipe)

	if b.sealTurnAfterTerminalTool(run, "test") {
		t.Fatal("a run with no turn-ending tool must not be sealed")
	}
	if run.turnSealed {
		t.Error("turnSealed latched without a turn-ending tool")
	}
	if pipe.isClosed() {
		t.Error("stdin must stay open for an ordinary turn")
	}
}

// Sealing must survive an already-closed pipe: the process may be tearing down
// on its own when the signal lands.
func TestSealTurnToleratesMissingStdin(t *testing.T) {
	b := NewClaudeCodeBackend()
	run := sealTestRun(nil)
	run.sawExitPlanMode = true

	if !b.sealTurnAfterTerminalTool(run, "test") {
		t.Fatal("seal must still latch when stdin is already gone")
	}
	if !run.turnSealed {
		t.Error("turnSealed not latched without a pipe")
	}
}
