package server

import (
	"strings"
	"testing"
	"time"
)

// shutdown answers its requestId before the server closes connections, so
// the caller sees a successful shutdown rather than a dropped connection.
func TestShutdownReplies(t *testing.T) {
	srv := newTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	defer conn.Close()

	sendJSON(t, conn, map[string]interface{}{"cmd": "shutdown", "requestId": "req-shutdown"})
	lines := readLinesUntil(t, conn, 2*time.Second, func(line string) bool {
		return strings.Contains(line, "req-shutdown")
	})
	r := findResult(t, lines)
	if r == nil || r.RequestID != "req-shutdown" || !r.OK {
		t.Fatalf("shutdown result = %+v, lines = %v", r, lines)
	}
	select {
	case <-srv.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("server did not stop after shutdown")
	}
}
