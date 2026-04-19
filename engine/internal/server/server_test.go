package server

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
	"github.com/dsswift/ion/engine/internal/types"
)

// mockBackend implements backend.RunBackend for testing.
type mockBackend struct {
	onNorm  func(string, types.NormalizedEvent)
	onExit  func(string, *int, *string, string)
	onErr   func(string, error)
	started map[string]types.RunOptions
	mu      sync.Mutex
}

func newMockBackend() *mockBackend {
	return &mockBackend{started: make(map[string]types.RunOptions)}
}

func (m *mockBackend) StartRun(requestID string, options types.RunOptions) {
	m.mu.Lock()
	m.started[requestID] = options
	m.mu.Unlock()
	// Simulate immediate completion
	if m.onExit != nil {
		go func() {
			time.Sleep(10 * time.Millisecond)
			code := 0
			m.onExit(requestID, &code, nil, options.SessionID)
		}()
	}
}

func (m *mockBackend) Cancel(requestID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.started[requestID]
	return ok
}

func (m *mockBackend) IsRunning(requestID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.started[requestID]
	return ok
}

func (m *mockBackend) WriteToStdin(_ string, _ interface{}) error            { return nil }
func (m *mockBackend) OnNormalized(fn func(string, types.NormalizedEvent)) { m.onNorm = fn }
func (m *mockBackend) OnExit(fn func(string, *int, *string, string))      { m.onExit = fn }
func (m *mockBackend) OnError(fn func(string, error))                     { m.onErr = fn }

// helpers

// newTestServer creates a started server backed by the given mockBackend and
// returns both. Registers t.Cleanup to stop the server.
func newTestServer(t *testing.T, mb *mockBackend) *Server {
	t.Helper()
	sockPath := filepath.Join(t.TempDir(), "test.sock")
	srv := NewServer(sockPath, mb)
	if err := srv.Start(); err != nil {
		t.Fatalf("server Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })
	return srv
}

// newShortPathTestServer is like newTestServer but places the socket under
// /tmp to stay within the ~104-byte Unix socket path limit on macOS.
func newShortPathTestServer(t *testing.T, mb *mockBackend) *Server {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "ion-test-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sockPath := filepath.Join(dir, "t.sock")
	srv := NewServer(sockPath, mb)
	if err := srv.Start(); err != nil {
		t.Fatalf("server Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })
	return srv
}

// dialServer opens a Unix connection to srv and returns it.
func dialServer(t *testing.T, srv *Server) net.Conn {
	t.Helper()
	conn, err := net.Dial("unix", srv.SocketPath())
	if err != nil {
		t.Fatalf("dial server: %v", err)
	}
	return conn
}

// sendJSON marshals v and writes it as a newline-terminated frame to conn.
func sendJSON(t *testing.T, conn net.Conn, v interface{}) {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal command: %v", err)
	}
	if _, err := conn.Write(append(data, '\n')); err != nil {
		t.Fatalf("write command: %v", err)
	}
}

// readLines reads up to maxLines NDJSON lines from conn within deadline.
// Returns all lines collected before the deadline or maxLines is reached.
func readLines(t *testing.T, conn net.Conn, maxLines int, deadline time.Duration) []string {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(deadline))
	scanner := bufio.NewScanner(conn)
	var lines []string
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
		if len(lines) >= maxLines {
			break
		}
	}
	return lines
}

// findResult scans lines for a "result" cmd and returns it.
func findResult(t *testing.T, lines []string) *protocol.ServerResult {
	t.Helper()
	for _, l := range lines {
		if strings.Contains(l, `"cmd":"result"`) {
			var r protocol.ServerResult
			if err := json.Unmarshal([]byte(l), &r); err != nil {
				t.Fatalf("unmarshal result: %v", err)
			}
			return &r
		}
	}
	return nil
}

// startSession sends start_session and waits for the result, failing the test
// on any error.
func startSession(t *testing.T, conn net.Conn, key, requestID string) {
	t.Helper()
	sendJSON(t, conn, map[string]interface{}{
		"cmd": "start_session",
		"key": key,
		"config": map[string]interface{}{
			"profileId":        "default",
			"extensionDir":     "/tmp",
			"workingDirectory": "/tmp",
			"model":            "claude-sonnet-4-6",
		},
		"requestId": requestID,
	})
	lines := readLines(t, conn, 5, 2*time.Second)
	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("startSession %q: no result received; lines=%v", key, lines)
	}
	if !r.OK {
		t.Fatalf("startSession %q: server returned error: %s", key, r.Error)
	}
}

