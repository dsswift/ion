package backend

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// A client toggle that arrives while a run is mid-turn must apply to that
// run: the switch emits PlanModeChangedEvent with its source during the run,
// and the very next tool round is plan-gated. Before SetRunPlanMode the toggle
// changed only session state and the write below went through.
func TestSetRunPlanMode_AppliesMidTurn(t *testing.T) {
	project := t.TempDir()
	planFile := filepath.Join(t.TempDir(), "plan.md")
	readTarget := filepath.Join(project, "input.txt")
	writeTarget := filepath.Join(project, "should-not-exist.txt")
	if err := os.WriteFile(readTarget, []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}

	setupToolCapturingProvider([][]types.LlmStreamEvent{
		toolUseResponse("Read", "tc-read", map[string]any{"file_path": readTarget}, 10, 5),
		toolUseResponse("Write", "tc-write", map[string]any{"file_path": writeTarget, "content": "x"}, 10, 5),
		textResponse("done", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-switch")
	switched := false
	autoExitOff := false
	cfg := &RunConfig{Hooks: RunHooks{
		OnToolCall: func(info ToolCallInfo) (*ToolCallResult, error) {
			// The toggle lands while turn 1's tools run.
			if info.ToolName == "Read" && !switched {
				switched = b.SetRunPlanMode("req-switch", true, planFile, PlanModeSourceWire)
			}
			return nil, nil
		},
	}}
	b.StartRunWithConfig("req-switch", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      project,
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
		PlanModeAutoExit: &autoExitOff,
	}, cfg)
	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for run to exit")
	}
	if !switched {
		t.Fatal("SetRunPlanMode did not find the live run")
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	var sawChange bool
	var writeResult *types.ToolResultEvent
	for _, ev := range c.normalized {
		switch e := ev.Data.(type) {
		case *types.PlanModeChangedEvent:
			if e.Enabled && e.Source == PlanModeSourceWire && e.PlanFilePath == planFile {
				sawChange = true
			}
		case *types.ToolResultEvent:
			if e.ToolID == "tc-write" {
				writeResult = e
			}
		}
	}
	if !sawChange {
		t.Fatal("no PlanModeChangedEvent{Enabled:true, Source:wire} during the run")
	}
	if _, err := os.Stat(writeTarget); err == nil {
		t.Fatal("the write after the mid-turn switch went through; plan mode was not applied")
	}
	if writeResult == nil || !writeResult.IsError {
		t.Fatalf("the write after the switch must be refused, got %+v", writeResult)
	}
	if !strings.Contains(strings.ToLower(writeResult.Content), "plan") {
		t.Fatalf("refusal should name plan mode: %q", writeResult.Content)
	}
}

func TestSetRunPlanMode_UnknownRun(t *testing.T) {
	b := NewApiBackend()
	if b.SetRunPlanMode("no-such-run", true, "/tmp/p.md", PlanModeSourceWire) {
		t.Fatal("an unknown run must report false")
	}
	h := NewHybridBackend()
	if h.SetRunPlanMode("no-such-run", true, "/tmp/p.md", PlanModeSourceWire) {
		t.Fatal("a run the hybrid has not routed must report false")
	}
}
