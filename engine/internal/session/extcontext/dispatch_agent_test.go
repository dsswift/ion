package extcontext

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestFireLifecycleCallbacks_ToolCall verifies that a ToolCallEvent fires
// the OnToolStart callback with the correct tool name and ID, and that
// the toolCount accumulator is incremented.
func TestFireLifecycleCallbacks_ToolCall(t *testing.T) {
	var gotInfo extension.DispatchToolStartInfo
	var fired bool

	opts := &extension.DispatchAgentOpts{
		OnToolStart: func(info extension.DispatchToolStartInfo) {
			fired = true
			gotInfo = info
		},
	}

	toolNames := make(map[string]string)
	toolCount := 0
	accumulatedText := ""
	cumIn, cumOut := 0, 0
	cumCost := 0.0

	ev := types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: "bash", ToolID: "tc-1", Index: 0}}

	fireLifecycleCallbacks(opts, ev, "test-agent-id", toolNames, &toolCount, &accumulatedText,
		&cumIn, &cumOut, &cumCost)

	if !fired {
		t.Fatal("OnToolStart was not called")
	}
	if gotInfo.ToolName != "bash" {
		t.Errorf("ToolName = %q, want %q", gotInfo.ToolName, "bash")
	}
	if gotInfo.ToolID != "tc-1" {
		t.Errorf("ToolID = %q, want %q", gotInfo.ToolID, "tc-1")
	}
	if toolCount != 1 {
		t.Errorf("toolCount = %d, want 1", toolCount)
	}
	if name, ok := toolNames["tc-1"]; !ok || name != "bash" {
		t.Errorf("toolNames[tc-1] = %q (ok=%v), want %q", name, ok, "bash")
	}
}

// TestFireLifecycleCallbacks_ToolResult verifies that ToolResultEvent
// fires OnToolEnd for successful results and OnToolError for failures.
// Also confirms the toolNames map entry is cleaned up.
func TestFireLifecycleCallbacks_ToolResult(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		var gotEnd extension.DispatchToolEndInfo
		var endFired bool

		opts := &extension.DispatchAgentOpts{
			OnToolEnd: func(info extension.DispatchToolEndInfo) {
				endFired = true
				gotEnd = info
			},
			OnToolError: func(_ extension.DispatchToolErrorInfo) {
				t.Error("OnToolError should not fire for a success result")
			},
		}

		toolNames := map[string]string{"tc-2": "read_file"}
		toolCount := 1
		accumulatedText := ""
		cumIn, cumOut := 0, 0
		cumCost := 0.0

		ev := types.NormalizedEvent{Data: &types.ToolResultEvent{
			ToolID:  "tc-2",
			Content: "file contents here",
			IsError: false,
		}}

		fireLifecycleCallbacks(opts, ev, "test-agent-id", toolNames, &toolCount, &accumulatedText,
			&cumIn, &cumOut, &cumCost)

		if !endFired {
			t.Fatal("OnToolEnd was not called")
		}
		if gotEnd.ToolName != "read_file" {
			t.Errorf("ToolName = %q, want %q", gotEnd.ToolName, "read_file")
		}
		if gotEnd.ToolID != "tc-2" {
			t.Errorf("ToolID = %q, want %q", gotEnd.ToolID, "tc-2")
		}
		if gotEnd.Content != "file contents here" {
			t.Errorf("Content = %q, want %q", gotEnd.Content, "file contents here")
		}
		// toolNames should have been cleaned up.
		if _, ok := toolNames["tc-2"]; ok {
			t.Error("toolNames[tc-2] should have been deleted after result")
		}
	})

	t.Run("error", func(t *testing.T) {
		var gotErr extension.DispatchToolErrorInfo
		var errFired bool

		opts := &extension.DispatchAgentOpts{
			OnToolEnd: func(_ extension.DispatchToolEndInfo) {
				t.Error("OnToolEnd should not fire for an error result")
			},
			OnToolError: func(info extension.DispatchToolErrorInfo) {
				errFired = true
				gotErr = info
			},
		}

		toolNames := map[string]string{"tc-3": "write_file"}
		toolCount := 1
		accumulatedText := ""
		cumIn, cumOut := 0, 0
		cumCost := 0.0

		ev := types.NormalizedEvent{Data: &types.ToolResultEvent{
			ToolID:  "tc-3",
			Content: "permission denied",
			IsError: true,
		}}

		fireLifecycleCallbacks(opts, ev, "test-agent-id", toolNames, &toolCount, &accumulatedText,
			&cumIn, &cumOut, &cumCost)

		if !errFired {
			t.Fatal("OnToolError was not called")
		}
		if gotErr.ToolName != "write_file" {
			t.Errorf("ToolName = %q, want %q", gotErr.ToolName, "write_file")
		}
		if gotErr.ToolID != "tc-3" {
			t.Errorf("ToolID = %q, want %q", gotErr.ToolID, "tc-3")
		}
		if gotErr.Content != "permission denied" {
			t.Errorf("Content = %q, want %q", gotErr.Content, "permission denied")
		}
	})
}

