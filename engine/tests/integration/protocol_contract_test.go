//go:build integration

package integration

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestProtocolStartSession(t *testing.T) {
	cmd := protocol.ClientCommand{
		Cmd:       "start_session",
		Key:       "test",
		RequestID: "req-1",
		Config: &types.EngineConfig{
			ProfileID:        "default",
			Extensions:       []string{"/tmp/ext"},
			WorkingDirectory: "/home/user",
		},
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	s := string(data)
	if !strings.Contains(s, `"cmd":"start_session"`) {
		t.Errorf("missing cmd field: %s", s)
	}
	if !strings.Contains(s, `"key":"test"`) {
		t.Errorf("missing key field: %s", s)
	}
	if !strings.Contains(s, `"requestId":"req-1"`) {
		t.Errorf("missing requestId field: %s", s)
	}
	if !strings.Contains(s, `"profileId":"default"`) {
		t.Errorf("missing config.profileId: %s", s)
	}

	// Round-trip parse
	parsed := protocol.ParseClientCommand(s)
	if parsed == nil {
		t.Fatal("ParseClientCommand returned nil")
	}
	if parsed.Cmd != "start_session" {
		t.Errorf("parsed Cmd: got %q, want 'start_session'", parsed.Cmd)
	}
	if parsed.Key != "test" {
		t.Errorf("parsed Key: got %q, want 'test'", parsed.Key)
	}
	if parsed.Config == nil {
		t.Fatal("parsed Config is nil")
	}
	if parsed.Config.ProfileID != "default" {
		t.Errorf("parsed Config.ProfileID: got %q", parsed.Config.ProfileID)
	}
	if len(parsed.Config.Extensions) != 1 || parsed.Config.Extensions[0] != "/tmp/ext" {
		t.Errorf("parsed Config.Extensions: got %v", parsed.Config.Extensions)
	}
}

func TestProtocolServerEvent(t *testing.T) {
	event := types.EngineEvent{
		Type:      "engine_text_delta",
		TextDelta: "Hello, world!",
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}

	line := protocol.SerializeServerEvent("sess-1", json.RawMessage(raw))

	// Must end with newline
	if !strings.HasSuffix(line, "\n") {
		t.Error("server event must end with newline")
	}

	// Must be valid JSON (without the trailing newline)
	trimmed := strings.TrimRight(line, "\n")
	var msg protocol.ServerEvent
	if err := json.Unmarshal([]byte(trimmed), &msg); err != nil {
		t.Fatalf("unmarshal server event: %v", err)
	}
	if msg.Key != "sess-1" {
		t.Errorf("Key: got %q, want 'sess-1'", msg.Key)
	}

	// Verify event payload
	var inner types.EngineEvent
	if err := json.Unmarshal(msg.Event, &inner); err != nil {
		t.Fatalf("unmarshal inner event: %v", err)
	}
	if inner.Type != "engine_text_delta" {
		t.Errorf("inner Type: got %q", inner.Type)
	}
}

func TestNormalizedEventJSON(t *testing.T) {
	tests := []struct {
		name     string
		event    types.NormalizedEvent
		wantType string
	}{
		{
			name:     "text_chunk",
			event:    types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "hello"}},
			wantType: "text_chunk",
		},
		{
			name:     "tool_call",
			event:    types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: "Read", ToolID: "tool_1", Index: 0}},
			wantType: "tool_call",
		},
		{
			name:     "tool_result",
			event:    types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: "tool_1", Content: "file content", IsError: false}},
			wantType: "tool_result",
		},
		{
			name: "task_complete",
			event: types.NormalizedEvent{Data: &types.TaskCompleteEvent{
				Result:     "Done",
				CostUsd:    0.005,
				DurationMs: 1234,
				NumTurns:   3,
				SessionID:  "sess-1",
			}},
			wantType: "task_complete",
		},
		{
			name:     "error",
			event:    types.NormalizedEvent{Data: &types.ErrorEvent{ErrorMessage: "something broke", IsError: true}},
			wantType: "error",
		},
		{
			name:     "session_dead",
			event:    types.NormalizedEvent{Data: &types.SessionDeadEvent{ExitCode: intPtr(1)}},
			wantType: "session_dead",
		},
		{
			name: "session_init",
			event: types.NormalizedEvent{Data: &types.SessionInitEvent{
				SessionID: "s1",
				Tools:     []string{"Read", "Write"},
				Model:     "test",
			}},
			wantType: "session_init",
		},
		{
			name:     "tool_call_update",
			event:    types.NormalizedEvent{Data: &types.ToolCallUpdateEvent{ToolID: "t1", PartialInput: `{"file`}},
			wantType: "tool_call_update",
		},
		{
			name:     "tool_call_complete",
			event:    types.NormalizedEvent{Data: &types.ToolCallCompleteEvent{Index: 0}},
			wantType: "tool_call_complete",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(tt.event)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			// Verify "type" field is present
			var m map[string]interface{}
			if err := json.Unmarshal(data, &m); err != nil {
				t.Fatalf("unmarshal to map: %v", err)
			}
			typ, ok := m["type"].(string)
			if !ok {
				t.Fatalf("missing 'type' field in: %s", string(data))
			}
			if typ != tt.wantType {
				t.Errorf("type: got %q, want %q", typ, tt.wantType)
			}

			// Round-trip unmarshal
			var roundTrip types.NormalizedEvent
			if err := json.Unmarshal(data, &roundTrip); err != nil {
				t.Fatalf("unmarshal roundtrip: %v", err)
			}
			if roundTrip.Data == nil {
				t.Fatal("roundtrip Data is nil")
			}
		})
	}
}

