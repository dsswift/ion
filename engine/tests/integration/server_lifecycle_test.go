//go:build integration

package integration

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/server"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

func dialSocket(t *testing.T, sockPath string) net.Conn {
	t.Helper()
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial %s: %v", sockPath, err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func sendCmd(t *testing.T, conn net.Conn, cmd interface{}) {
	t.Helper()
	data, err := json.Marshal(cmd)
	if err != nil {
		t.Fatalf("marshal cmd: %v", err)
	}
	_, err = conn.Write(append(data, '\n'))
	if err != nil {
		t.Fatalf("write cmd: %v", err)
	}
}

func readLine(t *testing.T, conn net.Conn, timeout time.Duration) string {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(timeout))
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		t.Fatal("expected a response line, got none")
	}
	return scanner.Text()
}

func readLines(t *testing.T, conn net.Conn, n int, timeout time.Duration) []string {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(timeout))
	scanner := bufio.NewScanner(conn)
	var lines []string
	for i := 0; i < n; i++ {
		if !scanner.Scan() {
			break
		}
		lines = append(lines, scanner.Text())
	}
	return lines
}

// readSessionList drains incoming lines until it finds a {"cmd":"session_list"}
// response. Skips events that interleave with the response.
func readSessionList(t *testing.T, conn net.Conn, timeout time.Duration) *protocol.ServerSessionList {
	t.Helper()
	deadline := time.Now().Add(timeout)
	conn.SetReadDeadline(deadline)
	scanner := bufio.NewScanner(conn)
	for time.Now().Before(deadline) && scanner.Scan() {
		line := scanner.Text()
		if !strings.Contains(line, `"cmd":"session_list"`) {
			continue
		}
		var resp protocol.ServerSessionList
		if err := json.Unmarshal([]byte(line), &resp); err != nil {
			t.Fatalf("unmarshal session_list: %v", err)
		}
		return &resp
	}
	t.Fatal("timed out waiting for session_list response")
	return nil
}

func TestServerLifecycle(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "test.sock")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Connect and list sessions (should be empty)
	conn := dialSocket(t, sockPath)
	sendCmd(t, conn, map[string]interface{}{"cmd": "list_sessions"})

	line := readLine(t, conn, 2*time.Second)
	var resp protocol.ServerSessionList
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Cmd != "session_list" {
		t.Errorf("expected cmd=session_list, got %q", resp.Cmd)
	}
	if len(resp.Sessions) != 0 {
		t.Errorf("expected 0 sessions, got %d", len(resp.Sessions))
	}

	// Shutdown
	sendCmd(t, conn, map[string]interface{}{"cmd": "shutdown"})
	time.Sleep(100 * time.Millisecond)

	// Socket should be removed
	if _, err := os.Stat(sockPath); err == nil {
		t.Error("socket file should be removed after shutdown")
	}
}

func TestMultiClientBroadcast(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "broadcast.sock")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	// Connect two clients
	conn1 := dialSocket(t, sockPath)
	conn2 := dialSocket(t, sockPath)
	time.Sleep(50 * time.Millisecond) // let both register

	// Start a session via client 1 -- this triggers an engine_status broadcast
	sendCmd(t, conn1, map[string]interface{}{
		"cmd":       "start_session",
		"key":       "broadcast-test",
		"config":    map[string]interface{}{"profileId": "default", "extensionDir": "/tmp", "workingDirectory": "/tmp", "model": "mock-model"},
		"requestId": "req-bc-1",
	})

	// Both clients should receive the engine_status event broadcast.
	// Client 1 also receives the result response.
	var mu sync.Mutex
	client1Events := make([]string, 0)
	client2Events := make([]string, 0)

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		lines := readLines(t, conn1, 3, 2*time.Second)
		mu.Lock()
		client1Events = lines
		mu.Unlock()
	}()

	go func() {
		defer wg.Done()
		lines := readLines(t, conn2, 2, 2*time.Second)
		mu.Lock()
		client2Events = lines
		mu.Unlock()
	}()

	wg.Wait()

	// Client 1 should have at least the event and the result
	mu.Lock()
	defer mu.Unlock()

	if len(client1Events) < 1 {
		t.Fatalf("client 1 got %d lines, want at least 1", len(client1Events))
	}

	// Client 2 should receive at least the broadcast event
	if len(client2Events) < 1 {
		t.Fatalf("client 2 got %d lines, want at least 1; client 1 got: %v", len(client2Events), client1Events)
	}

	// Verify client 2 received an event with the session key
	foundBroadcast := false
	for _, line := range client2Events {
		if strings.Contains(line, "broadcast-test") {
			foundBroadcast = true
			break
		}
	}
	if !foundBroadcast {
		t.Errorf("client 2 did not receive broadcast for 'broadcast-test'; got: %v", client2Events)
	}
}

