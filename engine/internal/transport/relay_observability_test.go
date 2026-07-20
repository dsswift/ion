package transport

import (
	"errors"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

// relayLogMu serializes tests that install the process-global logger test sink.
var relayLogMu sync.Mutex

// captureRelayLogs installs a sink recording every "transport.relay" log line
// and lowers the level to Debug. Returns a snapshot accessor.
func captureRelayLogs(t *testing.T) func() []string {
	t.Helper()
	relayLogMu.Lock()

	var mu sync.Mutex
	var msgs []string

	prev := utils.GetLevel()
	utils.SetLevel(utils.LevelDebug)
	utils.SetTestSink(func(_ utils.LogLevel, tag, msg string, _ map[string]any, _, _ string) {
		if tag != "transport.relay" {
			return
		}
		mu.Lock()
		msgs = append(msgs, msg)
		mu.Unlock()
	})
	t.Cleanup(func() {
		utils.SetTestSink(nil)
		utils.SetLevel(prev)
		relayLogMu.Unlock()
	})
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		out := make([]string, len(msgs))
		copy(out, msgs)
		return out
	}
}

// TestRelayBroadcast_NoConnection_LogsDrop pins that a broadcast attempted
// while the relay is not connected logs the drop instead of vanishing. This is
// the reported-class silent push failure: relay down, every notification
// broadcast discarded with no trace.
func TestRelayBroadcast_NoConnection_LogsDrop(t *testing.T) {
	snapshot := captureRelayLogs(t)
	r := NewRelayTransport("wss://example.invalid", "key", "chan")
	// conn is nil (never connected).
	r.Broadcast([]byte(`{"hello":"world"}`))

	var sawDrop bool
	for _, m := range snapshot() {
		if m == "broadcast dropped: no relay connection" {
			sawDrop = true
		}
	}
	if !sawDrop {
		t.Fatalf("expected broadcast-drop log, got: %v", snapshot())
	}
}

// TestRelayConnSend_NoConnection_ReturnsSentinel pins that relayConn.Send
// reports the not-connected case to the caller (so a dropped broadcast is not
// mistaken for a delivery) rather than hardcoding a nil return.
func TestRelayConnSend_NoConnection_ReturnsSentinel(t *testing.T) {
	_ = captureRelayLogs(t) // silence + serialize
	r := NewRelayTransport("wss://example.invalid", "key", "chan")
	c := &relayConn{transport: r}
	if err := c.Send([]byte(`{"x":1}`)); !errors.Is(err, ErrRelayNotConnected) {
		t.Fatalf("expected ErrRelayNotConnected, got %v", err)
	}
}
