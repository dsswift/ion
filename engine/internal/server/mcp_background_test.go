package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// TestStopCancelsAndWaitsForMcpWork pins the ownership rule: Stop cancels MCP
// background work and does not return until it has finished, and a stopped
// server admits no more.
func TestStopCancelsAndWaitsForMcpWork(t *testing.T) {
	srv := newShortPathTestServer(t, newMockBackend())

	started := make(chan struct{})
	var finished atomic.Bool
	if !srv.startMcpWork("test", "srv", func(ctx context.Context) {
		close(started)
		<-ctx.Done()
		time.Sleep(50 * time.Millisecond)
		finished.Store(true)
	}) {
		t.Fatal("a running server refused MCP work")
	}
	<-started

	if err := srv.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if !finished.Load() {
		t.Fatal("Stop returned while MCP background work was still running")
	}
	if srv.startMcpWork("test", "srv", func(context.Context) { t.Error("work ran on a stopped server") }) {
		t.Fatal("a stopped server admitted MCP work")
	}
}

// TestStopEndsTheProbeAnMcpUpdateStarted is the leak that let one test's
// probe read the next test's token store: an edit that changes a server
// probes it in the background, and that probe must end with the server.
func TestStopEndsTheProbeAnMcpUpdateStarted(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	hit := make(chan struct{}, 1)
	abandoned := make(chan struct{}, 1)
	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Go notices a client disconnect only once the body has been read.
		io.Copy(io.Discard, r.Body) //nolint:errcheck // drained only to arm disconnect detection
		select {
		case hit <- struct{}{}:
		default:
		}
		select {
		case <-r.Context().Done():
			select {
			case abandoned <- struct{}{}:
			default:
			}
		case <-time.After(20 * time.Second):
		}
	}))
	t.Cleanup(hang.Close)

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_add", "requestId": "req-add",
		"mcpName": "slow", "mcpTransport": "http", "mcpUrl": hang.URL + "/a",
	})
	readLines(t, conn, 2, 3*time.Second)
	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_update", "requestId": "req-update",
		"mcpName": "slow", "mcpUrl": hang.URL + "/b",
	})

	select {
	case <-hit:
	case <-time.After(5 * time.Second):
		t.Fatal("the update never probed the edited server")
	}

	if err := srv.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	select {
	case <-abandoned:
	case <-time.After(3 * time.Second):
		t.Fatal("the probe kept its request open after Stop returned")
	}
}
