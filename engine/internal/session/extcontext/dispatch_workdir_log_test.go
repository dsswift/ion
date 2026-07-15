package extcontext

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// captureDispatchLogs installs a utils test sink that records every log line
// tagged "Dispatch" and lowers the level to Debug so utils.Debug lines are not
// filtered. It returns a snapshot function and registers cleanup that removes
// the sink and restores the prior level. Serialized by a package mutex because
// the sink is process-global logger state.
var workdirLogMu sync.Mutex

type workdirLogEntry struct {
	msg    string
	fields map[string]any
}

func captureDispatchLogs(t *testing.T) func() []workdirLogEntry {
	t.Helper()
	workdirLogMu.Lock()

	var mu sync.Mutex
	var entries []workdirLogEntry

	prevLevel := utils.GetLevel()
	utils.SetLevel(utils.LevelDebug)
	utils.SetTestSink(func(_ utils.LogLevel, tag, msg string, fields map[string]any, _, _ string) {
		if tag != "session.extcontext" {
			return
		}
		mu.Lock()
		entries = append(entries, workdirLogEntry{msg: msg, fields: fields})
		mu.Unlock()
	})

	t.Cleanup(func() {
		utils.SetTestSink(nil)
		utils.SetLevel(prevLevel)
		workdirLogMu.Unlock()
	})

	return func() []workdirLogEntry {
		mu.Lock()
		defer mu.Unlock()
		out := make([]workdirLogEntry, len(entries))
		copy(out, entries)
		return out
	}
}

// findWorkdirLog returns the first "dispatch working directory resolved" entry
// captured, or nil if none was emitted.
func findWorkdirLog(entries []workdirLogEntry) *workdirLogEntry {
	for i, e := range entries {
		if e.msg == "dispatch working directory resolved" {
			return &entries[i]
		}
	}
	return nil
}

// TestDispatchWorkdirLog_ExplicitProjectPath verifies that a dispatch supplied
// with an explicit ProjectPath logs the resolved working directory with
// source=opts and the exact path. It must FAIL on the pre-fix code (which
// emitted no such log line) and PASS after the log addition.
func TestDispatchWorkdirLog_ExplicitProjectPath(t *testing.T) {
	snapshot := captureDispatchLogs(t)

	acc := &depthTestAccessor{
		config: &types.EngineRuntimeConfig{MaxDispatchDepth: 5},
	}
	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")

	const explicitPath = "/explicit/project/dir"
	// The dispatch fails (no provider) but the working-directory log line is
	// emitted before the run starts — that is all we assert here.
	_, _ = dispatchFn(extension.DispatchAgentOpts{
		Name:        "workdir-agent",
		Task:        "do work",
		ProjectPath: explicitPath,
	})

	entry := findWorkdirLog(snapshot())
	if entry == nil {
		t.Fatal("expected a \"dispatch working directory resolved\" log line, got none")
	}
	if entry.fields["source"] != "opts" {
		t.Errorf("expected source=opts in log fields, got: %v", entry.fields["source"])
	}
	if entry.fields["path"] != explicitPath {
		t.Errorf("expected path=%q in log fields, got: %v", explicitPath, entry.fields["path"])
	}
}

// TestDispatchWorkdirLog_FallbackToParentCwd verifies that a dispatch with an
// empty ProjectPath falls back to the parent session's working directory and
// logs source=fallback with that path. depthTestAccessor.WorkingDirectory()
// returns "/tmp", which is the expected fallback path. Must FAIL pre-fix and
// PASS after.
func TestDispatchWorkdirLog_FallbackToParentCwd(t *testing.T) {
	snapshot := captureDispatchLogs(t)

	acc := &depthTestAccessor{
		config: &types.EngineRuntimeConfig{MaxDispatchDepth: 5},
	}
	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")

	// No ProjectPath -> falls back to sa.WorkingDirectory() == "/tmp".
	_, _ = dispatchFn(extension.DispatchAgentOpts{
		Name: "workdir-agent",
		Task: "do work",
	})

	entry := findWorkdirLog(snapshot())
	if entry == nil {
		t.Fatal("expected a \"dispatch working directory resolved\" log line, got none")
	}
	if entry.fields["source"] != "fallback" {
		t.Errorf("expected source=fallback in log fields, got: %v", entry.fields["source"])
	}
	// The parent cwd from depthTestAccessor.WorkingDirectory().
	if entry.fields["path"] != "/tmp" {
		t.Errorf("expected path=/tmp in log fields, got: %v", entry.fields["path"])
	}
}
