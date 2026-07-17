package extension

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"
)

// TestSteerRPC_DoesNotDeadlockReadLoop is the regression test for the steer-RPC
// readLoop deadlock (SHA fc837a0a). The steer handlers (ext/steer_dispatch,
// ext/steer_self) must run their fallback (which can call SendPrompt and
// acquire a session-manager write lock) OFF the readLoop goroutine. If the
// handler runs synchronously in the readLoop, no further RPC responses for the
// host are processed while the steer fallback blocks — any concurrent
// callWithTimeout caller deadlocks because its response sits unread in the
// pipe.
//
// The test drives a real readLoop over a pipe. A steer RPC arrives whose
// fallback blocks on a channel the test controls. While that steer is
// "in flight", the test issues a concurrent call() and feeds its response
// into the same readLoop. With the async fix the concurrent call completes
// promptly; if the steer handler is reverted to run synchronously in the
// readLoop, the concurrent response is never read and the call times out —
// the test deadline trips and the test fails (rather than hanging forever).
func TestSteerRPC_DoesNotDeadlockReadLoop(t *testing.T) {
	h := NewHost()

	// engineIn: bytes the "subprocess" sends TO the engine (read by readLoop).
	// engineOut: bytes the engine sends TO the "subprocess" (h.stdin writes).
	engineInR, engineInW := io.Pipe()
	engineOutR, engineOutW := io.Pipe()
	h.stdin = engineOutW

	// Drive the production readLoop over the incoming pipe.
	scanner := bufio.NewScanner(engineInR)
	h.readerWg.Add(1)
	go h.readLoop(scanner)
	t.Cleanup(func() {
		engineInW.Close()
		h.readerWg.Wait()
	})

	// Collect frames the engine writes back to the subprocess so the test can
	// observe the steer response and (crucially) the concurrent call's request
	// id is irrelevant — we inject its response directly below.
	engineWrites := make(chan map[string]any, 16)
	go func() {
		sc := bufio.NewScanner(engineOutR)
		for sc.Scan() {
			var m map[string]any
			if err := json.Unmarshal(sc.Bytes(), &m); err == nil {
				engineWrites <- m
			}
		}
	}()

	// The steer fallback blocks until the test releases it. This models
	// SendPrompt holding a lock: while blocked, a synchronous handler would
	// freeze the readLoop.
	steerBlock := make(chan struct{})
	var releaseOnce sync.Once
	releaseSteer := func() { releaseOnce.Do(func() { close(steerBlock) }) }
	// Registered AFTER the pipe-close/Wait cleanup above so it runs BEFORE it
	// (cleanups are LIFO). Releasing the steer fallback lets the readLoop
	// unwind even in the reverted (synchronous, deadlocked) build, so a failing
	// run fails fast instead of hanging to the binary timeout.
	t.Cleanup(releaseSteer)
	steerEntered := make(chan struct{})
	ctx := &Context{
		Cwd: "/tmp",
		SteerSelf: func(message string) (SteerDispatchResult, error) {
			close(steerEntered)
			<-steerBlock
			return SteerDispatchResult{Delivered: true, Outcome: "delivered"}, nil
		},
	}
	h.ctxStack.Push(ctx)

	// Deliver an ext/steer_self request into the readLoop.
	steerFrame, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      int64(9001),
		"method":  "ext/steer_self",
		"params":  map[string]string{"message": "keep going"},
	})
	if _, err := engineInW.Write(append(steerFrame, '\n')); err != nil {
		t.Fatalf("write steer frame: %v", err)
	}

	// Wait until the steer fallback is actually executing (and blocked). With
	// the fix this happens on its own goroutine, leaving the readLoop free.
	select {
	case <-steerEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("steer fallback never entered — readLoop did not dispatch the steer RPC")
	}

	// Now issue a concurrent engine→subprocess call. Its request is written to
	// h.stdin; the test plays the subprocess by reading that request's id and
	// feeding a matching response back into the readLoop. If the readLoop is
	// wedged by a synchronous steer handler, the response is never processed
	// and call() blocks until its timeout.
	callDone := make(chan error, 1)
	go func() {
		_, err := h.callWithTimeout("ext/ping", nil, 3*time.Second)
		callDone <- err
	}()

	// Read the outbound ext/ping request to learn its id, then inject the
	// response into the readLoop.
	var pingID int64 = -1
	deadline := time.After(2 * time.Second)
	for pingID < 0 {
		select {
		case m := <-engineWrites:
			if m["method"] == "ext/ping" {
				if idf, ok := m["id"].(float64); ok {
					pingID = int64(idf)
				}
			}
		case <-deadline:
			t.Fatal("never observed the outbound ext/ping request")
		}
	}

	respFrame, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      pingID,
		"result":  map[string]any{"ok": true},
	})
	// Write the response on its own goroutine. In the reverted (synchronous)
	// build the readLoop is wedged inside the steer handler, so nobody drains
	// the incoming pipe and this write would block forever if done on the main
	// goroutine — the main goroutine must stay free to hit the callDone
	// deadline and fail fast.
	go func() { _, _ = engineInW.Write(append(respFrame, '\n')) }()

	// With the async fix, the readLoop processes the ping response while the
	// steer fallback is still blocked, so call() returns promptly. Without the
	// fix the readLoop is stuck inside the synchronous steer handler and this
	// select trips the deadline.
	select {
	case err := <-callDone:
		if err != nil {
			t.Fatalf("concurrent call failed: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("concurrent call did not complete while steer was in flight — readLoop deadlocked")
	}

	// Release the steer fallback and confirm its response is eventually sent.
	releaseSteer()
}

// TestSteerSelf_AsyncResponseDelivered pins that the async steer handler still
// delivers its response after the fallback completes (the async refactor must
// not drop the response). Uses the same pipe-driven readLoop harness.
func TestSteerSelf_AsyncResponseDelivered(t *testing.T) {
	h := NewHost()

	engineInR, engineInW := io.Pipe()
	engineOutR, engineOutW := io.Pipe()
	h.stdin = engineOutW

	scanner := bufio.NewScanner(engineInR)
	h.readerWg.Add(1)
	go h.readLoop(scanner)
	t.Cleanup(func() {
		engineInW.Close()
		h.readerWg.Wait()
	})

	responses := make(chan map[string]any, 8)
	go func() {
		sc := bufio.NewScanner(engineOutR)
		for sc.Scan() {
			var m map[string]any
			if err := json.Unmarshal(sc.Bytes(), &m); err == nil {
				responses <- m
			}
		}
	}()

	ctx := &Context{
		Cwd: "/tmp",
		SteerSelf: func(message string) (SteerDispatchResult, error) {
			return SteerDispatchResult{Delivered: true, Outcome: "delivered"}, nil
		},
	}
	h.ctxStack.Push(ctx)

	steerFrame, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      int64(42),
		"method":  "ext/steer_self",
		"params":  map[string]string{"message": "hi"},
	})
	if _, err := engineInW.Write(append(steerFrame, '\n')); err != nil {
		t.Fatalf("write steer frame: %v", err)
	}

	deadline := time.After(3 * time.Second)
	for {
		select {
		case m := <-responses:
			idf, _ := m["id"].(float64)
			if int64(idf) != 42 {
				continue
			}
			result, ok := m["result"].(map[string]any)
			if !ok {
				t.Fatalf("steer response missing result object: %v", m)
			}
			if result["delivered"] != true {
				t.Errorf("delivered = %v, want true", result["delivered"])
			}
			if result["outcome"] != "delivered" {
				t.Errorf("outcome = %v, want delivered", result["outcome"])
			}
			return
		case <-deadline:
			t.Fatal("no steer response frame within deadline")
		}
	}
}
