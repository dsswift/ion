package server

import (
	"bufio"
	"encoding/json"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/utils"
)

func TestDispatchLifecycleTimeoutAnswersOnceAndRetainsSessionLane(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	srv.lifecycle.stallFor = 10 * time.Millisecond
	srv.lifecycle.limitFor = 30 * time.Millisecond

	started := make(chan struct{})
	release := make(chan struct{})
	secondStarted := make(chan struct{}, 1)
	var mu sync.Mutex
	var calls []string
	srv.lifecycle.handler = func(conn net.Conn, cmd *protocol.ClientCommand) {
		mu.Lock()
		calls = append(calls, cmd.RequestID)
		mu.Unlock()
		switch cmd.RequestID {
		case "blocked":
			close(started)
			<-release
			srv.sendResult(conn, cmd, nil, map[string]bool{"late": true})
		case "same-session":
			secondStarted <- struct{}{}
			srv.sendResult(conn, cmd, nil, nil)
		case "independent":
			srv.sendResult(conn, cmd, nil, nil)
		}
	}

	serverConn, clientConn := registerPipeClient(t, srv)
	if !srv.lanes.submit(serverConn, &protocol.ClientCommand{Cmd: "send_prompt", Key: "session-a", RequestID: "blocked"}) {
		t.Fatal("submit blocked command failed")
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("blocked command did not start")
	}
	if !srv.lanes.submit(serverConn, &protocol.ClientCommand{Cmd: "get_tree", Key: "session-a", RequestID: "same-session"}) {
		t.Fatal("submit same-session command failed")
	}
	if !srv.lanes.submit(serverConn, &protocol.ClientCommand{Cmd: "list_models", RequestID: "independent"}) {
		t.Fatal("submit independent command failed")
	}

	results := readLifecycleResults(t, clientConn, 2, time.Second)
	byID := make(map[string]protocol.ServerResult, len(results))
	for _, result := range results {
		byID[result.RequestID] = result
	}
	if result, ok := byID["independent"]; !ok || !result.OK {
		t.Fatalf("independent result = %+v, want ok result", result)
	}
	if result, ok := byID["blocked"]; !ok || result.OK || !strings.Contains(result.Error, "command dispatch timed out") {
		t.Fatalf("blocked result = %+v, want timeout error", result)
	}
	select {
	case <-secondStarted:
		t.Fatal("same-session command started before blocked handler returned")
	default:
	}

	close(release)
	select {
	case <-secondStarted:
	case <-time.After(time.Second):
		t.Fatal("same-session command did not run after blocked handler returned")
	}

	lateResults := readLifecycleResults(t, clientConn, 1, time.Second)
	if lateResults[0].RequestID != "same-session" || !lateResults[0].OK {
		t.Fatalf("result after release = %+v, want same-session success", lateResults[0])
	}
	clientConn.SetReadDeadline(time.Now().Add(50 * time.Millisecond)) //nolint:errcheck // test-only read bound
	if line, err := bufio.NewReader(clientConn).ReadString('\n'); err == nil && strings.Contains(line, `"blocked"`) {
		t.Fatalf("late blocked result was not suppressed: %s", line)
	}

	mu.Lock()
	defer mu.Unlock()
	if got, want := strings.Join(calls, ","), "blocked,independent,same-session"; got != want {
		t.Fatalf("handler order = %q, want %q", got, want)
	}
}

func TestDispatchLifecycleLogsStallFields(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	srv.lifecycle.stallFor = 10 * time.Millisecond
	srv.lifecycle.limitFor = time.Second

	logged := make(chan map[string]any, 1)
	utils.SetTestSink(func(_ utils.LogLevel, _ string, msg string, fields map[string]any, _, _ string) {
		if msg == "command dispatch stalled" {
			logged <- fields
		}
	})
	t.Cleanup(func() { utils.SetTestSink(nil) })

	release := make(chan struct{})
	srv.lifecycle.handler = func(_ net.Conn, _ *protocol.ClientCommand) { <-release }
	if !srv.lanes.submit(nil, &protocol.ClientCommand{Cmd: "send_prompt", Key: "session-a", RequestID: "stalled"}) {
		t.Fatal("submit stalled command failed")
	}

	select {
	case fields := <-logged:
		if fields["status"] != "send_prompt" || fields["request_id"] != "stalled" || fields["session_id"] != "session-a" {
			t.Fatalf("stall fields = %#v", fields)
		}
		if duration, ok := fields["duration_ms"].(int64); !ok || duration < 0 {
			t.Fatalf("stall duration = %#v, want non-negative int64", fields["duration_ms"])
		}
	case <-time.After(time.Second):
		t.Fatal("dispatch stall was not logged")
	}
	close(release)
}

func readLifecycleResults(t *testing.T, conn net.Conn, count int, timeout time.Duration) []protocol.ServerResult {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	scanner := bufio.NewScanner(conn)
	results := make([]protocol.ServerResult, 0, count)
	for scanner.Scan() {
		var result protocol.ServerResult
		if err := json.Unmarshal(scanner.Bytes(), &result); err != nil {
			continue
		}
		if result.RequestID == "" {
			continue
		}
		results = append(results, result)
		if len(results) == count {
			return results
		}
	}
	t.Fatalf("received %d results, want %d", len(results), count)
	return nil
}

func TestClientLifecycleLogsConnectAndPeerClose(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	connected := make(chan map[string]any, 1)
	disconnected := make(chan map[string]any, 1)
	utils.SetTestSink(func(_ utils.LogLevel, _ string, msg string, fields map[string]any, _, _ string) {
		switch msg {
		case "client connected":
			connected <- fields
		case "client disconnected":
			disconnected <- fields
		}
	})
	t.Cleanup(func() { utils.SetTestSink(nil) })

	conn := dialServer(t, srv)
	select {
	case fields := <-connected:
		if fields["connection_id"] == "" || fields["active_clients"] != 1 {
			t.Fatalf("connect fields = %#v", fields)
		}
	case <-time.After(time.Second):
		t.Fatal("client connection was not logged")
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("close client connection: %v", err)
	}
	select {
	case fields := <-disconnected:
		if fields["reason"] != "peer_closed" || fields["active_clients"] != 0 || fields["connection_id"] == "" {
			t.Fatalf("disconnect fields = %#v", fields)
		}
	case <-time.After(time.Second):
		t.Fatal("client disconnect was not logged")
	}
}
