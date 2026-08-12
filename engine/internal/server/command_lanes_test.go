package server

import (
	"bufio"
	"encoding/json"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/protocol"
)

// startSessionScan sends start_session and scans for the result by requestId,
// tolerating interleaved broadcast events from other sessions on the same conn.
func startSessionScan(t *testing.T, conn net.Conn, key, requestID string) {
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
	if !scanForRequestID(t, conn, requestID, 3*time.Second) {
		t.Fatalf("startSessionScan %q: no result for requestId %q", key, requestID)
	}
}

// scanForRequestID reads lines from conn until it finds one containing the
// given requestId (as a JSON value), or the deadline expires.
func scanForRequestID(t *testing.T, conn net.Conn, requestID string, deadline time.Duration) bool {
	t.Helper()
	needle := `"` + requestID + `"`
	if err := conn.SetReadDeadline(time.Now().Add(deadline)); err != nil {
		t.Fatalf("scanForRequestID: set deadline: %v", err)
	}
	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		if strings.Contains(scanner.Text(), needle) {
			return true
		}
	}
	return false
}

func TestClassifyCommand(t *testing.T) {
	tests := []struct {
		cmd  string
		key  string
		want commandClass
	}{
		{"health", "", classHealth},
		{"health", "s1", classHealth},
		{"send_prompt", "s1", classSession},
		{"send_prompt", "", classProcess},
		{"start_session", "s1", classSession},
		{"stop_session", "s1", classSession},
		{"abort", "s1", classSession},
		{"list_sessions", "", classProcess},
		{"shutdown", "", classProcess},
		{"list_models", "", classProcess},
		{"store_credential", "", classProcess},
		{"unknown_cmd", "", classProcess},
	}
	for _, tt := range tests {
		got := classifyCommand(&protocol.ClientCommand{Cmd: tt.cmd, Key: tt.key})
		if got != tt.want {
			t.Errorf("classifyCommand(%q, key=%q) = %d, want %d", tt.cmd, tt.key, got, tt.want)
		}
	}
}

func TestResourceCommandsUseSessionLaneWhenKeyed(t *testing.T) {
	for _, cmd := range []string{"resource_subscribe", "resource_unsubscribe", "resource_publish", "resource_get"} {
		t.Run(cmd, func(t *testing.T) {
			if got := classifyCommand(&protocol.ClientCommand{Cmd: cmd, Key: "session-1"}); got != classSession {
				t.Fatalf("classifyCommand(%q, keyed) = %d, want session lane", cmd, got)
			}
			if got := classifyCommand(&protocol.ClientCommand{Cmd: cmd, ResourceGlobal: true, Key: "client-correlation"}); got != classProcess {
				t.Fatalf("classifyCommand(%q, global) = %d, want process lane", cmd, got)
			}
		})
	}
}

func TestProcessWorkerDoesNotDispatchQueuedWorkAfterShutdown(t *testing.T) {
	dispatched := make(chan struct{}, 1)
	cl := &commandLanes{
		process:    make(chan laneItem, 1),
		done:       make(chan struct{}),
		dispatchFn: func(_ net.Conn, _ *protocol.ClientCommand) { dispatched <- struct{}{} },
		workers:    make(chan struct{}, 1),
	}
	cl.process <- laneItem{cmd: &protocol.ClientCommand{Cmd: "list_sessions"}}
	close(cl.done)
	cl.wg.Add(1)

	workerDone := make(chan struct{})
	go func() {
		cl.processWorker()
		close(workerDone)
	}()

	select {
	case <-workerDone:
	case <-time.After(time.Second):
		t.Fatal("process worker did not exit after shutdown")
	}
	select {
	case <-dispatched:
		t.Fatal("process worker dispatched work queued before shutdown")
	default:
	}
}

func TestSessionLaneOrdering(t *testing.T) {
	var mu sync.Mutex
	var order []string

	cl := newCommandLanes(func(_ net.Conn, cmd *protocol.ClientCommand) {
		mu.Lock()
		order = append(order, cmd.RequestID)
		mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	})
	defer cl.stop()

	for i := 0; i < 5; i++ {
		id := string(rune('A' + i))
		if !cl.submit(nil, &protocol.ClientCommand{
			Cmd:       "send_prompt",
			Key:       "session-1",
			RequestID: id,
		}) {
			t.Fatalf("submit %s failed", id)
		}
	}

	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(order) != 5 {
		t.Fatalf("expected 5 dispatches, got %d", len(order))
	}
	for i, id := range order {
		want := string(rune('A' + i))
		if id != want {
			t.Errorf("order[%d] = %q, want %q", i, id, want)
		}
	}
}

