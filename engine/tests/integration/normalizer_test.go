//go:build integration

package integration

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/normalizer"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestNormalizerInitEvent(t *testing.T) {
	raw := json.RawMessage(`{
		"type": "system",
		"subtype": "init",
		"cwd": "/home/user",
		"session_id": "sess-001",
		"tools": ["Read", "Write", "Bash"],
		"mcp_servers": [{"name": "test-server", "status": "connected"}],
		"model": "claude-sonnet-4-6",
		"permissionMode": "auto",
		"agents": [],
		"skills": ["code", "refactor"],
		"plugins": [],
		"claude_code_version": "1.0.0",
		"fast_mode_state": "off",
		"uuid": "abc-123"
	}`)

	events := normalizer.Normalize(raw)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}

	init, ok := events[0].Data.(*types.SessionInitEvent)
	if !ok {
		t.Fatalf("expected SessionInitEvent, got %T", events[0].Data)
	}

	if init.SessionID != "sess-001" {
		t.Errorf("SessionID: got %q", init.SessionID)
	}
	if len(init.Tools) != 3 {
		t.Errorf("Tools: got %d, want 3", len(init.Tools))
	}
	if init.Model != "claude-sonnet-4-6" {
		t.Errorf("Model: got %q", init.Model)
	}
	if len(init.McpServers) != 1 {
		t.Errorf("McpServers: got %d", len(init.McpServers))
	}
	if init.McpServers[0].Name != "test-server" {
		t.Errorf("McpServer name: got %q", init.McpServers[0].Name)
	}
	if len(init.Skills) != 2 {
		t.Errorf("Skills: got %d", len(init.Skills))
	}
	if init.Version != "1.0.0" {
		t.Errorf("Version: got %q", init.Version)
	}
}