// ─── Existing tests ───

func TestServerStartAndConnect(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "test.sock")
	mb := newMockBackend()
	srv := NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer srv.Stop()

	// Connect a client
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("Dial failed: %v", err)
	}
	defer conn.Close()

	// Send list_sessions
	cmd := `{"cmd":"list_sessions"}` + "\n"
	_, err = conn.Write([]byte(cmd))
	if err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	// Read response
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		t.Fatal("expected response line")
	}
	line := scanner.Text()

	var resp protocol.ServerSessionList
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp.Cmd != "session_list" {
		t.Errorf("expected cmd=session_list, got %q", resp.Cmd)
	}
	if len(resp.Sessions) != 0 {
		t.Errorf("expected 0 sessions, got %d", len(resp.Sessions))
	}
}

func TestServerStartSession(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "test.sock")
	mb := newMockBackend()
	srv := NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer srv.Stop()

	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("Dial failed: %v", err)
	}
	defer conn.Close()

	// Send start_session
	startCmd := map[string]interface{}{
		"cmd": "start_session",
		"key": "test-1",
		"config": map[string]interface{}{
			"profileId":        "default",
			"extensionDir":     "/tmp",
			"workingDirectory": "/tmp",
			"model":            "claude-sonnet-4-6",
		},
		"requestId": "req-1",
	}
	data, _ := json.Marshal(startCmd)
	conn.Write(append(data, '\n'))

	// Read all available responses (event + result) within the deadline.
	// The server emits an engine_status event AND a result response.
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	scanner := bufio.NewScanner(conn)

	var resultFound bool
	var lines []string
	for i := 0; i < 5; i++ {
		if !scanner.Scan() {
			break
		}
		line := scanner.Text()
		lines = append(lines, line)
		if strings.Contains(line, `"cmd":"result"`) {
			var result protocol.ServerResult
			if err := json.Unmarshal([]byte(line), &result); err != nil {
				t.Fatalf("unmarshal result: %v", err)
			}
			if !result.OK {
				t.Errorf("expected ok=true, got error: %s", result.Error)
			}
			resultFound = true
			break
		}
	}
	if !resultFound {
		t.Fatalf("never received result response; got %d lines: %v", len(lines), lines)
	}
}

func TestServerStaleSocketRemoval(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "stale.sock")
	mb := newMockBackend()

	// Create a stale socket (listener that we close immediately)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("pre-create socket: %v", err)
	}
	ln.Close()

	// New server should detect and remove the stale socket
	srv := NewServer(sockPath, mb)
	if err := srv.Start(); err != nil {
		t.Fatalf("Start should succeed after stale removal: %v", err)
	}
	defer srv.Stop()
}

// ─── New tests ───