// TestFireLifecycleCallbacks_TextChunk verifies that TextChunkEvent fires
// OnTextDelta with the delta and the growing accumulated text.
func TestFireLifecycleCallbacks_TextChunk(t *testing.T) {
	var deltas []extension.DispatchTextDeltaInfo

	opts := &extension.DispatchAgentOpts{
		OnTextDelta: func(info extension.DispatchTextDeltaInfo) {
			deltas = append(deltas, info)
		},
	}

	toolNames := make(map[string]string)
	toolCount := 0
	accumulatedText := ""
	cumIn, cumOut := 0, 0
	cumCost := 0.0

	chunks := []string{"Hello", ", ", "world!"}
	for _, chunk := range chunks {
		ev := types.NormalizedEvent{Data: &types.TextChunkEvent{Text: chunk}}
		fireLifecycleCallbacks(opts, ev, "test-agent-id", toolNames, &toolCount, &accumulatedText,
			&cumIn, &cumOut, &cumCost)
	}

	if len(deltas) != 3 {
		t.Fatalf("OnTextDelta fired %d times, want 3", len(deltas))
	}

	// First chunk.
	if deltas[0].Delta != "Hello" {
		t.Errorf("deltas[0].Delta = %q, want %q", deltas[0].Delta, "Hello")
	}
	if deltas[0].Accumulated != "Hello" {
		t.Errorf("deltas[0].Accumulated = %q, want %q", deltas[0].Accumulated, "Hello")
	}

	// Second chunk.
	if deltas[1].Delta != ", " {
		t.Errorf("deltas[1].Delta = %q, want %q", deltas[1].Delta, ", ")
	}
	if deltas[1].Accumulated != "Hello, " {
		t.Errorf("deltas[1].Accumulated = %q, want %q", deltas[1].Accumulated, "Hello, ")
	}

	// Third chunk.
	if deltas[2].Delta != "world!" {
		t.Errorf("deltas[2].Delta = %q, want %q", deltas[2].Delta, "world!")
	}
	if deltas[2].Accumulated != "Hello, world!" {
		t.Errorf("deltas[2].Accumulated = %q, want %q", deltas[2].Accumulated, "Hello, world!")
	}

	// The external accumulator should match.
	if accumulatedText != "Hello, world!" {
		t.Errorf("accumulatedText = %q, want %q", accumulatedText, "Hello, world!")
	}
}

