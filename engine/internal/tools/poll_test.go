package tools

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestPollToolRequiresSessionStarter(t *testing.T) {
	result, err := PollTool().Execute(context.Background(), map[string]any{"intent": "check a build"}, t.TempDir())
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !result.IsError {
		t.Fatalf("Poll without starter = %#v, want error", result)
	}
}

func TestPollToolForwardsRequest(t *testing.T) {
	var got PollRequest
	ctx := WithPollStarter(context.Background(), func(_ context.Context, request PollRequest, _ string) (string, error) {
		got = request
		return "poll-1", nil
	})
	result, err := PollTool().Execute(ctx, map[string]any{"intent": "check a build", "check_command": "make test", "interval_ms": float64(1000), "deadline_ms": float64(5000), "max_attempts": float64(1), "model": "fast"}, t.TempDir())
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if result.IsError || result.BackgroundTaskID != "poll-1" {
		t.Fatalf("Poll result = %#v", result)
	}
	if got.Intent != "check a build" || got.CheckCommand != "make test" || got.Interval != time.Second || got.Deadline != 5*time.Second || got.MaxAttempts != 1 || got.Model != "fast" {
		t.Fatalf("forwarded request = %#v", got)
	}
	if !strings.Contains(result.Content, "automatic delivery") {
		t.Errorf("start result omits automatic Agent delivery boundary: %q", result.Content)
	}
}

func TestPollDescriptionDefinesNarrowUseBoundary(t *testing.T) {
	def := PollTool()
	for _, phrase := range []string{"external state", "no completion callback", "Never use Poll to wait for Agent or dispatch completion", "directly observe", "Sparingly"} {
		if !strings.Contains(def.Description, phrase) {
			t.Errorf("Poll description missing %q: %s", phrase, def.Description)
		}
	}
	props, _ := def.InputSchema["properties"].(map[string]any)
	check, _ := props["check_command"].(map[string]any)
	desc, _ := check["description"].(string)
	if !strings.Contains(desc, "directly observes the intent") {
		t.Errorf("check_command does not require observable evidence: %q", desc)
	}
}

func TestPollToolIsNotPlanModeSafe(t *testing.T) {
	if PollTool().PlanModeSafe {
		t.Fatal("Poll must not be exposed in plan mode")
	}
}
