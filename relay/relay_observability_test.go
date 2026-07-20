package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestReadLoopEnd_LogsReason pins that a client disconnect logs the read-loop
// exit reason (relay.disconnect) instead of silently breaking, so a clean close
// is distinguishable from a timeout or protocol error.
func TestReadLoopEnd_LogsReason(t *testing.T) {
	apiKey := "test-key-readloop"
	testLogger, buf := captureLogger()
	origLogger := logger
	logger = testLogger
	t.Cleanup(func() { logger = origLogger })

	server, _ := startTestRelay(t, apiKey)
	conn := dialWS(t, server, "readloop-chan", "ion", apiKey)
	time.Sleep(100 * time.Millisecond)
	conn.Close(websocket.StatusNormalClosure, "bye")
	time.Sleep(150 * time.Millisecond)

	if !hasLogTag(buf, "relay.disconnect") {
		t.Fatalf("expected relay.disconnect log after client close, got:\n%s", buf.Bytes())
	}
}

// TestPushUnavailable_LogsWhenNoPusher pins that an ion peer requesting a push
// while the relay has no APNs pusher wired logs the unavailability instead of
// silently no-op'ing (the "why no notification" case).
func TestPushUnavailable_LogsWhenNoPusher(t *testing.T) {
	apiKey := "test-key-nopush"
	testLogger, buf := captureLogger()
	origLogger := logger
	logger = testLogger
	t.Cleanup(func() { logger = origLogger })

	// startTestRelay wires HandleWebSocket with a nil pusher, so this is the
	// pusher == nil path.
	server, _ := startTestRelay(t, apiKey)
	conn := dialWS(t, server, "nopush-chan", "ion", apiKey)
	time.Sleep(100 * time.Millisecond)

	// Mobile peer is absent; send a push-eligible frame.
	frame, _ := json.Marshal(map[string]any{"push": true, "notifyKind": "briefing", "notifyResourceId": "r1"})
	writeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := conn.Write(writeCtx, websocket.MessageText, frame); err != nil {
		t.Fatalf("write push frame: %v", err)
	}
	time.Sleep(150 * time.Millisecond)

	if !hasLogTag(buf, "relay.apns.unavailable") {
		t.Fatalf("expected relay.apns.unavailable log, got:\n%s", buf.Bytes())
	}
}

// TestPushEligibleUnmarshalFail_LogsError pins that a push-eligible frame the
// ion peer sends while mobile is absent AND a live pusher is wired — but whose
// bytes are not valid JSON — logs relay.apns.error instead of being silently
// skipped. The unmarshal log fires synchronously in the read-loop goroutine
// before any APNs network call, so the pusher can point at a dead address; no
// real APNs endpoint is required.
func TestPushEligibleUnmarshalFail_LogsError(t *testing.T) {
	apiKey := "test-key-unmarshal"
	testLogger, buf := captureLogger()
	origLogger := logger
	logger = testLogger
	t.Cleanup(func() { logger = origLogger })

	// Build a test server that wires HandleWebSocket with a non-nil pusher so
	// the ion read-loop takes the `pusher != nil` branch. The pusher points at
	// a dead port — the unmarshal failure fires before any push attempt, so no
	// APNs network is needed.
	hub := NewHub()
	pusher := newTestPusher(t, "http://localhost:9", 1)
	auth := NewAuthMiddleware(apiKey)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/channel/{channelId}", func(w http.ResponseWriter, r *http.Request) {
		if !auth.Validate(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		channelID := r.PathValue("channelId")
		role := r.URL.Query().Get("role")
		hub.HandleWebSocket(w, r, channelID, role, pusher)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(func() {
		hub.CloseAll()
		server.Close()
	})

	// Connect ion peer only; leave mobile absent so data falls into the
	// pusher != nil branch.
	conn := dialWS(t, server, "unmarshal-chan", "ion", apiKey)
	time.Sleep(100 * time.Millisecond)

	// Send a non-JSON text frame. The relay cannot unmarshal it; it must log
	// relay.apns.error instead of silently discarding the frame.
	writeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := conn.Write(writeCtx, websocket.MessageText, []byte("not-json")); err != nil {
		t.Fatalf("write non-JSON frame: %v", err)
	}
	time.Sleep(150 * time.Millisecond)

	if !hasLogTag(buf, "relay.apns.error") {
		t.Fatalf("expected relay.apns.error log for unmarshal failure, got:\n%s", buf.Bytes())
	}
}

func hasLogTag(buf *syncBuffer, tag string) bool {
	for _, line := range bytes.Split(bytes.TrimSpace(buf.Bytes()), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(line, &m); err != nil {
			continue
		}
		if s, _ := m["tag"].(string); strings.EqualFold(s, tag) {
			return true
		}
	}
	return false
}
