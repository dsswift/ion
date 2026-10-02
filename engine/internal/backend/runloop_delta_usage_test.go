package backend

import (
	"math"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestRunPersistsInputUsageReportedOnMessageDelta pins the run loop against a
// provider stream that reports no usage on message_start and the whole
// breakdown on the closing message_delta. The persisted assistant message, the
// usage event, and the turn cost must all carry the input-side counts.
func TestRunPersistsInputUsageReportedOnMessageDelta(t *testing.T) {
	stopReason := "end_turn"
	setupTestProvider([][]types.LlmStreamEvent{{
		{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "msg_delta_usage", Model: testModel}},
		{Type: "content_block_start", BlockIndex: 0, ContentBlock: &types.LlmStreamContentBlock{Type: "text"}},
		{Type: "content_block_delta", BlockIndex: 0, Delta: &types.LlmStreamDelta{Type: "text_delta", Text: "done"}},
		{Type: "content_block_stop", BlockIndex: 0},
		{
			Type:       "message_delta",
			Delta:      &types.LlmStreamDelta{Type: "message_delta", StopReason: &stopReason},
			DeltaUsage: &types.LlmUsage{InputTokens: 400, CacheReadInputTokens: 600, OutputTokens: 200},
		},
		{Type: "message_stop"},
	}})

	const convID = "delta-usage-conv"
	b := NewApiBackend()
	c := collectEvents(b, "req-delta-usage")
	b.StartRun("req-delta-usage", types.RunOptions{
		Prompt:           "usage",
		ProjectPath:      "/tmp",
		Model:            testModel,
		ConversationID:   convID,
		EarlyStopEnabled: testEarlyStopDisabled(),
	})
	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	conv, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	var persisted *types.LlmUsage
	for i := range conv.Messages {
		if conv.Messages[i].Role == "assistant" {
			persisted = conv.Messages[i].Usage
		}
	}
	want := types.LlmUsage{InputTokens: 400, CacheReadInputTokens: 600, OutputTokens: 200}
	if persisted == nil || *persisted != want {
		t.Fatalf("persisted assistant usage = %+v, want %+v", persisted, want)
	}

	sawOccupancy := false
	var cost float64
	for _, ev := range c.normalized {
		switch d := ev.Data.(type) {
		case *types.UsageEvent:
			if d.Usage.InputTokens != nil && *d.Usage.InputTokens == 1000 {
				sawOccupancy = true
			}
		case *types.TaskCompleteEvent:
			cost = d.CostUsd
		}
	}
	if !sawOccupancy {
		t.Error("no usage event carried the summed input occupancy of 1000 tokens")
	}
	// 400 input at 0.003/1k + 600 cache read at 0.1x input + 200 output at 0.015/1k.
	if wantCost := 0.0012 + 0.00018 + 0.003; math.Abs(cost-wantCost) > 1e-9 {
		t.Errorf("cost = %v, want %v", cost, wantCost)
	}
}
