package extension

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Ensure types import is used
var _ = types.ToolResult{}

func TestExternalHookManager_NewEmpty(t *testing.T) {
	mgr := NewExternalHookManager(nil)
	events := mgr.RegisteredEvents()
	if len(events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(events))
	}
}

func TestExternalHookManager_RegisteredEvents(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"session_start": []interface{}{
			[]interface{}{"echo", "start"},
		},
		"session_end": []interface{}{
			[]interface{}{"echo", "end"},
		},
	})

	events := mgr.RegisteredEvents()
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}

	has := make(map[string]bool)
	for _, e := range events {
		has[e] = true
	}
	if !has["session_start"] || !has["session_end"] {
		t.Fatalf("expected session_start and session_end, got %v", events)
	}
}

func TestExternalHookManager_UpdateConfig(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"session_start": []interface{}{
			[]interface{}{"echo", "old"},
		},
	})

	events := mgr.RegisteredEvents()
	if len(events) != 1 || events[0] != "session_start" {
		t.Fatalf("expected [session_start], got %v", events)
	}

	mgr.UpdateConfig(map[string]interface{}{
		"on_error": []interface{}{
			[]interface{}{"echo", "error"},
		},
	})

	events = mgr.RegisteredEvents()
	if len(events) != 1 || events[0] != "on_error" {
		t.Fatalf("expected [on_error], got %v", events)
	}
}

func TestExternalHookManager_FireUnknownEvent(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"session_start": []interface{}{
			[]interface{}{"echo", "hi"},
		},
	})

	err := mgr.Fire("nonexistent_event", nil)
	if err != nil {
		t.Fatalf("expected no error for unknown event, got %v", err)
	}
}

func TestExternalHookManager_FireAwaited(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"test_event": []interface{}{
			map[string]interface{}{
				"command": []interface{}{"true"},
				"await":   true,
				"timeout": float64(5000),
			},
		},
	})

	err := mgr.Fire("test_event", map[string]interface{}{"key": "value"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestExternalHookManager_PayloadTruncation(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"big_event": []interface{}{
			map[string]interface{}{
				"command": []interface{}{"true"},
				"await":   true,
				"timeout": float64(5000),
			},
		},
	})

	// Build a payload larger than 1MB
	bigPayload := map[string]interface{}{
		"data": strings.Repeat("x", 2*1024*1024),
	}
	err := mgr.Fire("big_event", bigPayload)
	if err != nil {
		t.Fatalf("expected no error for large payload, got %v", err)
	}
}

func TestExternalHookManager_ParseObjectFormat(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"tool_call": []interface{}{
			map[string]interface{}{
				"command": []interface{}{"python3", "audit.py"},
				"await":   true,
				"timeout": float64(5000),
			},
		},
	})

	events := mgr.RegisteredEvents()
	if len(events) != 1 || events[0] != "tool_call" {
		t.Fatalf("expected [tool_call], got %v", events)
	}
}

func TestExternalHookManager_ParseArrayFormat(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"session_start": []interface{}{
			[]interface{}{"bash", "-c", "echo hello"},
		},
	})

	events := mgr.RegisteredEvents()
	if len(events) != 1 || events[0] != "session_start" {
		t.Fatalf("expected [session_start], got %v", events)
	}
}

func TestExternalHookManager_IgnoresInvalidEntries(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"bad_event": "not an array",
	})

	events := mgr.RegisteredEvents()
	if len(events) != 0 {
		t.Fatalf("expected 0 events for invalid config, got %d", len(events))
	}
}

func TestExternalHookManager_EmptyConfig(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{})

	events := mgr.RegisteredEvents()
	if len(events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(events))
	}
}

func TestExternalHookManager_FireAndForget(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"test_event": []interface{}{
			[]interface{}{"true"},
		},
	})

	// Fire-and-forget should not block and should not error
	err := mgr.Fire("test_event", map[string]interface{}{"key": "value"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestExternalHookManager_MultipleHooksPerEvent(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"on_error": []interface{}{
			map[string]interface{}{
				"command": []interface{}{"true"},
				"await":   true,
				"timeout": float64(5000),
			},
			map[string]interface{}{
				"command": []interface{}{"true"},
				"await":   true,
				"timeout": float64(5000),
			},
		},
	})

	err := mgr.Fire("on_error", map[string]interface{}{"msg": "test"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- Context Inject Tests ---
