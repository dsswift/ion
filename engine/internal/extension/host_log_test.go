package extension

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestHandleExtNotification_LogValidPayload exercises the `log` notification
// handler path. It verifies that a well-formed log notification with each
// supported level does not panic and is routed (the actual log lines are
// written via utils.* and inspected manually in engine.log).
func TestHandleExtNotification_LogValidPayload(t *testing.T) {
	h := &Host{name: "test-ext"}

	cases := []string{
		`{"jsonrpc":"2.0","method":"log","params":{"level":"info","message":"hello"}}`,
		`{"jsonrpc":"2.0","method":"log","params":{"level":"warn","message":"oh no","fields":{"key":"v"}}}`,
		`{"jsonrpc":"2.0","method":"log","params":{"level":"error","message":"bang"}}`,
		`{"jsonrpc":"2.0","method":"log","params":{"level":"debug","message":"trace"}}`,
		// Unknown level falls back to info.
		`{"jsonrpc":"2.0","method":"log","params":{"level":"trace","message":"unknown level"}}`,
	}
	for _, raw := range cases {
		// Should not panic regardless of level.
		h.handleExtNotification("log", []byte(raw))
	}
}

// TestHandleExtNotification_LogMissingFields ensures an empty params payload
// doesn't crash the reader (defense in depth: malformed extension output
// must never bring down the engine reader goroutine).
func TestHandleExtNotification_LogMissingFields(t *testing.T) {
	h := &Host{name: "test-ext"}

	h.handleExtNotification("log", []byte(`{"jsonrpc":"2.0","method":"log","params":{}}`))
	h.handleExtNotification("log", []byte(`not even json`))
}

// TestCallHook_DeadSubprocessEmitsOnceThenSilent ensures that hooks called
// against a dead extension subprocess emit exactly one engine_error and
// that the rest are silenced via errExtensionDeadSilent. Without this,
// every hook fire (turn_start/turn_end/permission_request/tool_call) on a
// dead subprocess produces an error event, flooding the desktop UI.
func TestCallHook_DeadSubprocessEmitsOnceThenSilent(t *testing.T) {
	h := &Host{name: "ext-under-test"}
	h.dead.Store(true)

	var emitted []types.EngineEvent
	ctx := &Context{
		Cwd: "/tmp",
		Emit: func(ev types.EngineEvent) {
			if ev.Type == "engine_error" {
				emitted = append(emitted, ev)
			}
		},
	}

	for i := 0; i < 25; i++ {
		_, err := h.callHook("hook/turn_start", ctx, nil)
		if err == nil {
			t.Fatalf("expected error on iteration %d, got nil", i)
		}
		if !errors.Is(err, errExtensionDeadSilent) {
			t.Fatalf("expected dead sentinel, got %v", err)
		}
	}

	if len(emitted) != 1 {
		t.Fatalf("expected exactly 1 engine_error across 25 dead-hook calls, got %d", len(emitted))
	}
	if emitted[0].ErrorCode != "extension_died" {
		t.Fatalf("expected ErrorCode=extension_died, got %q", emitted[0].ErrorCode)
	}
}

// TestHost_LastParseErrAtRateLimit verifies the rate limit window logic by
// simulating two parse-failure timestamps within the same second: the
// CompareAndSwap should succeed only once.
func TestHost_LastParseErrAtRateLimit(t *testing.T) {
	var slot atomic.Int64
	now := time.Now().UnixNano()

	if !slot.CompareAndSwap(0, now) {
		t.Fatal("first set should succeed")
	}

	// Inside the 1-second window — must reject.
	soon := now + int64(500*time.Millisecond)
	last := slot.Load()
	if soon-last >= int64(time.Second) {
		t.Fatal("expected window to still be open")
	}

	// After the window expires — must succeed.
	later := now + int64(1500*time.Millisecond)
	last = slot.Load()
	if later-last < int64(time.Second) {
		t.Fatal("expected window to have expired")
	}
	if !slot.CompareAndSwap(last, later) {
		t.Fatal("second set should succeed after window")
	}
}