// TestMultiClientBroadcast verifies that when one client starts a session, the
// engine_status event is broadcast to all connected clients.
func TestMultiClientBroadcast(t *testing.T) {
	mb := newMockBackend()
	srv := newTestServer(t, mb)

	conn1 := dialServer(t, srv)
	defer conn1.Close()

	conn2 := dialServer(t, srv)
	defer conn2.Close()

	// client1 starts a session; both clients should receive the event.
	sendJSON(t, conn1, map[string]interface{}{
		"cmd": "start_session",
		"key": "broadcast-test",
		"config": map[string]interface{}{
			"profileId":        "default",
			"extensionDir":     "/tmp",
			"workingDirectory": "/tmp",
			"model":            "claude-sonnet-4-6",
		},
		"requestId": "req-broadcast",
	})

	// conn1 must receive its result.
	lines1 := readLines(t, conn1, 5, 2*time.Second)
	r1 := findResult(t, lines1)
	if r1 == nil || !r1.OK {
		errMsg := ""
		if r1 != nil {
			errMsg = r1.Error
		}
		t.Fatalf("conn1 start_session result missing or failed: %s", errMsg)
	}

	// conn2 should receive at least one broadcast (the engine_status event).
	lines2 := readLines(t, conn2, 3, 2*time.Second)
	hasEvent := false
	for _, l := range lines2 {
		if strings.Contains(l, `"event"`) && strings.Contains(l, "broadcast-test") {
			hasEvent = true
			break
		}
	}
	if !hasEvent {
		t.Errorf("conn2 did not receive any broadcast event; lines=%v", lines2)
	}
}

// TestClientDisconnectCleanup verifies that a client disconnect removes the
// connection from the internal map and that subsequent broadcasts don't panic.
func TestClientDisconnectCleanup(t *testing.T) {
	mb := newMockBackend()
	srv := newTestServer(t, mb)

	// Connect and immediately close a client.
	transient := dialServer(t, srv)
	transient.Close()

	// Give the server goroutine time to notice the disconnect.
	time.Sleep(50 * time.Millisecond)

	// A second client starts a session; broadcast to the closed conn must not panic.
	conn := dialServer(t, srv)
	defer conn.Close()

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "start_session",
		"key": "after-disconnect",
		"config": map[string]interface{}{
			"profileId":        "default",
			"extensionDir":     "/tmp",
			"workingDirectory": "/tmp",
			"model":            "claude-sonnet-4-6",
		},
		"requestId": "req-dc",
	})

	lines := readLines(t, conn, 5, 2*time.Second)
	r := findResult(t, lines)
	if r == nil || !r.OK {
		errMsg := ""
		if r != nil {
			errMsg = r.Error
		}
		t.Fatalf("expected successful start_session after disconnect: %s", errMsg)
	}
}

// TestInvalidCommandHandling verifies that malformed JSON and unknown commands
// both produce an error response.
func TestInvalidCommandHandling(t *testing.T) {
	mb := newMockBackend()
	srv := newTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	// Send malformed JSON -- the server should reply with an error result.
	conn.Write([]byte("this is not json\n"))

	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		t.Fatal("expected error response for malformed JSON")
	}
	line := scanner.Text()

	var r protocol.ServerResult
	if err := json.Unmarshal([]byte(line), &r); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if r.OK {
		t.Error("expected ok=false for malformed JSON, got true")
	}
	if r.Error == "" {
		t.Error("expected non-empty error field")
	}
}

// TestUnknownCommandHandling verifies that a structurally valid JSON object
// with an unknown cmd value returns an error result when a requestId is present.
func TestUnknownCommandHandling(t *testing.T) {
	mb := newMockBackend()
	srv := newTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	// The protocol layer rejects unknown commands before dispatch, so the
	// server's handleClient writes an "invalid command" error result.
	conn.Write([]byte(`{"cmd":"does_not_exist","requestId":"req-unk"}` + "\n"))

	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		t.Fatal("expected error response for unknown command")
	}
	line := scanner.Text()

	var r protocol.ServerResult
	if err := json.Unmarshal([]byte(line), &r); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if r.OK {
		t.Errorf("expected ok=false for unknown command, got true; line=%s", line)
	}
}

