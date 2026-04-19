package normalizer

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func TestNormalizeSystemInit(t *testing.T) {
	raw := mustJSON(map[string]any{
		"type":                "system",
		"subtype":             "init",
		"session_id":          "sess-1",
		"tools":               []string{"bash", "read"},
		"model":               "claude-3-opus",
		"mcp_servers":         []map[string]any{{"name": "git", "status": "connected"}},
		"skills":              []string{},
		"claude_code_version": "1.0.0",
		"cwd":                 "/tmp",
	})

	events := Normalize(raw)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}

	init, ok := events[0].Data.(*types.SessionInitEvent)
	if !ok {
		t.Fatalf("expected SessionInitEvent, got %T", events[0].Data)
	}
	if init.SessionID != "sess-1" {
		t.Errorf("expected sess-1, got %q", init.SessionID)
	}
	if init.Model != "claude-3-opus" {
		t.Errorf("expected claude-3-opus, got %q", init.Model)
	}
}

func TestNormalizeStreamTextDelta(t *testing.T) {
	idx := 0
	raw := mustJSON(types.StreamEvent{
		Type: "stream_event",
		Event: types.StreamSubEvent{
			Type:  "content_block_delta",
			Index: &idx,
			Delta: &types.ContentDelta{
				Type: "text_delta",
				Text: "Hello world",
			},
		},
		SessionID: "sess-1",
	})

	events := Normalize(raw)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}

	chunk, ok := events[0].Data.(*types.TextChunkEvent)
	if !ok {
		t.Fatalf("expected TextChunkEvent, got %T", events[0].Data)
	}
	if chunk.Text != "Hello world" {
		t.Errorf("expected 'Hello world', got %q", chunk.Text)
	}
}

func TestNormalizeStreamToolUse(t *testing.T) {
	idx := 1
	raw := mustJSON(types.StreamEvent{
		Type: "stream_event",
		Event: types.StreamSubEvent{
			Type:  "content_block_start",
			Index: &idx,
			ContentBlock: &types.ContentBlock{
				Type: "tool_use",
				ID:   "tool-abc",
				Name: "bash",
			},
		},
		SessionID: "sess-1",
	})

	events := Normalize(raw)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}

	tc, ok := events[0].Data.(*types.ToolCallEvent)
	if !ok {
		t.Fatalf("expected ToolCallEvent, got %T", events[0].Data)
	}
	if tc.ToolName != "bash" {
		t.Errorf("expected bash, got %q", tc.ToolName)
	}
	if tc.ToolID != "tool-abc" {
		t.Errorf("expected tool-abc, got %q", tc.ToolID)
	}
}

func TestNormalizeResult(t *testing.T) {
	tests := []struct {
		name    string
		raw     json.RawMessage
		wantErr bool
	}{
		{
			name: "success result",
			raw: mustJSON(map[string]any{
				"type":           "result",
				"subtype":        "success",
				"is_error":       false,
				"result":         "Task completed",
				"duration_ms":    1500,
				"num_turns":      3,
				"total_cost_usd": 0.05,
				"session_id":     "sess-1",
				"usage":          map[string]any{},
			}),
		},
		{
			name: "error result",
			raw: mustJSON(map[string]any{
				"type":        "result",
				"subtype":     "error",
				"is_error":    true,
				"result":      "Something failed",
				"duration_ms": 500,
				"num_turns":   1,
				"session_id":  "sess-1",
				"usage":       map[string]any{},
			}),
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			events := Normalize(tt.raw)
			if len(events) != 1 {
				t.Fatalf("expected 1 event, got %d", len(events))
			}
			if tt.wantErr {
				_, ok := events[0].Data.(*types.ErrorEvent)
				if !ok {
					t.Errorf("expected ErrorEvent, got %T", events[0].Data)
				}
			} else {
				_, ok := events[0].Data.(*types.TaskCompleteEvent)
				if !ok {
					t.Errorf("expected TaskCompleteEvent, got %T", events[0].Data)
				}
			}
		})
	}
}

func TestNormalizeRateLimit(t *testing.T) {
	raw := mustJSON(map[string]any{
		"type":       "rate_limit_event",
		"session_id": "sess-1",
		"rate_limit_info": map[string]any{
			"status":        "rate_limited",
			"resetsAt":      1700000000,
			"rateLimitType": "token",
		},
	})

	events := Normalize(raw)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}

	rl, ok := events[0].Data.(*types.RateLimitNormalizedEvent)
	if !ok {
		t.Fatalf("expected RateLimitNormalizedEvent, got %T", events[0].Data)
	}
	if rl.Status != "rate_limited" {
		t.Errorf("expected rate_limited, got %q", rl.Status)
	}
}

func TestNormalizePermissionRequest(t *testing.T) {
	raw := mustJSON(map[string]any{
		"type":        "permission_request",
		"question_id": "q-1",
		"tool": map[string]any{
			"name":        "bash",
			"description": "Run a shell command",
			"input":       map[string]any{"command": "rm -rf /"},
		},
		"options": []map[string]any{
			{"id": "allow", "label": "Allow"},
			{"id": "deny", "label": "Deny"},
		},
		"session_id": "sess-1",
	})

	events := Normalize(raw)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}

	pe, ok := events[0].Data.(*types.PermissionRequestEvent)
	if !ok {
		t.Fatalf("expected PermissionRequestEvent, got %T", events[0].Data)
	}
	if pe.ToolName != "bash" {
		t.Errorf("expected bash, got %q", pe.ToolName)
	}
	if pe.QuestionID != "q-1" {
		t.Errorf("expected q-1, got %q", pe.QuestionID)
	}
}

func TestNormalizeUnknownType(t *testing.T) {
	raw := mustJSON(map[string]any{"type": "unknown_event"})
	events := Normalize(raw)
	if len(events) != 0 {
		t.Errorf("expected 0 events for unknown type, got %d", len(events))
	}
}

func TestNormalizeInvalidJSON(t *testing.T) {
	events := Normalize(json.RawMessage(`{invalid json`))
	if len(events) != 0 {
		t.Errorf("expected 0 events for invalid JSON, got %d", len(events))
	}
}
