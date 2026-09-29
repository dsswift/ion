package protocol

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// principal_test.go — wire serialization pins for manifest C1/C2:
// ClientCommand.Principal round-trips, is present when set and omitted
// when nil, and start_session/send_prompt reject a principal with an
// empty subject while accepting one entirely omitted.

// TestClientCommand_PrincipalOmittedWhenNil proves a ClientCommand with no
// Principal serializes without a "principal" key at all (omitempty).
func TestClientCommand_PrincipalOmittedWhenNil(t *testing.T) {
	cmd := ClientCommand{Cmd: "send_prompt", Key: "s1", Text: "hi"}
	data, err := json.Marshal(cmd)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(data), `"principal"`) {
		t.Errorf("serialized command contains principal when nil: %s", data)
	}
}

// TestClientCommand_PrincipalPresentWhenSet proves a ClientCommand with a
// Principal set serializes it with the exact field names the manifest
// specifies, and round-trips through ParseClientCommand unchanged.
func TestClientCommand_PrincipalPresentWhenSet(t *testing.T) {
	cmd := ClientCommand{
		Cmd: "start_session",
		Key: "s1",
		Config: &types.EngineConfig{
			WorkingDirectory: "/tmp",
		},
		Principal: &types.SessionPrincipal{
			Subject:  "local:alice",
			Provider: "os",
			Kind:     "local",
		},
	}
	data, err := json.Marshal(cmd)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"principal":{"subject":"local:alice"`) {
		t.Errorf("serialized command missing expected principal shape: %s", data)
	}

	parsed := ParseClientCommand(string(data))
	if parsed == nil {
		t.Fatal("ParseClientCommand returned nil for a valid start_session with principal")
	}
	if parsed.Principal == nil || parsed.Principal.Subject != "local:alice" {
		t.Errorf("round-tripped principal = %+v, want subject local:alice", parsed.Principal)
	}
}

// TestParseClientCommand_RejectsEmptyPrincipalSubject proves start_session
// and send_prompt reject a principal object with an empty subject, while a
// command that omits "principal" entirely still parses (Principal is
// optional).
func TestParseClientCommand_RejectsEmptyPrincipalSubject(t *testing.T) {
	tests := []struct {
		name    string
		line    string
		wantNil bool
	}{
		{
			name:    "start_session with empty principal subject",
			line:    `{"cmd":"start_session","key":"s1","config":{"workingDirectory":"/tmp"},"principal":{"subject":""}}`,
			wantNil: true,
		},
		{
			name:    "start_session with no principal at all",
			line:    `{"cmd":"start_session","key":"s1","config":{"workingDirectory":"/tmp"}}`,
			wantNil: false,
		},
		{
			name:    "send_prompt with empty principal subject",
			line:    `{"cmd":"send_prompt","key":"s1","text":"hi","principal":{"subject":""}}`,
			wantNil: true,
		},
		{
			name:    "send_prompt with valid principal",
			line:    `{"cmd":"send_prompt","key":"s1","text":"hi","principal":{"subject":"local:bob"}}`,
			wantNil: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseClientCommand(tt.line)
			if tt.wantNil && got != nil {
				t.Errorf("ParseClientCommand(%q) = %+v, want nil", tt.line, got)
			}
			if !tt.wantNil && got == nil {
				t.Errorf("ParseClientCommand(%q) = nil, want non-nil", tt.line)
			}
		})
	}
}

// TestClientCommand_ListSessionsFilterFields proves PrincipalSubject and
// IncludeUnowned round-trip on list_sessions.
func TestClientCommand_ListSessionsFilterFields(t *testing.T) {
	line := `{"cmd":"list_sessions","principalSubject":"local:alice","includeUnowned":true}`
	parsed := ParseClientCommand(line)
	if parsed == nil {
		t.Fatal("ParseClientCommand returned nil for a valid list_sessions")
	}
	if parsed.PrincipalSubject != "local:alice" {
		t.Errorf("PrincipalSubject = %q, want local:alice", parsed.PrincipalSubject)
	}
	if !parsed.IncludeUnowned {
		t.Error("IncludeUnowned = false, want true")
	}
}

// TestSessionInfo_PrincipalSubjectOmittedWhenEmpty proves the list_sessions
// wire response omits principalSubject for an unowned session and includes
// it for an owned one.
func TestSessionInfo_PrincipalSubjectOmittedWhenEmpty(t *testing.T) {
	unowned := SessionInfo{Key: "s1"}
	data, err := json.Marshal(unowned)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(data), "principalSubject") {
		t.Errorf("unowned SessionInfo serialized with principalSubject: %s", data)
	}

	owned := SessionInfo{Key: "s2", PrincipalSubject: "local:alice"}
	data, err = json.Marshal(owned)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"principalSubject":"local:alice"`) {
		t.Errorf("owned SessionInfo missing principalSubject: %s", data)
	}
}
