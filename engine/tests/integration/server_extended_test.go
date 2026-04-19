//go:build integration

package integration

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/server"
	"github.com/dsswift/ion/engine/tests/helpers"
)

// shortSockPath returns a Unix socket path short enough for macOS (104 char limit).
func shortSockPath(t *testing.T, name string) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ion")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, fmt.Sprintf("%s.sock", name))
}

// ─── Socket Server Lifecycle (extended) ───

func TestServerStartAndConnect(t *testing.T) {
	sockPath := shortSockPath(t, "start")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	// Should be able to connect.
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	conn.Close()
}

func TestServerShutdownCleansUp(t *testing.T) {
	sockPath := shortSockPath(t, "shut")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Connect a client, then shutdown.
	conn := dialSocket(t, sockPath)
	sendCmd(t, conn, map[string]interface{}{"cmd": "shutdown"})

	time.Sleep(200 * time.Millisecond)

	// New connection should fail.
	_, err := net.DialTimeout("unix", sockPath, 500*time.Millisecond)
	if err == nil {
		t.Error("expected connection to fail after shutdown")
	}
}

func TestServerSessionStartAndPrompt(t *testing.T) {
	sockPath := shortSockPath(t, "sess")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	conn := dialSocket(t, sockPath)

	// Start session.
	sendCmd(t, conn, map[string]interface{}{
		"cmd":       "start_session",
		"key":       "prompt-via-socket",
		"config":    map[string]interface{}{"profileId": "default", "extensionDir": "/tmp", "workingDirectory": "/tmp", "model": "mock-model"},
		"requestId": "req-s1",
	})
	readLines(t, conn, 2, 2*time.Second)

	// Send prompt via socket.
	sendCmd(t, conn, map[string]interface{}{
		"cmd":       "send_prompt",
		"key":       "prompt-via-socket",
		"text":      "Hello from socket",
		"requestId": "req-p1",
	})
	readLine(t, conn, 2*time.Second)

	// Backend should have received the prompt.
	time.Sleep(100 * time.Millisecond)
	keys := mb.StartedKeys()
	if len(keys) == 0 {
		t.Error("expected backend to receive a run start")
	}
}

func TestMultiClientBroadcastExtended(t *testing.T) {
	sockPath := shortSockPath(t, "mcex")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	conn1 := dialSocket(t, sockPath)
	conn2 := dialSocket(t, sockPath)
	conn3 := dialSocket(t, sockPath)
	time.Sleep(50 * time.Millisecond)

	// Start session via conn1.
	sendCmd(t, conn1, map[string]interface{}{
		"cmd":       "start_session",
		"key":       "mc-ext-test",
		"config":    map[string]interface{}{"profileId": "default", "extensionDir": "/tmp", "workingDirectory": "/tmp", "model": "mock-model"},
		"requestId": "req-mc-1",
	})

	// All three clients should receive broadcast.
	var mu sync.Mutex
	results := make(map[string][]string)
	var wg sync.WaitGroup

	for _, pair := range []struct {
		name string
		conn net.Conn
		n    int
	}{
		{"c1", conn1, 3},
		{"c2", conn2, 2},
		{"c3", conn3, 2},
	} {
		wg.Add(1)
		go func(name string, c net.Conn, n int) {
			defer wg.Done()
			lines := readLines(t, c, n, 2*time.Second)
			mu.Lock()
			results[name] = lines
			mu.Unlock()
		}(pair.name, pair.conn, pair.n)
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()

	// conn2 and conn3 should each have at least 1 broadcast.
	if len(results["c2"]) < 1 {
		t.Errorf("conn2 got %d lines, want at least 1", len(results["c2"]))
	}
	if len(results["c3"]) < 1 {
		t.Errorf("conn3 got %d lines, want at least 1", len(results["c3"]))
	}
}

func TestOneClientDisconnectDoesNotAffectOthers(t *testing.T) {
	sockPath := shortSockPath(t, "disc")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	conn1 := dialSocket(t, sockPath)
	conn2, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	// Disconnect conn1.
	conn1.Close()
	time.Sleep(100 * time.Millisecond)

	// conn2 should still work.
	sendCmd(t, conn2, map[string]interface{}{"cmd": "list_sessions"})
	conn2.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 4096)
	n, err := conn2.Read(buf)
	if err != nil {
		t.Fatalf("conn2 read after conn1 disconnect: %v", err)
	}
	if !strings.Contains(string(buf[:n]), "session_list") {
		t.Errorf("expected session_list, got: %s", string(buf[:n]))
	}
	conn2.Close()
}