func TestNormalizerStreamEvents(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		wantCount int
		check     func(t *testing.T, events []types.NormalizedEvent)
	}{
		{
			name: "content_block_start_tool_use",
			raw: `{
				"type": "stream_event",
				"event": {
					"type": "content_block_start",
					"index": 0,
					"content_block": {"type": "tool_use", "id": "tool_1", "name": "Read"}
				},
				"session_id": "s1",
				"uuid": "u1"
			}`,
			wantCount: 1,
			check: func(t *testing.T, events []types.NormalizedEvent) {
				tc, ok := events[0].Data.(*types.ToolCallEvent)
				if !ok {
					t.Fatalf("expected ToolCallEvent, got %T", events[0].Data)
				}
				if tc.ToolName != "Read" {
					t.Errorf("ToolName: got %q", tc.ToolName)
				}
				if tc.ToolID != "tool_1" {
					t.Errorf("ToolID: got %q", tc.ToolID)
				}
				if tc.Index != 0 {
					t.Errorf("Index: got %d", tc.Index)
				}
			},
		},
		{
			name: "content_block_delta_text",
			raw: `{
				"type": "stream_event",
				"event": {
					"type": "content_block_delta",
					"delta": {"type": "text_delta", "text": "Hello"}
				},
				"session_id": "s1",
				"uuid": "u1"
			}`,
			wantCount: 1,
			check: func(t *testing.T, events []types.NormalizedEvent) {
				tc, ok := events[0].Data.(*types.TextChunkEvent)
				if !ok {
					t.Fatalf("expected TextChunkEvent, got %T", events[0].Data)
				}
				if tc.Text != "Hello" {
					t.Errorf("Text: got %q", tc.Text)
				}
			},
		},
		{
			name: "content_block_delta_input_json",
			raw: `{
				"type": "stream_event",
				"event": {
					"type": "content_block_delta",
					"delta": {"type": "input_json_delta", "partial_json": "{\"file"}
				},
				"session_id": "s1",
				"uuid": "u1"
			}`,
			wantCount: 1,
			check: func(t *testing.T, events []types.NormalizedEvent) {
				tcu, ok := events[0].Data.(*types.ToolCallUpdateEvent)
				if !ok {
					t.Fatalf("expected ToolCallUpdateEvent, got %T", events[0].Data)
				}
				if tcu.PartialInput != `{"file` {
					t.Errorf("PartialInput: got %q", tcu.PartialInput)
				}
			},
		},
		{
			name: "content_block_stop",
			raw: `{
				"type": "stream_event",
				"event": {"type": "content_block_stop", "index": 2},
				"session_id": "s1",
				"uuid": "u1"
			}`,
			wantCount: 1,
			check: func(t *testing.T, events []types.NormalizedEvent) {
				tcc, ok := events[0].Data.(*types.ToolCallCompleteEvent)
				if !ok {
					t.Fatalf("expected ToolCallCompleteEvent, got %T", events[0].Data)
				}
				if tcc.Index != 2 {
					t.Errorf("Index: got %d", tcc.Index)
				}
			},
		},
		{
			// TS parity: message_delta usage is suppressed (TS returns [] for message_delta).
			// Final usage arrives via task_complete. See G41 (pass 2.5).
			name: "message_delta_with_usage",
			raw: `{
				"type": "stream_event",
				"event": {
					"type": "message_delta",
					"usage": {"input_tokens": 100, "output_tokens": 50}
				},
				"session_id": "s1",
				"uuid": "u1"
			}`,
			wantCount: 0,
			check:     nil,
		},
		{
			name: "message_start_no_event",
			raw: `{
				"type": "stream_event",
				"event": {"type": "message_start", "message": {"id": "msg_1", "model": "test", "role": "assistant", "content": []}},
				"session_id": "s1",
				"uuid": "u1"
			}`,
			wantCount: 0,
			check:     nil,
		},
		{
			name: "message_start_with_cache_tokens_emits_usage",
			raw: `{
				"type": "stream_event",
				"event": {
					"type": "message_start",
					"message": {
						"id": "msg_1", "model": "test", "role": "assistant", "content": [],
						"usage": {"input_tokens": 50, "cache_read_input_tokens": 200}
					}
				},
				"session_id": "s1",
				"uuid": "u1"
			}`,
			wantCount: 1,
			check: func(t *testing.T, events []types.NormalizedEvent) {
				ue, ok := events[0].Data.(*types.UsageEvent)
				if !ok {
					t.Fatalf("expected UsageEvent from message_start, got %T", events[0].Data)
				}
				if ue.Usage.CacheReadInputTokens == nil || *ue.Usage.CacheReadInputTokens != 200 {
					t.Errorf("expected CacheReadInputTokens=200, got %v", ue.Usage.CacheReadInputTokens)
				}
			},
		},
		{
			name: "message_stop_no_event",
			raw: `{
				"type": "stream_event",
				"event": {"type": "message_stop"},
				"session_id": "s1",
				"uuid": "u1"
			}`,
			wantCount: 0,
			check:     nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			events := normalizer.Normalize(json.RawMessage(tt.raw))
			if len(events) != tt.wantCount {
				t.Fatalf("got %d events, want %d", len(events), tt.wantCount)
			}
			if tt.check != nil {
				tt.check(t, events)
			}
		})
	}
}

func TestNormalizerResultEvent(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		raw := json.RawMessage(`{
			"type": "result",
			"subtype": "success",
			"is_error": false,
			"duration_ms": 5000,
			"num_turns": 3,
			"result": "Task completed successfully.",
			"total_cost_usd": 0.025,
			"session_id": "sess-result",
			"usage": {"input_tokens": 1000, "output_tokens": 500},
			"permission_denials": [],
			"uuid": "u1"
		}`)

		events := normalizer.Normalize(raw)
		if len(events) != 1 {
			t.Fatalf("expected 1 event, got %d", len(events))
		}

		tc, ok := events[0].Data.(*types.TaskCompleteEvent)
		if !ok {
			t.Fatalf("expected TaskCompleteEvent, got %T", events[0].Data)
		}
		if tc.Result != "Task completed successfully." {
			t.Errorf("Result: got %q", tc.Result)
		}
		if tc.CostUsd != 0.025 {
			t.Errorf("CostUsd: got %f", tc.CostUsd)
		}
		if tc.DurationMs != 5000 {
			t.Errorf("DurationMs: got %d", tc.DurationMs)
		}
		if tc.NumTurns != 3 {
			t.Errorf("NumTurns: got %d", tc.NumTurns)
		}
		if tc.SessionID != "sess-result" {
			t.Errorf("SessionID: got %q", tc.SessionID)
		}
	})

	t.Run("error", func(t *testing.T) {
		raw := json.RawMessage(`{
			"type": "result",
			"subtype": "error",
			"is_error": true,
			"duration_ms": 100,
			"num_turns": 0,
			"result": "API key invalid",
			"total_cost_usd": 0,
			"session_id": "sess-err",
			"usage": {},
			"permission_denials": [],
			"uuid": "u1"
		}`)

		events := normalizer.Normalize(raw)
		if len(events) != 1 {
			t.Fatalf("expected 1 event, got %d", len(events))
		}

		ee, ok := events[0].Data.(*types.ErrorEvent)
		if !ok {
			t.Fatalf("expected ErrorEvent, got %T", events[0].Data)
		}
		if ee.ErrorMessage != "API key invalid" {
			t.Errorf("ErrorMessage: got %q", ee.ErrorMessage)
		}
		if !ee.IsError {
			t.Error("expected IsError=true")
		}
	})
}

