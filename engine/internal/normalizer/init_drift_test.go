package normalizer

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// The CLI's system/init line is the first carrier of the run's session
// identity. These tests pin that a change in the shape of a field the engine
// does not consume cannot drop the event.

func sessionInitFrom(t *testing.T, raw json.RawMessage) *types.SessionInitEvent {
	t.Helper()
	events := Normalize(raw)
	if len(events) != 1 {
		t.Fatalf("Normalize returned %d events, want 1 SessionInitEvent", len(events))
	}
	init, ok := events[0].Data.(*types.SessionInitEvent)
	if !ok {
		t.Fatalf("event is %T, want *types.SessionInitEvent", events[0].Data)
	}
	return init
}

// TestNormalizeSystemInit_PluginObjects pins the shape the CLI sends today:
// plugins as objects. Decoding them as strings dropped the whole init event,
// and with it the session identity every early consumer waits for.
//
// Revert-red: declare InitEvent.Plugins as []string and remove the type-error
// tolerance in normalizeSystem; Normalize returns no events.
func TestNormalizeSystemInit_PluginObjects(t *testing.T) {
	raw := json.RawMessage(`{
		"type": "system", "subtype": "init",
		"session_id": "00000000-0000-4000-8000-000000000001",
		"tools": ["Bash"], "model": "example-model",
		"mcp_servers": [{"name": "example", "status": "pending", "source": "user"}],
		"agents": ["general-purpose"], "skills": ["example-skill"],
		"plugins": [{"name": "example-plugin", "path": "builtin", "source": "example-plugin@builtin"}],
		"claude_code_version": "0.0.0"
	}`)

	init := sessionInitFrom(t, raw)
	if init.SessionID != "00000000-0000-4000-8000-000000000001" {
		t.Errorf("SessionID = %q", init.SessionID)
	}
	if len(init.Tools) != 1 || init.Model != "example-model" || len(init.Skills) != 1 {
		t.Errorf("init fields lost: %+v", init)
	}
}

// TestInitPlugin_AcceptsStringAndObject pins both plugin encodings.
func TestInitPlugin_AcceptsStringAndObject(t *testing.T) {
	var ev types.InitEvent
	if err := json.Unmarshal([]byte(`{"plugins": ["by-name", {"name": "by-object", "path": "builtin"}]}`), &ev); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(ev.Plugins) != 2 || ev.Plugins[0].Name != "by-name" || ev.Plugins[1].Name != "by-object" || ev.Plugins[1].Path != "builtin" {
		t.Errorf("plugins = %+v", ev.Plugins)
	}
}

// TestNormalizeSystemInit_SurvivesFieldTypeDrift pins the general rule: any
// field that changes type costs only that field, never the session identity.
//
// Revert-red: return nil on every unmarshal error in normalizeSystem.
func TestNormalizeSystemInit_SurvivesFieldTypeDrift(t *testing.T) {
	raw := json.RawMessage(`{
		"type": "system", "subtype": "init",
		"session_id": "00000000-0000-4000-8000-000000000002",
		"model": "example-model",
		"agents": [{"name": "now-an-object"}]
	}`)

	init := sessionInitFrom(t, raw)
	if init.SessionID != "00000000-0000-4000-8000-000000000002" || init.Model != "example-model" {
		t.Errorf("init = %+v, want session identity and model preserved", init)
	}
}

// TestNormalizeSystemInit_MalformedLineDropped pins that a line that is not
// valid JSON still yields nothing.
func TestNormalizeSystemInit_MalformedLineDropped(t *testing.T) {
	if events := Normalize(json.RawMessage(`{"type": "system", "subtype": "init", "session_id": `)); len(events) != 0 {
		t.Errorf("malformed line produced %d events, want 0", len(events))
	}
}
