package session

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestTranslateRunUsage_TaskComplete pins that the status closing a run
// carries the run's usage from TaskCompleteEvent, cache tokens and duration
// included, and that it reaches the wire as runUsage.
func TestTranslateRunUsage_TaskComplete(t *testing.T) {
	in, out, read, made := 1200, 340, 50000, 800
	eng := translateToEngineEvent(types.NormalizedEvent{Data: &types.TaskCompleteEvent{
		CostUsd:    2.0263,
		NumTurns:   9,
		DurationMs: 61000,
		Usage: types.UsageData{
			InputTokens: &in, OutputTokens: &out,
			CacheReadInputTokens: &read, CacheCreationInputTokens: &made,
		},
	}}, 200000)

	want := types.RunUsage{InputTokens: in, OutputTokens: out, CacheReadTokens: read, CacheCreationTokens: made, DurationMs: 61000}
	if eng.Fields == nil || eng.Fields.RunUsage == nil || *eng.Fields.RunUsage != want {
		t.Fatalf("RunUsage = %+v, want %+v", eng.Fields, want)
	}
	data, err := json.Marshal(eng)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"runUsage":{"inputTokens":1200,"outputTokens":340,"cacheReadTokens":50000,"cacheCreationTokens":800,"durationMs":61000}`) {
		t.Errorf("wire status lacks runUsage: %s", data)
	}
}

// TestRunUsageOnlyOnTheStatusThatClosesARun pins that no other status
// carries runUsage on the wire.
func TestRunUsageOnlyOnTheStatusThatClosesARun(t *testing.T) {
	data, err := json.Marshal(types.EngineEvent{Type: "engine_status", Fields: &types.StatusFields{State: "running"}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(data), "runUsage") {
		t.Errorf("a running status carries runUsage: %s", data)
	}
}