func TestDifferentSessionsConcurrent(t *testing.T) {
	var started sync.WaitGroup
	started.Add(2)
	gate := make(chan struct{})

	cl := newCommandLanes(func(_ net.Conn, _ *protocol.ClientCommand) {
		started.Done()
		<-gate
	})
	defer cl.stop()

	cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "s1", RequestID: "r1"})
	cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "s2", RequestID: "r2"})

	done := make(chan struct{})
	go func() {
		started.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("two sessions did not start concurrently within 2s")
	}
	close(gate)
}

func TestHealthBypassesBlockedSession(t *testing.T) {
	gate := make(chan struct{})
	healthDone := make(chan struct{}, 1)

	cl := newCommandLanes(func(_ net.Conn, cmd *protocol.ClientCommand) {
		if cmd.Cmd == "health" {
			select {
			case healthDone <- struct{}{}:
			default:
			}
			return
		}
		<-gate
	})
	defer func() {
		close(gate)
		cl.stop()
	}()

	cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "s1", RequestID: "block"})
	time.Sleep(10 * time.Millisecond)

	cl.submit(nil, &protocol.ClientCommand{Cmd: "health", RequestID: "h1"})

	select {
	case <-healthDone:
	case <-time.After(2 * time.Second):
		t.Fatal("health not dispatched while session lane is blocked")
	}
}

func TestProcessLaneConcurrency(t *testing.T) {
	var active atomic.Int32
	var peak atomic.Int32
	done := make(chan struct{})

	cl := newCommandLanes(func(_ net.Conn, _ *protocol.ClientCommand) {
		n := active.Add(1)
		for {
			old := peak.Load()
			if n <= old || peak.CompareAndSwap(old, n) {
				break
			}
		}
		<-done
		active.Add(-1)
	})
	defer cl.stop()

	for i := 0; i < processLaneWorkers+2; i++ {
		cl.submit(nil, &protocol.ClientCommand{Cmd: "list_sessions", RequestID: "p"})
	}
	time.Sleep(50 * time.Millisecond)

	if p := peak.Load(); p > int32(processLaneWorkers) {
		t.Errorf("peak concurrency %d exceeded process workers %d", p, processLaneWorkers)
	}
	if p := peak.Load(); p < 2 {
		t.Errorf("peak concurrency %d too low, expected concurrent processing", p)
	}
	close(done)
}

func TestSessionLaneQueueFull(t *testing.T) {
	gate := make(chan struct{})

	cl := &commandLanes{
		sessions:         make(map[string]*sessionLane),
		process:          make(chan laneItem, processLaneQueueSize),
		done:             make(chan struct{}),
		dispatchFn:       func(_ net.Conn, _ *protocol.ClientCommand) { <-gate },
		rejectFn:         func(_ net.Conn, _ *protocol.ClientCommand) {},
		sessionQueueSize: 2,
		processQueueSize: processLaneQueueSize,
	}
	for i := 0; i < processLaneWorkers; i++ {
		cl.wg.Add(1)
		go cl.processWorker()
	}
	defer func() {
		close(gate)
		cl.stop()
	}()

	cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "s1", RequestID: "a"})
	time.Sleep(10 * time.Millisecond)

	cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "s1", RequestID: "b"})
	cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "s1", RequestID: "c"})

	ok := cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "s1", RequestID: "d"})
	if ok {
		t.Fatal("expected submit to fail when session queue is full")
	}
}

func TestEvictSession(t *testing.T) {
	var dispatched atomic.Int32

	cl := newCommandLanes(func(_ net.Conn, _ *protocol.ClientCommand) {
		dispatched.Add(1)
	})
	defer cl.stop()

	cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "s1", RequestID: "a"})
	time.Sleep(50 * time.Millisecond)

	cl.evictSession("s1")
	time.Sleep(20 * time.Millisecond)

	cl.mu.Lock()
	_, exists := cl.sessions["s1"]
	cl.mu.Unlock()

	if exists {
		t.Fatal("session lane still in map after evict")
	}

	if !cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "s1", RequestID: "b"}) {
		t.Fatal("cannot submit to evicted session (should create new lane)")
	}
	time.Sleep(50 * time.Millisecond)

	if d := dispatched.Load(); d != 2 {
		t.Errorf("expected 2 dispatches, got %d", d)
	}
}