// TestFireLifecycleCallbacks_Usage verifies that UsageEvent fires
// OnUsage with per-turn and cumulative token counts.
func TestFireLifecycleCallbacks_Usage(t *testing.T) {
	var gotUsage []extension.DispatchUsageInfo

	opts := &extension.DispatchAgentOpts{
		OnUsage: func(info extension.DispatchUsageInfo) {
			gotUsage = append(gotUsage, info)
		},
	}

	toolNames := make(map[string]string)
	toolCount := 0
	accumulatedText := ""
	cumIn, cumOut := 0, 0
	cumCost := 0.0

	// First usage event.
	in1 := 100
	out1 := 50
	ev1 := types.NormalizedEvent{Data: &types.UsageEvent{
		Usage: types.UsageData{InputTokens: &in1, OutputTokens: &out1},
	}}
	fireLifecycleCallbacks(opts, ev1, "test-agent-id", toolNames, &toolCount, &accumulatedText,
		&cumIn, &cumOut, &cumCost)

	// Second usage event — cumulative totals should grow.
	in2 := 200
	out2 := 75
	ev2 := types.NormalizedEvent{Data: &types.UsageEvent{
		Usage: types.UsageData{InputTokens: &in2, OutputTokens: &out2},
	}}
	fireLifecycleCallbacks(opts, ev2, "test-agent-id", toolNames, &toolCount, &accumulatedText,
		&cumIn, &cumOut, &cumCost)

	if len(gotUsage) != 2 {
		t.Fatalf("OnUsage fired %d times, want 2", len(gotUsage))
	}

	// First turn.
	if gotUsage[0].InputTokens != 100 {
		t.Errorf("turn1 InputTokens = %d, want 100", gotUsage[0].InputTokens)
	}
	if gotUsage[0].OutputTokens != 50 {
		t.Errorf("turn1 OutputTokens = %d, want 50", gotUsage[0].OutputTokens)
	}
	if gotUsage[0].CumulativeInputTokens != 100 {
		t.Errorf("turn1 CumulativeInputTokens = %d, want 100", gotUsage[0].CumulativeInputTokens)
	}
	if gotUsage[0].CumulativeOutputTokens != 50 {
		t.Errorf("turn1 CumulativeOutputTokens = %d, want 50", gotUsage[0].CumulativeOutputTokens)
	}
	if gotUsage[0].CumulativeCost != 0.0 {
		t.Errorf("turn1 CumulativeCost = %v, want 0 (cost comes from TaskCompleteEvent)", gotUsage[0].CumulativeCost)
	}

	// Second turn.
	if gotUsage[1].InputTokens != 200 {
		t.Errorf("turn2 InputTokens = %d, want 200", gotUsage[1].InputTokens)
	}
	if gotUsage[1].OutputTokens != 75 {
		t.Errorf("turn2 OutputTokens = %d, want 75", gotUsage[1].OutputTokens)
	}
	if gotUsage[1].CumulativeInputTokens != 300 {
		t.Errorf("turn2 CumulativeInputTokens = %d, want 300", gotUsage[1].CumulativeInputTokens)
	}
	if gotUsage[1].CumulativeOutputTokens != 125 {
		t.Errorf("turn2 CumulativeOutputTokens = %d, want 125", gotUsage[1].CumulativeOutputTokens)
	}

	// External accumulators should match.
	if cumIn != 300 {
		t.Errorf("cumulativeInputTokens = %d, want 300", cumIn)
	}
	if cumOut != 125 {
		t.Errorf("cumulativeOutputTokens = %d, want 125", cumOut)
	}
}

// TestExitCodeRecalled verifies the constant value is 2, distinct from
// success (0) and error (1).
func TestExitCodeRecalled(t *testing.T) {
	if ExitCodeRecalled != 2 {
		t.Errorf("ExitCodeRecalled = %d, want 2", ExitCodeRecalled)
	}
}

