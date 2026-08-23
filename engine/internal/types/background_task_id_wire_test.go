package types

import (
	"encoding/json"
	"testing"
)

func TestToolResultEvent_BackgroundTaskID_Wire(t *testing.T) {
	ev := ToolResultEvent{
		ToolID:           "toolu_bg",
		Content:          "task started",
		BackgroundTaskID: "task-123",
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m["backgroundTaskId"] != "task-123" {
		t.Fatalf("backgroundTaskId = %v, want task-123", m["backgroundTaskId"])
	}
}

func TestToolResultEvent_BackgroundTaskID_OmittedWhenEmpty(t *testing.T) {
	ev := ToolResultEvent{
		ToolID:  "toolu_sync",
		Content: "ok",
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if _, exists := m["backgroundTaskId"]; exists {
		t.Fatal("backgroundTaskId should be omitted for sync result")
	}
}

func TestEngineEvent_ToolBackgroundTaskID_Wire(t *testing.T) {
	ev := EngineEvent{
		Type:                 "engine_tool_end",
		ToolID:               "toolu_bg",
		ToolResult:           "dispatched",
		ToolBackgroundTaskID: "dispatch-456",
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m["backgroundTaskId"] != "dispatch-456" {
		t.Fatalf("backgroundTaskId = %v, want dispatch-456", m["backgroundTaskId"])
	}
}

func TestEngineEvent_ToolBackgroundTaskID_OmittedWhenEmpty(t *testing.T) {
	ev := EngineEvent{
		Type:       "engine_tool_end",
		ToolID:     "toolu_sync",
		ToolResult: "ok",
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if _, exists := m["backgroundTaskId"]; exists {
		t.Fatal("backgroundTaskId should be omitted when empty")
	}
}

func TestSessionMessage_BackgroundTaskID_Wire(t *testing.T) {
	msg := SessionMessage{
		Role:             "tool",
		Content:          "task started",
		BackgroundTaskID: "task-789",
		Timestamp:        1234567890,
	}
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m["backgroundTaskId"] != "task-789" {
		t.Fatalf("backgroundTaskId = %v, want task-789", m["backgroundTaskId"])
	}
}