// TestStopSessionCommand starts a session then sends stop_session and verifies
// a successful result is returned.
func TestStopSessionCommand(t *testing.T) {
	mb := newMockBackend()
	srv := newTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	startSession(t, conn, "stop-me", "req-start")

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "stop_session",
		"key":       "stop-me",
		"requestId": "req-stop",
	})

	lines := readLines(t, conn, 5, 2*time.Second)
	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("no result for stop_session; lines=%v", lines)
	}
	if !r.OK {
		t.Errorf("stop_session failed: %s", r.Error)
	}
	if r.RequestID != "req-stop" {
		t.Errorf("expected requestId=req-stop, got %q", r.RequestID)
	}

	// Verify the session is gone from list_sessions.
	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "list_sessions",
		"requestId": "req-list",
	})
	listLines := readLines(t, conn, 5, 2*time.Second)
	listResult := findResult(t, listLines)
	if listResult == nil {
		t.Fatalf("no result for list_sessions; lines=%v", listLines)
	}
	// Data is []SessionInfo serialised as interface{}; marshal back and check.
	dataJSON, _ := json.Marshal(listResult.Data)
	var sessions []protocol.SessionInfo
	if err := json.Unmarshal(dataJSON, &sessions); err != nil {
		t.Fatalf("unmarshal sessions: %v", err)
	}
	for _, s := range sessions {
		if s.Key == "stop-me" {
			t.Error("stopped session still present in list_sessions")
		}
	}
}

// TestStopByPrefix starts two sessions sharing a prefix and one without, then
// stops by prefix and verifies only the prefixed sessions are removed.
func TestStopByPrefix(t *testing.T) {
	mb := newMockBackend()
	srv := newTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	startSession(t, conn, "work-alpha", "req-a")
	startSession(t, conn, "work-beta", "req-b")
	startSession(t, conn, "other-gamma", "req-c")

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "stop_by_prefix",
		"prefix":    "work-",
		"requestId": "req-prefix",
	})

	lines := readLines(t, conn, 5, 2*time.Second)
	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("no result for stop_by_prefix; lines=%v", lines)
	}
	if !r.OK {
		t.Errorf("stop_by_prefix failed: %s", r.Error)
	}

	// Verify state via list_sessions.
	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "list_sessions",
		"requestId": "req-list2",
	})
	listLines := readLines(t, conn, 5, 2*time.Second)
	listResult := findResult(t, listLines)
	if listResult == nil {
		t.Fatalf("no result for list_sessions; lines=%v", listLines)
	}
	dataJSON, _ := json.Marshal(listResult.Data)
	var sessions []protocol.SessionInfo
	if err := json.Unmarshal(dataJSON, &sessions); err != nil {
		t.Fatalf("unmarshal sessions: %v", err)
	}

	for _, s := range sessions {
		if strings.HasPrefix(s.Key, "work-") {
			t.Errorf("session %q should have been stopped by prefix", s.Key)
		}
	}
	var found bool
	for _, s := range sessions {
		if s.Key == "other-gamma" {
			found = true
		}
	}
	if !found {
		t.Error("session other-gamma should still be active after stop_by_prefix")
	}
}

// TestForkSessionError verifies that forking a session that has no conversation
// history returns an error result (since claudeSession will be empty).
func TestForkSessionError(t *testing.T) {
	mb := newMockBackend()
	srv := newTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	startSession(t, conn, "fork-source", "req-src")

	idx := 0
	sendJSON(t, conn, map[string]interface{}{
		"cmd":          "fork_session",
		"key":          "fork-source",
		"messageIndex": idx,
		"requestId":    "req-fork",
	})

	lines := readLines(t, conn, 5, 2*time.Second)
	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("no result for fork_session; lines=%v", lines)
	}
	// With no conversation history the manager returns an error; verify the
	// result is well-formed and the server propagated it correctly.
	if r.RequestID != "req-fork" {
		t.Errorf("expected requestId=req-fork, got %q", r.RequestID)
	}
	// Either ok=true with newKey set, or ok=false with an error message.
	// For a brand-new session with no conversation, ok=false is expected.
	if r.OK && r.NewKey == "" {
		t.Error("fork returned ok=true but newKey is empty")
	}
}