// TestTruncate verifies the truncate helper with short strings (no
// truncation needed) and long strings (truncated with "…" appended).
func TestTruncate(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		maxLen int
		want   string
	}{
		{
			name:   "short string unchanged",
			input:  "hello",
			maxLen: 10,
			want:   "hello",
		},
		{
			name:   "exact length unchanged",
			input:  "hello",
			maxLen: 5,
			want:   "hello",
		},
		{
			name:   "long string truncated",
			input:  "hello world this is a long string",
			maxLen: 11,
			want:   "hello world…",
		},
		{
			name:   "empty string unchanged",
			input:  "",
			maxLen: 5,
			want:   "",
		},
		{
			name:   "maxLen 0 truncates everything",
			input:  "hello",
			maxLen: 0,
			want:   "…",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := truncate(tt.input, tt.maxLen)
			if got != tt.want {
				t.Errorf("truncate(%q, %d) = %q, want %q", tt.input, tt.maxLen, got, tt.want)
			}
		})
	}
}

// TestFireLifecycleCallbacks_NilCallbacks verifies that events are
// processed without panic when no callbacks are set on opts.
func TestFireLifecycleCallbacks_NilCallbacks(t *testing.T) {
	opts := &extension.DispatchAgentOpts{} // all callbacks nil

	toolNames := make(map[string]string)
	toolCount := 0
	accumulatedText := ""
	cumIn, cumOut := 0, 0
	cumCost := 0.0

	// Fire each event type — none should panic.
	events := []types.NormalizedEvent{
		{Data: &types.ToolCallEvent{ToolName: "bash", ToolID: "tc-1"}},
		{Data: &types.ToolResultEvent{ToolID: "tc-1", Content: "ok", IsError: false}},
		{Data: &types.TextChunkEvent{Text: "hello"}},
		{Data: &types.UsageEvent{Usage: types.UsageData{}}},
		{Data: &types.TaskCompleteEvent{CostUsd: 0.01}},
	}

	for _, ev := range events {
		fireLifecycleCallbacks(opts, ev, "test-agent-id", toolNames, &toolCount, &accumulatedText,
			&cumIn, &cumOut, &cumCost)
	}

	// Side effects should still accumulate even without callbacks.
	if toolCount != 1 {
		t.Errorf("toolCount = %d, want 1", toolCount)
	}
	if accumulatedText != "hello" {
		t.Errorf("accumulatedText = %q, want %q", accumulatedText, "hello")
	}
	if cumCost != 0.01 {
		t.Errorf("cumulativeCost = %v, want 0.01", cumCost)
	}
}

// TestFireLifecycleCallbacks_TaskCompleteUpdatesCost verifies that a
// TaskCompleteEvent updates the cumulative cost accumulator and that a
// subsequent UsageEvent reports the updated cost.
func TestFireLifecycleCallbacks_TaskCompleteUpdatesCost(t *testing.T) {
	var gotUsage extension.DispatchUsageInfo

	opts := &extension.DispatchAgentOpts{
		OnUsage: func(info extension.DispatchUsageInfo) {
			gotUsage = info
		},
	}

	toolNames := make(map[string]string)
	toolCount := 0
	accumulatedText := ""
	cumIn, cumOut := 0, 0
	cumCost := 0.0

	// TaskCompleteEvent sets the authoritative cost.
	tcEv := types.NormalizedEvent{Data: &types.TaskCompleteEvent{CostUsd: 0.042}}
	fireLifecycleCallbacks(opts, tcEv, "test-agent-id", toolNames, &toolCount, &accumulatedText,
		&cumIn, &cumOut, &cumCost)

	if cumCost != 0.042 {
		t.Fatalf("cumulativeCost after TaskComplete = %v, want 0.042", cumCost)
	}

	// Subsequent UsageEvent should carry the updated cumulative cost.
	in := 10
	out := 5
	usageEv := types.NormalizedEvent{Data: &types.UsageEvent{
		Usage: types.UsageData{InputTokens: &in, OutputTokens: &out},
	}}
	fireLifecycleCallbacks(opts, usageEv, "test-agent-id", toolNames, &toolCount, &accumulatedText,
		&cumIn, &cumOut, &cumCost)

	if gotUsage.CumulativeCost != 0.042 {
		t.Errorf("OnUsage CumulativeCost = %v, want 0.042", gotUsage.CumulativeCost)
	}
}