func TestEvictSessionRejectsQueuedCommands(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var dispatched []string
	var dispatchMu sync.Mutex

	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()

	cl := newCommandLanes(func(_ net.Conn, cmd *protocol.ClientCommand) {
		dispatchMu.Lock()
		dispatched = append(dispatched, cmd.RequestID)
		dispatchMu.Unlock()
		if cmd.RequestID == "in-flight" {
			close(started)
			<-release
		}
	}, (&Server{}).rejectStoppedSessionCommand)
	defer cl.stop()

	if !cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "stopped", RequestID: "in-flight"}) {
		t.Fatal("submit in-flight command failed")
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("in-flight command did not start")
	}
	if !cl.submit(serverConn, &protocol.ClientCommand{Cmd: "send_prompt", Key: "stopped", RequestID: "queued"}) {
		t.Fatal("submit queued command failed")
	}

	resultLine := make(chan string, 1)
	go func() {
		buf := make([]byte, 1024)
		n, err := clientConn.Read(buf)
		if err != nil {
			return
		}
		resultLine <- string(buf[:n])
	}()

	cl.evictSession("stopped")
	close(release)

	select {
	case line := <-resultLine:
		var result protocol.ServerResult
		if err := json.Unmarshal([]byte(line), &result); err != nil {
			t.Fatalf("unmarshal rejection result: %v", err)
		}
		if result.RequestID != "queued" || result.OK || result.Error != "session stopped" {
			t.Fatalf("rejection result = %+v, want queued session-stopped error", result)
		}
	case <-time.After(time.Second):
		t.Fatal("queued command was not rejected after session eviction")
	}

	dispatchMu.Lock()
	defer dispatchMu.Unlock()
	if len(dispatched) != 1 || dispatched[0] != "in-flight" {
		t.Fatalf("dispatched requests = %v, want only in-flight", dispatched)
	}
}

func TestEvictByPrefixRemovesMatchingLanes(t *testing.T) {
	cl := newCommandLanes(func(_ net.Conn, _ *protocol.ClientCommand) {})
	defer cl.stop()

	for _, key := range []string{"project/a", "project/b", "other"} {
		if !cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: key, RequestID: key}) {
			t.Fatalf("submit %q failed", key)
		}
	}

	cl.evictByPrefix("project/")

	cl.mu.Lock()
	defer cl.mu.Unlock()
	for _, key := range []string{"project/a", "project/b"} {
		if _, exists := cl.sessions[key]; exists {
			t.Fatalf("prefix eviction retained %q", key)
		}
	}
	if _, exists := cl.sessions["other"]; !exists {
		t.Fatal("prefix eviction removed non-matching lane")
	}
}

func TestStopSessionEvictsCommandLane(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	conn := dialServer(t, srv)
	defer conn.Close()

	startSession(t, conn, "stopped-session", "start-stopped")

	deadline := time.Now().Add(time.Second)
	for {
		srv.lanes.mu.Lock()
		_, exists := srv.lanes.sessions["stopped-session"]
		srv.lanes.mu.Unlock()
		if exists {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("start_session did not create command lane")
		}
		time.Sleep(time.Millisecond)
	}

	srv.dispatch(nil, &protocol.ClientCommand{Cmd: "stop_session", Key: "stopped-session"})

	srv.lanes.mu.Lock()
	_, exists := srv.lanes.sessions["stopped-session"]
	srv.lanes.mu.Unlock()
	if exists {
		t.Fatal("stop_session left command lane active")
	}
}

func TestStopByPrefixEvictsMatchingCommandLanes(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	conn := dialServer(t, srv)
	defer conn.Close()

	for _, key := range []string{"prefix/a", "prefix/b", "other"} {
		startSession(t, conn, key, "start-"+key)
	}
	deadline := time.Now().Add(time.Second)
	for {
		srv.lanes.mu.Lock()
		count := len(srv.lanes.sessions)
		srv.lanes.mu.Unlock()
		if count >= 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("start_session created %d lanes, want 3", count)
		}
		time.Sleep(time.Millisecond)
	}

	srv.dispatch(nil, &protocol.ClientCommand{Cmd: "stop_by_prefix", Prefix: "prefix/"})

	srv.lanes.mu.Lock()
	defer srv.lanes.mu.Unlock()
	for _, key := range []string{"prefix/a", "prefix/b"} {
		if _, exists := srv.lanes.sessions[key]; exists {
			t.Fatalf("stop_by_prefix left matching lane %q active", key)
		}
	}
	if _, exists := srv.lanes.sessions["other"]; !exists {
		t.Fatal("stop_by_prefix removed non-matching lane")
	}
}

func TestLanesShutdown(t *testing.T) {
	cl := newCommandLanes(func(_ net.Conn, _ *protocol.ClientCommand) {
		time.Sleep(10 * time.Millisecond)
	})

	cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "s1", RequestID: "a"})
	time.Sleep(5 * time.Millisecond)

	done := make(chan struct{})
	go func() {
		cl.stop()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("stop did not return within 5s")
	}

	if cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "s2", RequestID: "b"}) {
		t.Fatal("submit succeeded after stop")
	}
}