func TestNormalizerRoundTrip(t *testing.T) {
	events := []types.NormalizedEvent{
		{Data: &types.TextChunkEvent{Text: "hello world"}},
		{Data: &types.ToolCallEvent{ToolName: "Read", ToolID: "t1", Index: 0}},
		{Data: &types.ToolResultEvent{ToolID: "t1", Content: "file content", IsError: false}},
		{Data: &types.TaskCompleteEvent{Result: "done", CostUsd: 0.01, DurationMs: 100, NumTurns: 1, SessionID: "s1"}},
		{Data: &types.ErrorEvent{ErrorMessage: "failed", IsError: true}},
		{Data: &types.SessionInitEvent{SessionID: "s1", Tools: []string{"Read"}, Model: "test"}},
	}

	for _, ev := range events {
		data, err := json.Marshal(ev)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		var roundTrip types.NormalizedEvent
		if err := json.Unmarshal(data, &roundTrip); err != nil {
			t.Fatalf("unmarshal: %v (json: %s)", err, string(data))
		}

		// Re-marshal and compare
		data2, err := json.Marshal(roundTrip)
		if err != nil {
			t.Fatalf("re-marshal: %v", err)
		}

		if string(data) != string(data2) {
			t.Errorf("round-trip mismatch:\n  original:  %s\n  roundtrip: %s", string(data), string(data2))
		}
	}
}

func TestNormalizerRateLimitEvent(t *testing.T) {
	raw := json.RawMessage(`{
		"type": "rate_limit_event",
		"rate_limit_info": {
			"status": "active",
			"resetsAt": 1700000000,
			"rateLimitType": "tokens"
		},
		"session_id": "s1",
		"uuid": "u1"
	}`)

	events := normalizer.Normalize(raw)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}

	rl, ok := events[0].Data.(*types.RateLimitNormalizedEvent)
	if !ok {
		t.Fatalf("expected RateLimitNormalizedEvent, got %T", events[0].Data)
	}
	if rl.Status != "active" {
		t.Errorf("Status: got %q", rl.Status)
	}
	if rl.ResetsAt != 1700000000 {
		t.Errorf("ResetsAt: got %d", rl.ResetsAt)
	}
}

func TestNormalizerPermissionRequest(t *testing.T) {
	raw := json.RawMessage(`{
		"type": "permission_request",
		"tool": {"name": "Bash", "description": "Execute command", "input": {"command": "rm -rf /"}},
		"question_id": "q1",
		"options": [{"id": "allow", "label": "Allow"}, {"id": "deny", "label": "Deny"}],
		"session_id": "s1",
		"uuid": "u1"
	}`)

	events := normalizer.Normalize(raw)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}

	pr, ok := events[0].Data.(*types.PermissionRequestEvent)
	if !ok {
		t.Fatalf("expected PermissionRequestEvent, got %T", events[0].Data)
	}
	if pr.QuestionID != "q1" {
		t.Errorf("QuestionID: got %q", pr.QuestionID)
	}
	if pr.ToolName != "Bash" {
		t.Errorf("ToolName: got %q", pr.ToolName)
	}
	if len(pr.Options) != 2 {
		t.Errorf("Options: got %d", len(pr.Options))
	}
}

func TestNormalizerUnknownType(t *testing.T) {
	raw := json.RawMessage(`{"type": "unknown_event_type", "data": "something"}`)
	events := normalizer.Normalize(raw)
	if len(events) != 0 {
		t.Errorf("expected 0 events for unknown type, got %d", len(events))
	}
}