func TestServerInvalidCommandsDoNotCrash(t *testing.T) {
	sockPath := shortSockPath(t, "cproof")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	conn := dialSocket(t, sockPath)

	// Send garbage.
	conn.Write([]byte("not json at all\n"))
	conn.Write([]byte(`{"cmd":"invalid_command"}` + "\n"))
	conn.Write([]byte(`{"no_cmd_field":true}` + "\n"))

	// Drain error responses from the garbage.
	readLines(t, conn, 3, 2*time.Second)

	// Server should still respond to valid commands.
	sendCmd(t, conn, map[string]interface{}{"cmd": "list_sessions"})
	line := readLine(t, conn, 2*time.Second)
	if !strings.Contains(line, "session_list") {
		t.Errorf("expected session_list after garbage, got: %s", line)
	}
}

// ─── Protocol Contract (extended) ───

func TestProtocolAllCommandsRoundTrip(t *testing.T) {
	tests := []struct {
		name  string
		json  string
		valid bool
	}{
		{"abort_agent", `{"cmd":"abort_agent","key":"k","agentName":"a1"}`, true},
		{"steer_agent", `{"cmd":"steer_agent","key":"k","agentName":"a1","message":"focus on X"}`, true},
		{"dialog_response", `{"cmd":"dialog_response","key":"k","dialogId":"d1","value":"allow"}`, true},
		{"command", `{"cmd":"command","key":"k","command":"/help"}`, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := protocol.ParseClientCommand(tt.json)
			if tt.valid && result == nil {
				t.Error("expected valid parse, got nil")
			}
			if !tt.valid && result != nil {
				t.Error("expected nil for invalid command")
			}
		})
	}
}

func TestProtocolServerResultSerialization(t *testing.T) {
	line := protocol.SerializeServerResult(protocol.ServerResult{
		RequestID: "req-test",
		OK:        true,
		Data:      json.RawMessage(`{"key":"val"}`),
	})

	if !strings.HasSuffix(line, "\n") {
		t.Error("must end with newline")
	}

	trimmed := strings.TrimRight(line, "\n")
	var result protocol.ServerResult
	if err := json.Unmarshal([]byte(trimmed), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.RequestID != "req-test" {
		t.Errorf("RequestID: got %q", result.RequestID)
	}
	if !result.OK {
		t.Error("expected OK=true")
	}
}

func TestProtocolServerResultError(t *testing.T) {
	line := protocol.SerializeServerResult(protocol.ServerResult{
		RequestID: "req-err",
		OK:        false,
		Error:     "something went wrong",
	})

	trimmed := strings.TrimRight(line, "\n")
	var result protocol.ServerResult
	if err := json.Unmarshal([]byte(trimmed), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.OK {
		t.Error("expected OK=false")
	}
	if result.Error != "something went wrong" {
		t.Errorf("Error: got %q", result.Error)
	}
}

func TestProtocolSessionListMultipleSessions(t *testing.T) {
	line := protocol.SerializeServerSessionList([]protocol.SessionInfo{
		{Key: "a", HasActiveRun: true, ToolCount: 15},
		{Key: "b", HasActiveRun: false, ToolCount: 0},
		{Key: "c", HasActiveRun: true, ToolCount: 5},
	})

	trimmed := strings.TrimRight(line, "\n")
	var list protocol.ServerSessionList
	if err := json.Unmarshal([]byte(trimmed), &list); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(list.Sessions) != 3 {
		t.Errorf("expected 3, got %d", len(list.Sessions))
	}
}

func TestNDJSONSingleLineEnforcement(t *testing.T) {
	// Verify that even content with newlines serializes to a single NDJSON line.
	event := json.RawMessage(`{"type":"engine_text_delta","text":"line1\nline2\nline3"}`)
	line := protocol.SerializeServerEvent("k", event)

	trimmed := strings.TrimRight(line, "\n")
	if strings.Contains(trimmed, "\n") {
		t.Error("NDJSON line must not contain embedded newlines")
	}
}
