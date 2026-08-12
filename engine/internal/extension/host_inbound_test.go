package extension

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestInboundNotification_DoesNotDeadlockReadLoop is the regression test for the
// engine-wide stall of 2026-08-11: the engine wedged with every session frozen,
// a 251-goroutine lock-stall dump, and no recovery short of a restart.
//
// The cycle: SendPrompt held the session-manager write lock while awaiting a
// context_inject hook response, and the same host's readLoop was parked inside
// an ext/emit notification handler waiting for a manager read lock. The readLoop
// is the only reader of that host's stdout, so the hook response sat unread in
// the pipe forever — and extension calls wait indefinitely by contract, so
// nothing timed out.
//
// TestSteerRPC_DoesNotDeadlockReadLoop pins the same property for the two steer
// *requests*, which were fixed handler-by-handler. That point fix is exactly why
// this recurred: every other handler, including the notification path, was still
// synchronous. This test pins the general rule — NO inbound handler runs on the
// readLoop, so a blocked handler of any kind cannot stop response delivery.
//
// RED on unfixed code: with dispatch inlined back into readLoop, the blocked
// ext/emit handler freezes the loop, the concurrent call's response is never
// read, and the deadline below trips.
func TestInboundNotification_DoesNotDeadlockReadLoop(t *testing.T) {
	h := NewHost()

	// engineIn: bytes the "subprocess" sends TO the engine (read by readLoop).
	// engineOut: bytes the engine sends TO the "subprocess".
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

	// The emit handler blocks until released. This models Manager.emit waiting
	// on the session-manager lock that SendPrompt is holding.
	emitBlock := make(chan struct{})
	var releaseOnce sync.Once
	releaseEmit := func() { releaseOnce.Do(func() { close(emitBlock) }) }
	// Registered after the pipe-close cleanup so it runs before it (LIFO): a
	// failing run then unwinds instead of hanging to the binary timeout.
	t.Cleanup(releaseEmit)
	emitEntered := make(chan struct{})
	h.SetPersistentEmit(func(types.EngineEvent) {
		close(emitEntered)
		<-emitBlock
	})

	emitFrame, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "ext/emit",
		"params":  map[string]any{"type": "engine_status"},
	})
	if _, err := engineInW.Write(append(emitFrame, '\n')); err != nil {
		t.Fatalf("write emit frame: %v", err)
	}

	select {
	case <-emitEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("emit handler never entered — readLoop did not dispatch the notification")
	}

	// With the emit handler blocked, an engine→extension call must still get its
	// response: the readLoop is free to keep reading.
	callDone := make(chan error, 1)
	go func() {
		_, err := h.callWithTimeout("ext/ping", nil, 3*time.Second)
		callDone <- err
	}()

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
	// On its own goroutine: in the reverted build nobody drains the incoming
	// pipe, so this write would block forever and the main goroutine must stay
	// free to hit the deadline below.
	go func() { _, _ = engineInW.Write(append(respFrame, '\n')) }()

	select {
	case err := <-callDone:
		if err != nil {
			t.Fatalf("concurrent call failed: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("concurrent call did not complete while a notification handler was blocked — readLoop deadlocked")
	}

	releaseEmit()
}

func TestInboundNotification_CapturesActiveContext(t *testing.T) {
	h := NewHost()

	engineInR, engineInW := io.Pipe()
	scanner := bufio.NewScanner(engineInR)
	h.readerWg.Add(1)
	go h.readLoop(scanner)
	t.Cleanup(func() {
		engineInW.Close()
		h.readerWg.Wait()
	})

	blockEntered := make(chan struct{})
	releaseBlock := make(chan struct{})
	h.SetPersistentEmit(func(event types.EngineEvent) {
		if event.Type == "block_dispatch" {
			close(blockEntered)
			<-releaseBlock
		}
	})
	blockFrame, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "method": "ext/emit",
		"params": map[string]any{"type": "block_dispatch"},
	})
	if _, err := engineInW.Write(append(blockFrame, '\n')); err != nil {
		t.Fatalf("write blocking frame: %v", err)
	}
	select {
	case <-blockEntered:
	case <-time.After(3 * time.Second):
		t.Fatal("blocking notification did not enter dispatcher")
	}

	emitted := make(chan types.EngineEvent, 1)
	ctx := &Context{Emit: func(event types.EngineEvent) { emitted <- event }}
	h.ctxStack.Push(ctx)
	responseRead := make(chan *jsonrpcResponse, 1)
	h.pendMu.Lock()
	h.pending[42] = responseRead
	h.pendMu.Unlock()
	frame, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "method": "ext/emit",
		"params": map[string]any{"type": "context_scoped_event"},
	})
	if _, err := engineInW.Write(append(frame, '\n')); err != nil {
		t.Fatalf("write context-scoped frame: %v", err)
	}
	responseFrame, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 42, "result": map[string]any{"ok": true},
	})
	if _, err := engineInW.Write(append(responseFrame, '\n')); err != nil {
		t.Fatalf("write response frame: %v", err)
	}
	select {
	case <-responseRead:
	case <-time.After(3 * time.Second):
		t.Fatal("readLoop did not consume frame following context-scoped notification")
	}

	// The response proves readLoop already captured the preceding notification.
	// The worker remains blocked, so popping now distinguishes captured context
	// from a context lookup deferred until dispatch.
	h.ctxStack.Pop()
	close(releaseBlock)

	select {
	case event := <-emitted:
		if event.Type != "context_scoped_event" {
			t.Fatalf("event type = %q, want context_scoped_event", event.Type)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("notification lost the context active when its frame was read")
	}
}

// TestInboundDispatch_PreservesOrder pins that moving dispatch off the readLoop
// did not make it concurrent. Notification order is observable — ext/emit
// carries engine events that consumers render in sequence — so the queue must
// stay FIFO on one worker.
func TestInboundDispatch_PreservesOrder(t *testing.T) {
	h := NewHost()

	engineInR, engineInW := io.Pipe()
	scanner := bufio.NewScanner(engineInR)
	h.readerWg.Add(1)
	go h.readLoop(scanner)
	t.Cleanup(func() {
		engineInW.Close()
		h.readerWg.Wait()
	})

	const n = 50
	got := make(chan string, n)
	h.SetPersistentEmit(func(e types.EngineEvent) { got <- e.EventMessage })

	for i := 0; i < n; i++ {
		frame, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"method":  "ext/emit",
			"params":  map[string]any{"type": "engine_status", "message": string(rune('a'+i%26)) + string(rune('0'+i/26))},
		})
		if _, err := engineInW.Write(append(frame, '\n')); err != nil {
			t.Fatalf("write emit %d: %v", i, err)
		}
	}

	for i := 0; i < n; i++ {
		want := string(rune('a'+i%26)) + string(rune('0'+i/26))
		select {
		case msg := <-got:
			if msg != want {
				t.Fatalf("emit %d out of order: got %q, want %q", i, msg, want)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("timed out waiting for emit %d", i)
		}
	}
}
