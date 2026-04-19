package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseClientCommand_ValidCommands(t *testing.T) {
	tests := []struct {
		name string
		line string
		cmd  string
	}{
		{
			name: "start_session",
			line: `{"cmd":"start_session","key":"s1","config":{"profileId":"p","extensionDir":"/ext","workingDirectory":"/tmp"}}`,
			cmd:  "start_session",
		},
		{
			name: "start_session with requestId",
			line: `{"cmd":"start_session","key":"s1","config":{"profileId":"p","extensionDir":"/ext","workingDirectory":"/tmp"},"requestId":"r1"}`,
			cmd:  "start_session",
		},
		{
			name: "send_prompt",
			line: `{"cmd":"send_prompt","key":"s1","text":"hello"}`,
			cmd:  "send_prompt",
		},
		{
			name: "send_prompt with empty text",
			line: `{"cmd":"send_prompt","key":"s1","text":""}`,
			cmd:  "send_prompt",
		},
		{
			name: "abort",
			line: `{"cmd":"abort","key":"s1"}`,
			cmd:  "abort",
		},
		{
			name: "abort_agent",
			line: `{"cmd":"abort_agent","key":"s1","agentName":"coder"}`,
			cmd:  "abort_agent",
		},
		{
			name: "abort_agent with subtree",
			line: `{"cmd":"abort_agent","key":"s1","agentName":"coder","subtree":true}`,
			cmd:  "abort_agent",
		},
		{
			name: "steer_agent",
			line: `{"cmd":"steer_agent","key":"s1","agentName":"coder","message":"focus on tests"}`,
			cmd:  "steer_agent",
		},
		{
			name: "dialog_response",
			line: `{"cmd":"dialog_response","key":"s1","dialogId":"d1","value":"yes"}`,
			cmd:  "dialog_response",
		},
		{
			name: "command",
			line: `{"cmd":"command","key":"s1","command":"status","args":"--verbose"}`,
			cmd:  "command",
		},
		{
			name: "stop_session",
			line: `{"cmd":"stop_session","key":"s1"}`,
			cmd:  "stop_session",
		},
		{
			name: "stop_by_prefix",
			line: `{"cmd":"stop_by_prefix","prefix":"proj-"}`,
			cmd:  "stop_by_prefix",
		},
		{
			name: "list_sessions",
			line: `{"cmd":"list_sessions"}`,
			cmd:  "list_sessions",
		},
		{
			name: "list_sessions with requestId",
			line: `{"cmd":"list_sessions","requestId":"r1"}`,
			cmd:  "list_sessions",
		},
		{
			name: "fork_session",
			line: `{"cmd":"fork_session","key":"s1","messageIndex":5}`,
			cmd:  "fork_session",
		},
		{
			name: "fork_session with index 0",
			line: `{"cmd":"fork_session","key":"s1","messageIndex":0}`,
			cmd:  "fork_session",
		},
		{
			name: "set_plan_mode enabled",
			line: `{"cmd":"set_plan_mode","key":"s1","enabled":true}`,
			cmd:  "set_plan_mode",
		},
		{
			name: "set_plan_mode disabled",
			line: `{"cmd":"set_plan_mode","key":"s1","enabled":false}`,
			cmd:  "set_plan_mode",
		},
		{
			name: "set_plan_mode with allowedTools",
			line: `{"cmd":"set_plan_mode","key":"s1","enabled":true,"allowedTools":["read","write"]}`,
			cmd:  "set_plan_mode",
		},
		{
			name: "branch",
			line: `{"cmd":"branch","key":"s1","entryId":"e1"}`,
			cmd:  "branch",
		},
		{
			name: "navigate_tree",
			line: `{"cmd":"navigate_tree","key":"s1","targetId":"t1"}`,
			cmd:  "navigate_tree",
		},
		{
			name: "get_tree",
			line: `{"cmd":"get_tree","key":"s1"}`,
			cmd:  "get_tree",
		},
		{
			name: "shutdown",
			line: `{"cmd":"shutdown"}`,
			cmd:  "shutdown",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ParseClientCommand(tt.line)
			if result == nil {
				t.Fatalf("expected non-nil result for %s", tt.name)
			}
			if result.Cmd != tt.cmd {
				t.Errorf("got cmd %q, want %q", result.Cmd, tt.cmd)
			}
		})
	}
}