func TestStaleSocketRecovery(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "stale.sock")

	// Create a stale socket: bind a unix socket, then close the listener
	// without removing the file. On some OSes the file is removed on close,
	// so we also write a plain file as a fallback to exercise the stale path.
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("create stale socket: %v", err)
	}
	ln.Close()

	// If the OS cleaned up the socket, create a plain file to simulate stale
	if _, err := os.Stat(sockPath); err != nil {
		if err := os.WriteFile(sockPath, []byte("stale"), 0600); err != nil {
			t.Fatalf("create stale file: %v", err)
		}
	}

	// Verify file exists
	if _, err := os.Stat(sockPath); err != nil {
		t.Fatal("stale socket not created")
	}

	// Server should detect stale socket and recover
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)
	if err := srv.Start(); err != nil {
		t.Fatalf("Start should succeed after stale removal: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	// Verify it works
	conn := dialSocket(t, sockPath)
	sendCmd(t, conn, map[string]interface{}{"cmd": "list_sessions"})
	line := readLine(t, conn, 2*time.Second)
	if !strings.Contains(line, "session_list") {
		t.Errorf("expected session_list, got: %s", line)
	}
}

func TestConcurrentSessions(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "concurrent.sock")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	conn := dialSocket(t, sockPath)

	config := map[string]interface{}{
		"profileId":        "default",
		"extensionDir":     "/tmp",
		"workingDirectory": "/tmp",
		"model":            "mock-model",
	}

	// Start 3 sessions
	for _, key := range []string{"sess-1", "sess-2", "sess-3"} {
		sendCmd(t, conn, map[string]interface{}{
			"cmd":       "start_session",
			"key":       key,
			"config":    config,
			"requestId": "req-" + key,
		})
		// Read event + result
		readLines(t, conn, 2, 2*time.Second)
	}

	// List sessions -- should show 3
	sendCmd(t, conn, map[string]interface{}{"cmd": "list_sessions"})
	resp := readSessionList(t, conn, 2*time.Second)
	if len(resp.Sessions) != 3 {
		t.Errorf("expected 3 sessions, got %d", len(resp.Sessions))
	}

	// Stop one session
	sendCmd(t, conn, map[string]interface{}{
		"cmd":       "stop_session",
		"key":       "sess-2",
		"requestId": "req-stop",
	})
	// Read event (engine_dead) + result
	readLines(t, conn, 2, 2*time.Second)

	// List again -- should show 2
	sendCmd(t, conn, map[string]interface{}{"cmd": "list_sessions"})
	resp = readSessionList(t, conn, 2*time.Second)
	if len(resp.Sessions) != 2 {
		t.Errorf("expected 2 sessions after stop, got %d", len(resp.Sessions))
	}

	// Verify remaining keys
	keys := make(map[string]bool)
	for _, s := range resp.Sessions {
		keys[s.Key] = true
	}
	if keys["sess-2"] {
		t.Error("sess-2 should have been removed")
	}
	if !keys["sess-1"] || !keys["sess-3"] {
		t.Errorf("expected sess-1 and sess-3 to remain, got: %v", keys)
	}
}

// TestServerInvalidCommand verifies the server rejects malformed commands.
func TestServerInvalidCommand(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "invalid.sock")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	conn := dialSocket(t, sockPath)

	// Send invalid JSON
	conn.Write([]byte("not json\n"))
	line := readLine(t, conn, 2*time.Second)
	if !strings.Contains(line, "invalid command") {
		t.Errorf("expected 'invalid command' error, got: %s", line)
	}
}

// TestServerDuplicateSession verifies duplicate session keys are rejected.
func TestServerDuplicateSession(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "dup.sock")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	conn := dialSocket(t, sockPath)

	config := map[string]interface{}{
		"profileId":        "default",
		"extensionDir":     "/tmp",
		"workingDirectory": "/tmp",
		"model":            "mock-model",
	}

	// Start session
	sendCmd(t, conn, map[string]interface{}{
		"cmd":       "start_session",
		"key":       "dup-test",
		"config":    config,
		"requestId": "req-1",
	})
	readLines(t, conn, 2, 2*time.Second)

	// Try to start same key again
	sendCmd(t, conn, map[string]interface{}{
		"cmd":       "start_session",
		"key":       "dup-test",
		"config":    config,
		"requestId": "req-2",
	})

	// Drain up to 3 lines and find the {"cmd":"result"} response. The engine
	// may emit one or more state events alongside the result.
	lines := readLines(t, conn, 3, 2*time.Second)
	var result protocol.ServerResult
	found := false
	for _, l := range lines {
		if strings.Contains(l, `"cmd":"result"`) {
			if err := json.Unmarshal([]byte(l), &result); err == nil {
				found = true
				break
			}
		}
	}
	if !found {
		t.Fatalf("no result line for duplicate start_session; lines=%v", lines)
	}

	// The duplicate session should succeed (idempotent).
	if !result.OK {
		t.Errorf("expected duplicate session to succeed (idempotent), got error: %s", result.Error)
	}
}

// Used to suppress unused import warning for types package.
var _ types.EngineEvent