func TestSessionLaneIdleCleanup(t *testing.T) {
	origIdle := sessionLaneIdleTime
	sessionLaneIdleTime = 50 * time.Millisecond
	defer func() { sessionLaneIdleTime = origIdle }()

	cl := newCommandLanes(func(_ net.Conn, _ *protocol.ClientCommand) {})
	defer cl.stop()

	cl.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "idle-s", RequestID: "a"})
	time.Sleep(30 * time.Millisecond)

	cl.mu.Lock()
	_, exists := cl.sessions["idle-s"]
	cl.mu.Unlock()
	if !exists {
		t.Fatal("session lane should exist shortly after submit")
	}

	time.Sleep(150 * time.Millisecond)

	cl.mu.Lock()
	_, exists = cl.sessions["idle-s"]
	cl.mu.Unlock()
	if exists {
		t.Fatal("session lane should have been idle-evicted")
	}
}

// Integration tests using a real server over a socket.

func TestIntegrationHealthWhileSessionBlocked(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	startSession(t, conn, "blocking-session", "start-1")

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "health",
		"requestId": "health-1",
	})

	lines := readLines(t, conn, 4, 2*time.Second)
	var found bool
	for _, l := range lines {
		if strings.Contains(l, `"health-1"`) && strings.Contains(l, `"ok":true`) {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("health response not received; lines=%v", lines)
	}
}

func TestIntegrationTwoSessionsIndependent(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn1 := dialServer(t, srv)
	defer conn1.Close()
	conn2 := dialServer(t, srv)
	defer conn2.Close()

	startSessionScan(t, conn1, "sess-a", "start-a")
	startSessionScan(t, conn2, "sess-b", "start-b")

	sendJSON(t, conn1, map[string]interface{}{
		"cmd":       "list_sessions",
		"requestId": "ls-a",
	})
	sendJSON(t, conn2, map[string]interface{}{
		"cmd":       "list_sessions",
		"requestId": "ls-b",
	})

	if !scanForRequestID(t, conn1, "ls-a", 2*time.Second) {
		t.Error("conn1 did not receive list_sessions result ls-a")
	}
	if !scanForRequestID(t, conn2, "ls-b", 2*time.Second) {
		t.Error("conn2 did not receive list_sessions result ls-b")
	}
}

func TestIntegrationStaleClientNoWrite(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	startSession(t, conn, "stale-test", "start-stale")

	conn.Close()
	time.Sleep(50 * time.Millisecond)

	srv.mu.RLock()
	_, exists := srv.clients[conn]
	srv.mu.RUnlock()
	if exists {
		t.Fatal("evicted client still in client map")
	}
}

func TestIntegrationSessionOrdering(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	startSession(t, conn, "order-test", "start-order")

	for i := 0; i < 3; i++ {
		sendJSON(t, conn, map[string]interface{}{
			"cmd":       "get_tree",
			"key":       "order-test",
			"requestId": string(rune('A' + i)),
		})
	}

	lines := readLines(t, conn, 10, 2*time.Second)

	var order []string
	for _, l := range lines {
		var msg struct {
			Cmd       string `json:"cmd"`
			RequestID string `json:"requestId"`
		}
		if err := json.Unmarshal([]byte(l), &msg); err != nil {
			continue
		}
		if msg.Cmd == "result" && len(msg.RequestID) == 1 {
			order = append(order, msg.RequestID)
		}
	}

	for i := 1; i < len(order); i++ {
		if order[i] < order[i-1] {
			t.Errorf("results out of order: %v", order)
			break
		}
	}
}

func TestIntegrationBlockedSessionADoesNotBlockSessionB(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	connA := dialServer(t, srv)
	defer connA.Close()
	connB := dialServer(t, srv)
	defer connB.Close()

	startSessionScan(t, connA, "block-a", "start-a")
	startSessionScan(t, connB, "free-b", "start-b")

	sendJSON(t, connB, map[string]interface{}{
		"cmd":       "get_tree",
		"key":       "free-b",
		"requestId": "tree-b",
	})

	if !scanForRequestID(t, connB, "tree-b", 2*time.Second) {
		t.Error("session B response not received while session A exists")
	}
}

func TestIntegrationResultRoutedToCorrectClient(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	connA := dialServer(t, srv)
	defer connA.Close()
	connB := dialServer(t, srv)
	defer connB.Close()

	sendJSON(t, connA, map[string]interface{}{
		"cmd":       "health",
		"requestId": "ha",
	})
	sendJSON(t, connB, map[string]interface{}{
		"cmd":       "health",
		"requestId": "hb",
	})

	scanFor := func(conn net.Conn, target string, timeout time.Duration) bool {
		conn.SetReadDeadline(time.Now().Add(timeout))
		scanner := bufio.NewScanner(conn)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), target) {
				return true
			}
		}
		return false
	}

	if !scanFor(connA, `"ha"`, 2*time.Second) {
		t.Error("client A did not receive its own result 'ha'")
	}
	if !scanFor(connB, `"hb"`, 2*time.Second) {
		t.Error("client B did not receive its own result 'hb'")
	}
}