func TestParseClientCommand_MissingRequired(t *testing.T) {
	tests := []struct {
		name string
		line string
	}{
		{
			name: "start_session missing key",
			line: `{"cmd":"start_session","config":{"profileId":"p","extensionDir":"/ext","workingDirectory":"/tmp"}}`,
		},
		{
			name: "start_session missing config",
			line: `{"cmd":"start_session","key":"s1"}`,
		},
		{
			name: "send_prompt missing key",
			line: `{"cmd":"send_prompt","text":"hello"}`,
		},
		{
			name: "send_prompt missing text",
			line: `{"cmd":"send_prompt","key":"s1"}`,
		},
		{
			name: "send_prompt text is number",
			line: `{"cmd":"send_prompt","key":"s1","text":42}`,
		},
		{
			name: "abort missing key",
			line: `{"cmd":"abort"}`,
		},
		{
			name: "abort_agent missing key",
			line: `{"cmd":"abort_agent","agentName":"coder"}`,
		},
		{
			name: "abort_agent missing agentName",
			line: `{"cmd":"abort_agent","key":"s1"}`,
		},
		{
			name: "steer_agent missing message",
			line: `{"cmd":"steer_agent","key":"s1","agentName":"coder"}`,
		},
		{
			name: "steer_agent missing agentName",
			line: `{"cmd":"steer_agent","key":"s1","message":"hi"}`,
		},
		{
			name: "stop_by_prefix missing prefix",
			line: `{"cmd":"stop_by_prefix"}`,
		},
		{
			name: "dialog_response missing dialogId",
			line: `{"cmd":"dialog_response","key":"s1"}`,
		},
		{
			name: "command missing command field",
			line: `{"cmd":"command","key":"s1"}`,
		},
		{
			name: "fork_session missing messageIndex",
			line: `{"cmd":"fork_session","key":"s1"}`,
		},
		{
			name: "fork_session messageIndex is string",
			line: `{"cmd":"fork_session","key":"s1","messageIndex":"5"}`,
		},
		{
			name: "set_plan_mode missing enabled",
			line: `{"cmd":"set_plan_mode","key":"s1"}`,
		},
		{
			name: "set_plan_mode enabled is string",
			line: `{"cmd":"set_plan_mode","key":"s1","enabled":"true"}`,
		},
		{
			name: "branch missing entryId",
			line: `{"cmd":"branch","key":"s1"}`,
		},
		{
			name: "navigate_tree missing targetId",
			line: `{"cmd":"navigate_tree","key":"s1"}`,
		},
		{
			name: "get_tree missing key",
			line: `{"cmd":"get_tree"}`,
		},
		{
			name: "stop_session missing key",
			line: `{"cmd":"stop_session"}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ParseClientCommand(tt.line)
			if result != nil {
				t.Errorf("expected nil for %s, got %+v", tt.name, result)
			}
		})
	}
}

func TestParseClientCommand_InvalidInput(t *testing.T) {
	tests := []struct {
		name string
		line string
	}{
		{name: "empty string", line: ""},
		{name: "not json", line: "hello world"},
		{name: "json array", line: `[1,2,3]`},
		{name: "json number", line: `42`},
		{name: "json string", line: `"hello"`},
		{name: "missing cmd", line: `{"key":"s1"}`},
		{name: "empty cmd", line: `{"cmd":""}`},
		{name: "unknown cmd", line: `{"cmd":"unknown_thing"}`},
		{name: "cmd is number", line: `{"cmd":42}`},
		{name: "null object", line: `null`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ParseClientCommand(tt.line)
			if result != nil {
				t.Errorf("expected nil for %s, got %+v", tt.name, result)
			}
		})
	}
}

func TestParseClientCommand_FieldValues(t *testing.T) {
	line := `{"cmd":"start_session","key":"my-session","config":{"profileId":"default","extensionDir":"/ext","workingDirectory":"/home/user"},"requestId":"req-1"}`
	result := ParseClientCommand(line)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.Key != "my-session" {
		t.Errorf("key = %q, want %q", result.Key, "my-session")
	}
	if result.RequestID != "req-1" {
		t.Errorf("requestId = %q, want %q", result.RequestID, "req-1")
	}
	if result.Config == nil {
		t.Fatal("config is nil")
	}
	if result.Config.ProfileID != "default" {
		t.Errorf("config.profileId = %q, want %q", result.Config.ProfileID, "default")
	}
	if result.Config.WorkingDirectory != "/home/user" {
		t.Errorf("config.workingDirectory = %q, want %q", result.Config.WorkingDirectory, "/home/user")
	}
}

func TestParseClientCommand_ForkSessionValues(t *testing.T) {
	line := `{"cmd":"fork_session","key":"s1","messageIndex":7,"requestId":"r2"}`
	result := ParseClientCommand(line)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.MessageIndex == nil || *result.MessageIndex != 7 {
		t.Errorf("messageIndex = %v, want 7", result.MessageIndex)
	}
}

func TestParseClientCommand_SetPlanModeValues(t *testing.T) {
	line := `{"cmd":"set_plan_mode","key":"s1","enabled":false,"allowedTools":["read","write"]}`
	result := ParseClientCommand(line)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.Enabled == nil || *result.Enabled != false {
		t.Errorf("enabled = %v, want false", result.Enabled)
	}
	if len(result.AllowedTools) != 2 || result.AllowedTools[0] != "read" || result.AllowedTools[1] != "write" {
		t.Errorf("allowedTools = %v, want [read write]", result.AllowedTools)
	}
}

func TestSerializeServerEvent(t *testing.T) {
	event := json.RawMessage(`{"type":"engine_text_delta","text":"hello"}`)
	result := SerializeServerEvent("s1", event)

	if !strings.HasSuffix(result, "\n") {
		t.Error("expected trailing newline")
	}

	var parsed ServerEvent
	if err := json.Unmarshal([]byte(strings.TrimSpace(result)), &parsed); err != nil {
		t.Fatalf("failed to parse serialized event: %v", err)
	}
	if parsed.Key != "s1" {
		t.Errorf("key = %q, want %q", parsed.Key, "s1")
	}

	var eventObj map[string]any
	if err := json.Unmarshal(parsed.Event, &eventObj); err != nil {
		t.Fatalf("failed to parse event: %v", err)
	}
	if eventObj["type"] != "engine_text_delta" {
		t.Errorf("event type = %v, want engine_text_delta", eventObj["type"])
	}
}

func TestSerializeServerResult(t *testing.T) {
	msg := ServerResult{
		RequestID: "r1",
		OK:        true,
		Data:      map[string]any{"count": float64(3)},
	}
	result := SerializeServerResult(msg)

	if !strings.HasSuffix(result, "\n") {
		t.Error("expected trailing newline")
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(result)), &parsed); err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	if parsed["cmd"] != "result" {
		t.Errorf("cmd = %v, want result", parsed["cmd"])
	}
	if parsed["requestId"] != "r1" {
		t.Errorf("requestId = %v, want r1", parsed["requestId"])
	}
	if parsed["ok"] != true {
		t.Errorf("ok = %v, want true", parsed["ok"])
	}
}

func TestSerializeServerResult_WithError(t *testing.T) {
	msg := ServerResult{
		RequestID: "r2",
		OK:        false,
		Error:     "session not found",
	}
	result := SerializeServerResult(msg)

	var parsed map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(result)), &parsed); err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	if parsed["ok"] != false {
		t.Errorf("ok = %v, want false", parsed["ok"])
	}
	if parsed["error"] != "session not found" {
		t.Errorf("error = %v, want 'session not found'", parsed["error"])
	}
}

func TestSerializeServerSessionList(t *testing.T) {
	sessions := []SessionInfo{
		{Key: "s1", HasActiveRun: true, ToolCount: 3},
		{Key: "s2", HasActiveRun: false, ToolCount: 0},
	}
	result := SerializeServerSessionList(sessions)

	if !strings.HasSuffix(result, "\n") {
		t.Error("expected trailing newline")
	}

	var parsed ServerSessionList
	if err := json.Unmarshal([]byte(strings.TrimSpace(result)), &parsed); err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	if parsed.Cmd != "session_list" {
		t.Errorf("cmd = %q, want session_list", parsed.Cmd)
	}
	if len(parsed.Sessions) != 2 {
		t.Fatalf("sessions len = %d, want 2", len(parsed.Sessions))
	}
	if parsed.Sessions[0].Key != "s1" || !parsed.Sessions[0].HasActiveRun || parsed.Sessions[0].ToolCount != 3 {
		t.Errorf("sessions[0] = %+v, unexpected", parsed.Sessions[0])
	}
	if parsed.Sessions[1].Key != "s2" || parsed.Sessions[1].HasActiveRun || parsed.Sessions[1].ToolCount != 0 {
		t.Errorf("sessions[1] = %+v, unexpected", parsed.Sessions[1])
	}
}

func TestSerializeServerEvent_RoundTrip(t *testing.T) {
	event := json.RawMessage(`{"type":"engine_dead","exitCode":1,"signal":null,"stderrTail":["error"]}`)
	serialized := SerializeServerEvent("key1", event)

	// Parse it back
	var parsed ServerEvent
	if err := json.Unmarshal([]byte(strings.TrimSpace(serialized)), &parsed); err != nil {
		t.Fatalf("round-trip parse failed: %v", err)
	}
	if parsed.Key != "key1" {
		t.Errorf("key = %q, want key1", parsed.Key)
	}

	// Re-serialize the event portion and compare
	var original, roundTripped map[string]any
	json.Unmarshal(event, &original)
	json.Unmarshal(parsed.Event, &roundTripped)

	if original["type"] != roundTripped["type"] {
		t.Errorf("event type mismatch: %v vs %v", original["type"], roundTripped["type"])
	}
}

// --- New tests ported from TS ---

func TestParseClientCommand_AllCommandTypes(t *testing.T) {
	// Verify all 16 valid command types are parseable with required fields.
	allCmds := map[string]string{
		"start_session":   `{"cmd":"start_session","key":"k","config":{"profileId":"p","extensionDir":"/e","workingDirectory":"/w"}}`,
		"send_prompt":     `{"cmd":"send_prompt","key":"k","text":"hi"}`,
		"abort":           `{"cmd":"abort","key":"k"}`,
		"abort_agent":     `{"cmd":"abort_agent","key":"k","agentName":"a"}`,
		"steer_agent":     `{"cmd":"steer_agent","key":"k","agentName":"a","message":"m"}`,
		"dialog_response": `{"cmd":"dialog_response","key":"k","dialogId":"d"}`,
		"command":         `{"cmd":"command","key":"k","command":"c"}`,
		"stop_session":    `{"cmd":"stop_session","key":"k"}`,
		"stop_by_prefix":  `{"cmd":"stop_by_prefix","prefix":"p"}`,
		"list_sessions":   `{"cmd":"list_sessions"}`,
		"fork_session":    `{"cmd":"fork_session","key":"k","messageIndex":0}`,
		"set_plan_mode":   `{"cmd":"set_plan_mode","key":"k","enabled":true}`,
		"branch":          `{"cmd":"branch","key":"k","entryId":"e"}`,
		"navigate_tree":   `{"cmd":"navigate_tree","key":"k","targetId":"t"}`,
		"get_tree":        `{"cmd":"get_tree","key":"k"}`,
		"shutdown":        `{"cmd":"shutdown"}`,
	}

	for cmd, line := range allCmds {
		t.Run(cmd, func(t *testing.T) {
			result := ParseClientCommand(line)
			if result == nil {
				t.Fatalf("expected non-nil for %s", cmd)
			}
			if result.Cmd != cmd {
				t.Errorf("got cmd %q, want %q", result.Cmd, cmd)
			}
		})
	}

	if len(allCmds) != 16 {
		t.Errorf("expected 16 command types, have %d", len(allCmds))
	}
}

func TestParseClientCommand_OptionalFieldsAbsent(t *testing.T) {
	// send_prompt without requestId -- optional fields should not be required.
	line := `{"cmd":"send_prompt","key":"k","text":"hello"}`
	result := ParseClientCommand(line)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.RequestID != "" {
		t.Errorf("requestId should be empty, got %q", result.RequestID)
	}
}

func TestParseClientCommand_OptionalFieldsPresent(t *testing.T) {
	line := `{"cmd":"abort_agent","key":"k","agentName":"coder","subtree":true,"requestId":"r99"}`
	result := ParseClientCommand(line)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.Subtree == nil || *result.Subtree != true {
		t.Errorf("subtree should be true")
	}
	if result.RequestID != "r99" {
		t.Errorf("requestId = %q, want r99", result.RequestID)
	}
}

func TestParseClientCommand_LargePayload(t *testing.T) {
	// A send_prompt with a large text body.
	bigText := strings.Repeat("x", 100_000)
	line := `{"cmd":"send_prompt","key":"k","text":"` + bigText + `"}`
	result := ParseClientCommand(line)
	if result == nil {
		t.Fatal("expected non-nil result for large payload")
	}
	if len(result.Text) != 100_000 {
		t.Errorf("text length = %d, want 100000", len(result.Text))
	}
}

func TestParseClientCommand_MalformedJSON(t *testing.T) {
	tests := []struct {
		name string
		line string
	}{
		{"truncated", `{"cmd":"abort","key":"s1`},
		{"trailing comma", `{"cmd":"abort","key":"s1",}`},
		{"double colon", `{"cmd"::"abort"}`},
		{"unquoted key", `{cmd:"abort","key":"s1"}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if result := ParseClientCommand(tt.line); result != nil {
				t.Errorf("expected nil for malformed JSON %q", tt.name)
			}
		})
	}
}

func TestSerializeServerResult_NestedErrorData(t *testing.T) {
	msg := ServerResult{
		RequestID: "r3",
		OK:        false,
		Error:     "validation failed",
		Data: map[string]any{
			"errors": []map[string]any{
				{"field": "key", "message": "required"},
				{"field": "config", "message": "invalid"},
			},
		},
	}
	result := SerializeServerResult(msg)

	var parsed map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(result)), &parsed); err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	if parsed["error"] != "validation failed" {
		t.Errorf("error = %v, want 'validation failed'", parsed["error"])
	}
	data, ok := parsed["data"].(map[string]any)
	if !ok {
		t.Fatal("data should be an object")
	}
	errs, ok := data["errors"].([]any)
	if !ok || len(errs) != 2 {
		t.Fatalf("expected 2 error entries, got %v", data["errors"])
	}
}

func TestSerializeServerResult_NilData(t *testing.T) {
	msg := ServerResult{
		RequestID: "r4",
		OK:        true,
	}
	result := SerializeServerResult(msg)

	var parsed map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(result)), &parsed); err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	// Data should be null/absent when nil.
	if _, exists := parsed["data"]; exists && parsed["data"] != nil {
		t.Errorf("data should be nil/absent, got %v", parsed["data"])
	}
}

func TestSerializeServerSessionList_Empty(t *testing.T) {
	result := SerializeServerSessionList([]SessionInfo{})

	var parsed ServerSessionList
	if err := json.Unmarshal([]byte(strings.TrimSpace(result)), &parsed); err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	if parsed.Cmd != "session_list" {
		t.Errorf("cmd = %q, want session_list", parsed.Cmd)
	}
	if len(parsed.Sessions) != 0 {
		t.Errorf("expected empty sessions list, got %d", len(parsed.Sessions))
	}
}
