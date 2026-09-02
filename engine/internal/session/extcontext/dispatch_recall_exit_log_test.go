package extcontext

import (
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Regression test for a log-truth defect: every recall logged a WARN claiming
// the child had exited via an engine cancel that was NOT a recall.
//
// The cause was an ordering race. On recall, runChild cancels ctx, calls
// child.Cancel(), and then sets `recalled = true` only after <-doneCh returns.
// But child.Cancel() makes the child exit with signal "cancelled", and OnExit
// fires on the backend's goroutine BEFORE that assignment lands — so the
// callback read recalled == false and took the "not recall" branch.
//
// The dispatch RESULT was always correct (the recalled branch reports
// ExitCodeRecalled), which is precisely what made this dangerous: the behavior
// looked right while the log asserted the opposite of what happened. A WARN
// that contradicts reality is what sends the next reader down the wrong path —
// it is the same class of defect as a stale comment, and this repository treats
// that as a bug rather than noise.
//
// The fix sets `recalled` (now atomic, because two goroutines touch it) before
// child.Cancel(), and gives OnExit a branch for the recall case.

// recallExitLogMu serializes access to the process-global logger test sink.
var recallExitLogMu sync.Mutex

// captureServerExitLogs records the "server"-tagged child-exit lines emitted
// while a dispatch tears down.
func captureServerExitLogs(t *testing.T) func() []capturedExitLog {
	t.Helper()
	recallExitLogMu.Lock()
	// The process-global per-message rate limiter runs ahead of the test sink,
	// so a package run that already filled a window for these lines would hide
	// them. Same reason as captureRecallLogFields.
	utils.ResetLogRateLimitForTest()

	var mu sync.Mutex
	var logs []capturedExitLog
	utils.SetTestSink(func(level utils.LogLevel, tag, msg string, _ map[string]any, _, _ string) {
		if tag != "server" || !strings.Contains(msg, "child run exited") {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		logs = append(logs, capturedExitLog{level: level, msg: msg})
	})
	t.Cleanup(func() {
		utils.SetTestSink(nil)
		recallExitLogMu.Unlock()
	})

	return func() []capturedExitLog {
		mu.Lock()
		defer mu.Unlock()
		out := make([]capturedExitLog, len(logs))
		copy(out, logs)
		return out
	}
}

type capturedExitLog struct {
	level utils.LogLevel
	msg   string
}

// TestRecallDoesNotLogFalseNotRecallWarning is the regression assertion. A
// recalled dispatch must never emit the "(not recall)" WARN, and its exit must
// still be observable in the log.
//
// Reverting the fix — moving recalled.Store(true) back after <-doneCh — turns
// this red: the OnExit callback again reads false and logs the WARN.
func TestRecallDoesNotLogFalseNotRecallWarning(t *testing.T) {
	registry := NewDispatchRegistry()
	child := &recallProbeBackend{}
	accessor := &bumpCountingAccessor{child: child}

	readLogs := captureServerExitLogs(t)

	dispatch := BuildDispatchAgentFunc(accessor, registry, 0, "")

	// The child cancels itself the moment the run starts, standing in for the
	// backend's response to child.Cancel(). What matters is that the exit
	// carries signal "cancelled" while a recall is in flight.
	child.onStart = func(requestID string) {
		registry.RecallByID(dispatchIDFor(registry, "recall-probe"), "verifying recall log truth")
	}

	if _, err := dispatch(extension.DispatchAgentOpts{
		WaitForCompletion: true,
		Name:              "recall-probe",
		Task:              "work that gets recalled",
	}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	for _, entry := range readLogs() {
		if strings.Contains(entry.msg, "not recall") {
			t.Errorf("recall emitted the false WARN %q; a recall is not an unexplained engine cancel", entry.msg)
		}
		if entry.level == utils.LevelWarn && strings.Contains(entry.msg, "engine cancel") {
			t.Errorf("recall logged at WARN: %q", entry.msg)
		}
	}
}

// dispatchIDFor resolves the single live dispatch id for an agent name. The
// test needs the engine-minted id, which is only knowable from the registry.
func dispatchIDFor(r *DispatchRegistry, name string) string {
	for _, entry := range r.Snapshot() {
		if entry.Name == name {
			return entry.DispatchID
		}
	}
	return ""
}

// recallProbeBackend exits with signal "cancelled", which is what a real
// backend reports when child.Cancel() tears its run down. That signal is the
// input to the OnExit branch under test.
type recallProbeBackend struct {
	runOptsCapturingChildBackend
	onStart func(requestID string)
}

func (c *recallProbeBackend) StartRun(requestID string, opts types.RunOptions) {
	c.mu.Lock()
	c.captured = opts
	c.started = true
	onExit := c.onExit
	c.mu.Unlock()

	// Fire the caller's hook synchronously so the recall is registered before
	// the exit lands — the exact ordering that exposed the race.
	if c.onStart != nil {
		c.onStart(requestID)
	}

	go func() {
		time.Sleep(5 * time.Millisecond)
		if onExit != nil {
			cancelled := "cancelled"
			zero := 0
			onExit(requestID, &zero, &cancelled, "recall-probe-conv")
		}
	}()
}

// The recalled dispatch result is operator-visible text. A mechanical rename of
// the `recalled` flag to an atomic once rewrote the format string itself, so a
// recall reported "recalled.Load(): recall_agent" to the operator -- Go source
// leaking into a user-facing message.
func TestRecalledOutputIsNotMangled(t *testing.T) {
	src, err := os.ReadFile("dispatch_agent.go")
	if err != nil {
		t.Fatalf("read dispatch_agent.go: %v", err)
	}
	body := string(src)
	if strings.Contains(body, `"recalled.Load(): %s"`) {
		t.Error("recall output format leaks Go source into operator-visible text")
	}
	if !strings.Contains(body, `"recalled: %s"`) {
		t.Error("the recalled output format string is missing")
	}
	if strings.Contains(body, "recalled.Load() while suspended") {
		t.Error("recall log message carries a mangled identifier")
	}
}
