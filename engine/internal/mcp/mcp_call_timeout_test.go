package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// hangingCallServer answers the MCP handshake and tool discovery, then holds
// every tools/call open until the test releases it. It is the smallest server
// that makes a per-call timeout observable without a subprocess.
func hangingCallServer(t *testing.T) *httptest.Server {
	t.Helper()
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     *int64 `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if req.ID == nil {
			w.WriteHeader(http.StatusAccepted)
			return
		}

		var result map[string]any
		switch req.Method {
		case "initialize":
			result = map[string]any{
				"protocolVersion": DiscoveryProtocolVersion,
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "hang", "version": "1.0.0"},
			}
		case "tools/list":
			result = map[string]any{"tools": []map[string]any{
				{"name": "stall", "description": "never answers", "inputSchema": map[string]any{"type": "object"}},
			}}
		case "tools/call":
			select {
			case <-release:
			case <-r.Context().Done():
			}
			return
		default:
			result = map[string]any{}
		}

		payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": *req.ID, "result": result})
		if err != nil {
			t.Errorf("marshal result: %v", err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if _, err := fmt.Fprintf(w, "event: message\ndata: %s\n\n", payload); err != nil {
			t.Errorf("write sse frame: %v", err)
		}
	}))
	// Registered after NewServer so release closes before Close waits on the
	// blocked handler.
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(release) })
	return server
}

func connectHanging(t *testing.T, callTimeout time.Duration) *Connection {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	server := hangingCallServer(t)
	conn, err := Connect("hang", types.McpServerConfig{Type: "http", URL: server.URL})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	t.Cleanup(func() {
		if closeErr := conn.Close(); closeErr != nil {
			t.Errorf("close: %v", closeErr)
		}
	})
	conn.callTimeout = callTimeout
	return conn
}

// The per-call timeout ending a call must be named as a timeout, with its
// duration, so a slow server reads differently from a cancelled run.
func TestCallTool_PerCallTimeoutIsNamed(t *testing.T) {
	conn := connectHanging(t, 150*time.Millisecond)

	_, err := conn.CallTool(context.Background(), "stall", nil)
	if err == nil {
		t.Fatal("expected a timeout error, got nil")
	}
	if !strings.Contains(err.Error(), "timeout after 150ms") {
		t.Errorf("error = %q, want it to contain %q", err, "timeout after 150ms")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("error should still wrap context.DeadlineExceeded, got %v", err)
	}
}

// A caller that cancels its own context is not a timeout and must not be
// reported as one.
func TestCallTool_CallerCancellationIsNotATimeout(t *testing.T) {
	conn := connectHanging(t, time.Minute)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	_, err := conn.CallTool(ctx, "stall", nil)
	if err == nil {
		t.Fatal("expected a cancellation error, got nil")
	}
	if strings.Contains(err.Error(), "timeout") {
		t.Errorf("caller cancellation reported as a timeout: %v", err)
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("error should wrap context.Canceled, got %v", err)
	}
}