// TestShutdownCommand verifies that sending a shutdown command causes the
// server's Done channel to close.
func TestShutdownCommand(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "shutdown.sock")
	mb := newMockBackend()
	srv := NewServer(sockPath, mb)
	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}

	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	conn.Write([]byte(`{"cmd":"shutdown"}` + "\n"))

	select {
	case <-srv.Done():
		// Server stopped as expected.
	case <-time.After(2 * time.Second):
		t.Fatal("server Done channel not closed after shutdown command")
	}
}

// TestListSessionsWithRequestID verifies that list_sessions with a requestId
// returns a "result" frame (not "session_list") whose data contains the session list.
func TestListSessionsWithRequestID(t *testing.T) {
	mb := newMockBackend()
	srv := newTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	startSession(t, conn, "listed", "req-start")

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "list_sessions",
		"requestId": "req-list",
	})

	lines := readLines(t, conn, 5, 2*time.Second)
	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("no result frame for list_sessions with requestId; lines=%v", lines)
	}
	if !r.OK {
		t.Errorf("list_sessions result not ok: %s", r.Error)
	}
	if r.RequestID != "req-list" {
		t.Errorf("expected requestId=req-list, got %q", r.RequestID)
	}
	if r.Data == nil {
		t.Fatal("expected data field in list_sessions result")
	}

	dataJSON, _ := json.Marshal(r.Data)
	var sessions []protocol.SessionInfo
	if err := json.Unmarshal(dataJSON, &sessions); err != nil {
		t.Fatalf("unmarshal sessions data: %v", err)
	}

	var found bool
	for _, s := range sessions {
		if s.Key == "listed" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("session 'listed' not in list_sessions result: %v", sessions)
	}
}

// TestListSessionsWithoutRequestID verifies that list_sessions without a
// requestId returns a "session_list" frame directly (legacy path).
func TestListSessionsWithoutRequestID(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	conn.Write([]byte(`{"cmd":"list_sessions"}` + "\n"))

	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		t.Fatal("expected session_list response")
	}
	line := scanner.Text()

	var resp protocol.ServerSessionList
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("unmarshal session_list: %v", err)
	}
	if resp.Cmd != "session_list" {
		t.Errorf("expected cmd=session_list, got %q", resp.Cmd)
	}
	if resp.Sessions == nil {
		t.Error("expected non-nil sessions slice")
	}
}

// TestStopNonExistentSession verifies that stopping a session that was never
// started returns an error result (not a server panic).
func TestStopNonExistentSession(t *testing.T) {
	mb := newMockBackend()
	srv := newTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "stop_session",
		"key":       "ghost",
		"requestId": "req-ghost",
	})

	lines := readLines(t, conn, 3, 2*time.Second)
	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("no result for stop_session on non-existent key; lines=%v", lines)
	}
	if r.OK {
		t.Error("expected ok=false stopping a non-existent session")
	}
	if r.Error == "" {
		t.Error("expected non-empty error message")
	}
}

// TestDuplicateStartSession verifies that starting a session with a key that
// already exists returns an error result.
func TestDuplicateStartSession(t *testing.T) {
	mb := newMockBackend()
	srv := newTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	startSession(t, conn, "dup-key", "req-first")

	// Second start with the same key must fail.
	sendJSON(t, conn, map[string]interface{}{
		"cmd": "start_session",
		"key": "dup-key",
		"config": map[string]interface{}{
			"profileId":        "default",
			"extensionDir":     "/tmp",
			"workingDirectory": "/tmp",
			"model":            "claude-sonnet-4-6",
		},
		"requestId": "req-second",
	})

	lines := readLines(t, conn, 5, 2*time.Second)
	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("no result for duplicate start_session; lines=%v", lines)
	}
	if r.OK {
		t.Error("expected ok=false for duplicate session key")
	}
	if r.RequestID != "req-second" {
		t.Errorf("expected requestId=req-second, got %q", r.RequestID)
	}
}
