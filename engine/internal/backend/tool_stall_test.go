package backend

import (
	"context"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestToolStalledEventEmitted verifies that a ToolStalledEvent is emitted
// when a tool call takes longer than toolStallThreshold to return.
func TestToolStalledEventEmitted(t *testing.T) {
	// Shorten thresholds for the test so we don't wait 30 real seconds.
	origStall := toolStallThreshold
	toolStallThreshold = 500 * time.Millisecond
	defer func() { toolStallThreshold = origStall }()

	// Register a tool that blocks for longer than the stall threshold.
	tools.RegisterTool(&types.ToolDef{
		Name:        "test_slow_stall_tool",
		Description: "blocks for a while",
		InputSchema: map[string]any{"type": "object"},
		Execute: func(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
			select {
			case <-time.After(2 * time.Second):
				return &types.ToolResult{Content: "finally done"}, nil
			case <-ctx.Done():
				return &types.ToolResult{Content: "cancelled", IsError: true}, ctx.Err()
			}
		},
	})

	// Provider calls the slow tool, then returns end_turn.
	mock := &mockLlmProvider{
		id: testProviderID,
		responses: [][]types.LlmStreamEvent{
			toolUseResponse("test_slow_stall_tool", "tool-stall-1", map[string]any{}, 10, 5),
			textResponse("done after stall", 10, 5),
		},
	}
	providers.RegisterProvider(mock)
	providers.RegisterModel(testModel, types.ModelInfo{
		ProviderID:      testProviderID,
		ContextWindow:   200000,
		CostPer1kInput:  0.003,
		CostPer1kOutput: 0.015,
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-stall")
	b.StartRun("req-stall", types.RunOptions{
		Prompt:      "stall test",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	if !waitForExit(c, 10*time.Second) {
		t.Fatal("timed out waiting for exit")
	}

	// Should have a ToolStalledEvent for our slow tool.
	c.mu.Lock()
	defer c.mu.Unlock()
	found := false
	for _, ev := range c.normalized {
		if stall, ok := ev.Data.(*types.ToolStalledEvent); ok {
			if stall.ToolID != "tool-stall-1" {
				continue
			}
			found = true
			if stall.ToolName != "test_slow_stall_tool" {
				t.Errorf("expected toolName %q, got %q", "test_slow_stall_tool", stall.ToolName)
			}
			if stall.Elapsed <= 0 {
				t.Errorf("expected positive elapsed, got %f", stall.Elapsed)
			}
		}
	}
	if !found {
		t.Error("expected ToolStalledEvent to be emitted for slow tool")
	}
}

// TestToolStalledEventNotEmittedOnFastTool verifies that no ToolStalledEvent
// is emitted when a tool completes before the stall threshold.
func TestToolStalledEventNotEmittedOnFastTool(t *testing.T) {
	// Shorten threshold for fast test.
	origStall := toolStallThreshold
	toolStallThreshold = 2 * time.Second
	defer func() { toolStallThreshold = origStall }()

	// Register a tool that returns immediately.
	tools.RegisterTool(&types.ToolDef{
		Name:        "test_fast_stall_tool",
		Description: "returns instantly",
		InputSchema: map[string]any{"type": "object"},
		Execute: func(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "instant result"}, nil
		},
	})

	mock := &mockLlmProvider{
		id: testProviderID,
		responses: [][]types.LlmStreamEvent{
			toolUseResponse("test_fast_stall_tool", "tool-fast-1", map[string]any{}, 10, 5),
			textResponse("done fast", 10, 5),
		},
	}
	providers.RegisterProvider(mock)
	providers.RegisterModel(testModel, types.ModelInfo{
		ProviderID:      testProviderID,
		ContextWindow:   200000,
		CostPer1kInput:  0.003,
		CostPer1kOutput: 0.015,
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-fast")
	b.StartRun("req-fast", types.RunOptions{
		Prompt:      "fast test",
		ProjectPath: "/tmp",
		Model:       testModel,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit")
	}

	// Should NOT have any ToolStalledEvent.
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, ev := range c.normalized {
		if _, ok := ev.Data.(*types.ToolStalledEvent); ok {
			t.Error("did not expect ToolStalledEvent for fast tool")
		}
	}
}

// TestToolStalledEventSerializesCorrectly verifies JSON round-trip for the
// new event type.
func TestToolStalledEventSerializesCorrectly(t *testing.T) {
	orig := types.NormalizedEvent{Data: &types.ToolStalledEvent{
		ToolID:   "tool-123",
		ToolName: "Glob",
		Elapsed:  30.0,
	}}

	data, err := orig.MarshalJSON()
	if err != nil {
		t.Fatalf("MarshalJSON failed: %v", err)
	}

	var decoded types.NormalizedEvent
	if err := decoded.UnmarshalJSON(data); err != nil {
		t.Fatalf("UnmarshalJSON failed: %v", err)
	}

	stall, ok := decoded.Data.(*types.ToolStalledEvent)
	if !ok {
		t.Fatalf("expected *ToolStalledEvent, got %T", decoded.Data)
	}
	if stall.ToolID != "tool-123" || stall.ToolName != "Glob" || stall.Elapsed != 30.0 {
		t.Errorf("unexpected decoded values: %+v", stall)
	}
}
