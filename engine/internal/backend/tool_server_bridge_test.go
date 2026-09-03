package backend

import (
	"context"
	"net"
	"os"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestMcpBridgeInvocation pins that the delegated-CLI MCP bridge is the self-exec
// Ion binary running `mcp-bridge --socket <path>`, never socat. socat's absence on
// a stock host was the exact failure this replaces: it made claude report the
// ion-extensions MCP server "failed", so ExitPlanMode, ion_agent, and every client
// tool (AskUserQuestion included) came back as "No such tool available".
func TestMcpBridgeInvocation(t *testing.T) {
	cmd, args := mcpBridgeInvocation("/tmp/sock-abc")

	if cmd == "socat" {
		t.Fatal("bridge command resolved to socat; the fix is to never depend on socat")
	}
	if cmd == "" {
		t.Fatal("bridge command is empty")
	}
	// For a running process os.Executable succeeds, so the bridge command is the
	// engine binary itself (guaranteed present — it spawned the delegated CLI).
	if exe, err := os.Executable(); err == nil && cmd != exe {
		t.Errorf("bridge command = %q, want the running executable %q", cmd, exe)
	}

	want := []string{"mcp-bridge", "--socket", "/tmp/sock-abc"}
	if len(args) != len(want) {
		t.Fatalf("args = %v, want %v", args, want)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Errorf("args[%d] = %q, want %q", i, args[i], want[i])
		}
	}
}

// TestToolServer_ConnectionCounter pins the silent-failure backstop signal: a
// successful MCP session increments the connection counter, so Stop can
// distinguish a working bridge from one that never connected (missing bridge
// binary, unreachable socket) and log the difference at ERROR. Without this, a
// broken bridge is invisible engine-side — the exact way the socat failure hid.
func TestToolServer_ConnectionCounter(t *testing.T) {
	ts := NewToolServer("conn-counter")
	ts.RegisterTool("noop", func(_ context.Context, _ map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "ok"}, nil
	}, "noop tool", nil)
	if err := ts.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer ts.Stop()

	if got := ts.connections.Load(); got != 0 {
		t.Fatalf("connections before any dial = %d, want 0", got)
	}

	conn, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close() //nolint:errcheck // test conn cleanup
	initializeSession(t, conn)

	// The increment runs in the accept goroutine right after the MCP session
	// connects; poll briefly to avoid a scheduling race with the handshake reply.
	deadline := time.Now().Add(2 * time.Second)
	for ts.connections.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := ts.connections.Load(); got < 1 {
		t.Errorf("connections after MCP initialize = %d, want >= 1", got)
	}
}