func TestEngineEventJSON(t *testing.T) {
	tests := []struct {
		name  string
		event types.EngineEvent
		check func(t *testing.T, m map[string]interface{})
	}{
		{
			name:  "text_delta",
			event: types.EngineEvent{Type: "engine_text_delta", TextDelta: "Hello"},
			check: func(t *testing.T, m map[string]interface{}) {
				if m["type"] != "engine_text_delta" {
					t.Errorf("type: %v", m["type"])
				}
				if m["text"] != "Hello" {
					t.Errorf("text: %v", m["text"])
				}
			},
		},
		{
			name: "status",
			event: types.EngineEvent{
				Type:   "engine_status",
				Fields: &types.StatusFields{Label: "test", State: "idle", Model: "m1"},
			},
			check: func(t *testing.T, m map[string]interface{}) {
				if m["type"] != "engine_status" {
					t.Errorf("type: %v", m["type"])
				}
				fields, ok := m["fields"].(map[string]interface{})
				if !ok {
					t.Fatal("fields missing")
				}
				if fields["state"] != "idle" {
					t.Errorf("state: %v", fields["state"])
				}
			},
		},
		{
			name:  "error",
			event: types.EngineEvent{Type: "engine_error", EventMessage: "oops"},
			check: func(t *testing.T, m map[string]interface{}) {
				if m["type"] != "engine_error" {
					t.Errorf("type: %v", m["type"])
				}
				if m["message"] != "oops" {
					t.Errorf("message: %v", m["message"])
				}
			},
		},
		{
			name:  "dead",
			event: types.EngineEvent{Type: "engine_dead", ExitCode: intPtr(1), Signal: strPtr("SIGTERM")},
			check: func(t *testing.T, m map[string]interface{}) {
				if m["type"] != "engine_dead" {
					t.Errorf("type: %v", m["type"])
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(tt.event)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			var m map[string]interface{}
			if err := json.Unmarshal(data, &m); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			tt.check(t, m)
		})
	}
}

func TestNDJSONFraming(t *testing.T) {
	// All serialization functions should produce newline-terminated single lines

	t.Run("ServerEvent", func(t *testing.T) {
		event := types.EngineEvent{Type: "engine_text_delta", TextDelta: "line1\nline2"}
		raw, _ := json.Marshal(event)
		line := protocol.SerializeServerEvent("key", json.RawMessage(raw))

		if !strings.HasSuffix(line, "\n") {
			t.Error("must end with newline")
		}
		// The JSON itself should be on a single line (no embedded raw newlines)
		trimmed := strings.TrimRight(line, "\n")
		if strings.Contains(trimmed, "\n") {
			t.Error("NDJSON line must not contain embedded newlines")
		}
	})

	t.Run("ServerResult", func(t *testing.T) {
		line := protocol.SerializeServerResult(protocol.ServerResult{
			RequestID: "req-1",
			OK:        true,
		})
		if !strings.HasSuffix(line, "\n") {
			t.Error("must end with newline")
		}
		trimmed := strings.TrimRight(line, "\n")
		if strings.Contains(trimmed, "\n") {
			t.Error("must be single line")
		}
	})

	t.Run("SessionList", func(t *testing.T) {
		line := protocol.SerializeServerSessionList([]protocol.SessionInfo{
			{Key: "a", HasActiveRun: true, ToolCount: 5},
			{Key: "b", HasActiveRun: false, ToolCount: 0},
		})
		if !strings.HasSuffix(line, "\n") {
			t.Error("must end with newline")
		}
		trimmed := strings.TrimRight(line, "\n")
		if strings.Contains(trimmed, "\n") {
			t.Error("must be single line")
		}
	})
}

func TestProtocolParseAllCommands(t *testing.T) {
	tests := []struct {
		name  string
		json  string
		valid bool
	}{
		{"start_session", `{"cmd":"start_session","key":"k","config":{"profileId":"p","extensionDir":"/","workingDirectory":"/"}}`, true},
		{"send_prompt", `{"cmd":"send_prompt","key":"k","text":"hello"}`, true},
		{"abort", `{"cmd":"abort","key":"k"}`, true},
		{"stop_session", `{"cmd":"stop_session","key":"k"}`, true},
		{"list_sessions", `{"cmd":"list_sessions"}`, true},
		{"shutdown", `{"cmd":"shutdown"}`, true},
		{"fork_session", `{"cmd":"fork_session","key":"k","messageIndex":5}`, true},
		{"set_plan_mode", `{"cmd":"set_plan_mode","key":"k","enabled":true}`, true},
		{"branch", `{"cmd":"branch","key":"k","entryId":"abc123"}`, true},
		{"navigate_tree", `{"cmd":"navigate_tree","key":"k","targetId":"abc123"}`, true},
		{"get_tree", `{"cmd":"get_tree","key":"k"}`, true},
		{"stop_by_prefix", `{"cmd":"stop_by_prefix","prefix":"app-"}`, true},
		{"missing_key", `{"cmd":"start_session"}`, false},
		{"unknown_cmd", `{"cmd":"dance"}`, false},
		{"invalid_json", `not json`, false},
		{"empty_key", `{"cmd":"abort","key":""}`, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := protocol.ParseClientCommand(tt.json)
			if tt.valid && result == nil {
				t.Error("expected valid parse, got nil")
			}
			if !tt.valid && result != nil {
				t.Error("expected nil for invalid command")
			}
		})
	}
}

func intPtr(v int) *int       { return &v }
func strPtr(v string) *string { return &v }
