package ion

import (
	"context"
	"testing"
	"time"
)

// context_dispatch_test.go — asynchronous dispatch notification routing.
//
// Default dispatch returns a stub immediately; everything after that
// arrives as engine notifications the SDK must route back to the callbacks the
// caller supplied. Two properties matter and neither is obvious from the
// protocol:
//
//   - Routing is keyed by dispatch id first, agent name second. Two parallel
//     dispatches of one agent share a name, so a name-only router would give
//     both of them the same terminal callback and lose one outcome entirely.
//   - Streaming callbacks must be bound before the dispatch RPC returns,
//     because a fast child can emit before the engine has answered.

// TestAsyncDispatchRoutesTerminalCallback pins default asynchronous routing: a
// completion notification keyed by dispatch id reaches OnComplete.
func TestBackgroundDispatchRoutesTerminalCallback(t *testing.T) {
	fe := newFakeEngine(t, WithName("dispatch-terminal-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	completed := make(chan DispatchAgentResult, 1)
	ctx := fe.sdk.newContext(nil)

	started := make(chan error, 1)
	go func() {
		_, err := ctx.DispatchAgent(context.Background(), DispatchAgentOpts{
			Name:       "worker",
			Task:       "do the thing",
			Background: true,
			OnComplete: func(r DispatchAgentResult) { completed <- r },
		})
		started <- err
	}()

	frame := fe.awaitMethod("ext/dispatch_agent")
	params, _ := frame["params"].(map[string]any)
	if got := params["background"]; got != true {
		t.Errorf("background = %v, want true for old-engine asynchronous compatibility", got)
	}
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"name": "worker", "dispatchId": "d-42", "exitCode": 0})

	if err := <-started; err != nil {
		t.Fatalf("dispatch failed: %v", err)
	}

	fe.notify("dispatch_complete", map[string]any{
		"name": "worker", "dispatchId": "d-42", "output": "done", "exitCode": 0,
	})

	select {
	case result := <-completed:
		if result.Output != "done" || result.DispatchID != "d-42" {
			t.Errorf("OnComplete received %+v, want the d-42 completion", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("OnComplete never fired for the asynchronous dispatch")
	}
}

// TestForegroundDispatchWaitsForCompletion pins the explicit opt-in path.
func TestForegroundDispatchWaitsForCompletion(t *testing.T) {
	fe := newFakeEngine(t, WithName("foreground-dispatch-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, err := ctx.DispatchAgent(context.Background(), DispatchAgentOpts{
			Name: "worker", Task: "wait", WaitForCompletion: true,
		})
		if err != nil {
			t.Errorf("dispatch failed: %v", err)
		}
	}()

	frame := fe.awaitMethod("ext/dispatch_agent")
	params, _ := frame["params"].(map[string]any)
	if got := params["waitForCompletion"]; got != true {
		t.Errorf("waitForCompletion = %v, want true", got)
	}
	select {
	case <-done:
		t.Fatal("foreground dispatch returned before terminal response")
	case <-time.After(25 * time.Millisecond):
	}
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"name": "worker", "output": "done", "exitCode": 0})
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("foreground dispatch did not return after terminal response")
	}
}

// TestParallelDispatchesRouteByDispatchID is the reason routing is id-first.
// Two dispatches of the same agent name run at once; each must receive its own
// completion and neither may see the other's.
func TestParallelDispatchesRouteByDispatchID(t *testing.T) {
	fe := newFakeEngine(t, WithName("parallel-dispatch-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)
	first := make(chan DispatchAgentResult, 1)
	second := make(chan DispatchAgentResult, 1)

	launch := func(dispatchID string, sink chan DispatchAgentResult) {
		done := make(chan error, 1)
		go func() {
			_, err := ctx.DispatchAgent(context.Background(), DispatchAgentOpts{
				Name:       "twin",
				Task:       "task for " + dispatchID,
				OnComplete: func(r DispatchAgentResult) { sink <- r },
			})
			done <- err
		}()
		frame := fe.await(func(f map[string]any) bool {
			if f["method"] != "ext/dispatch_agent" {
				return false
			}
			params, _ := f["params"].(map[string]any)
			return params["task"] == "task for "+dispatchID
		})
		id, _ := frame["id"].(float64)
		fe.respond(id, map[string]any{"name": "twin", "dispatchId": dispatchID})
		if err := <-done; err != nil {
			t.Fatalf("dispatch %s failed: %v", dispatchID, err)
		}
	}

	launch("d-A", first)
	launch("d-B", second)

	fe.notify("dispatch_complete", map[string]any{
		"name": "twin", "dispatchId": "d-B", "output": "B finished",
	})

	select {
	case r := <-second:
		if r.Output != "B finished" {
			t.Errorf("second dispatch got %q, want 'B finished'", r.Output)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the d-B completion never reached its own callback")
	}

	// The other dispatch is still running and must not have been completed by
	// its twin's notification.
	select {
	case r := <-first:
		t.Fatalf("the d-A callback fired on d-B's completion: %+v", r)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestAckDispatchLost(t *testing.T) {
	fe := newFakeEngine(t, WithName("ack-dispatch-lost-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	done := make(chan error, 1)
	go func() {
		done <- fe.sdk.newContext(nil).AckDispatchLost(context.Background(), "dispatch-123")
	}()

	frame := fe.await(func(f map[string]any) bool {
		return f["method"] == "ext/ack_dispatch_lost"
	})
	params, ok := frame["params"].(map[string]any)
	if !ok || params["dispatchId"] != "dispatch-123" {
		t.Fatalf("ack params = %#v, want dispatchId", frame["params"])
	}
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"ok": true})
	if err := <-done; err != nil {
		t.Fatalf("AckDispatchLost: %v", err)
	}
}

// TestDispatchStreamingCallbacksRoute pins the lifecycle callbacks, which
// arrive while the child runs rather than at the end.
func TestDispatchStreamingCallbacksRoute(t *testing.T) {
	fe := newFakeEngine(t, WithName("dispatch-streaming-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)
	toolStarts := make(chan DispatchToolStartInfo, 1)
	deltas := make(chan DispatchTextDeltaInfo, 1)

	done := make(chan error, 1)
	go func() {
		_, err := ctx.DispatchAgent(context.Background(), DispatchAgentOpts{
			Name:        "streamer",
			Task:        "stream",
			Background:  true,
			OnToolStart: func(i DispatchToolStartInfo) { toolStarts <- i },
			OnTextDelta: func(i DispatchTextDeltaInfo) { deltas <- i },
		})
		done <- err
	}()

	frame := fe.awaitMethod("ext/dispatch_agent")
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"name": "streamer", "dispatchId": "d-s"})
	if err := <-done; err != nil {
		t.Fatalf("dispatch failed: %v", err)
	}

	fe.notify("dispatch_tool_start", map[string]any{
		"name": "streamer", "dispatchId": "d-s", "toolName": "Read", "toolId": "t1",
	})
	fe.notify("dispatch_text_delta", map[string]any{
		"name": "streamer", "dispatchId": "d-s", "delta": "hel", "accumulated": "hel",
	})

	select {
	case info := <-toolStarts:
		if info.ToolName != "Read" {
			t.Errorf("tool start = %+v, want Read", info)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("OnToolStart never fired")
	}

	select {
	case info := <-deltas:
		if info.Delta != "hel" {
			t.Errorf("text delta = %+v, want 'hel'", info)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("OnTextDelta never fired")
	}
}

// TestForegroundDispatchUnbindsCallbacks pins cleanup. A foreground dispatch
// is finished when its call returns, so leaving its handlers bound would let a
// later dispatch of the same agent name deliver into a stale closure.
func TestForegroundDispatchUnbindsCallbacks(t *testing.T) {
	fe := newFakeEngine(t, WithName("dispatch-cleanup-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)
	stale := make(chan DispatchTextDeltaInfo, 1)

	done := make(chan error, 1)
	go func() {
		_, err := ctx.DispatchAgent(context.Background(), DispatchAgentOpts{
			Name:              "oneshot",
			Task:              "quick",
			WaitForCompletion: true,
			OnTextDelta:       func(i DispatchTextDeltaInfo) { stale <- i },
		})
		done <- err
	}()

	frame := fe.awaitMethod("ext/dispatch_agent")
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"name": "oneshot", "output": "finished"})
	if err := <-done; err != nil {
		t.Fatalf("dispatch failed: %v", err)
	}

	fe.notify("dispatch_text_delta", map[string]any{
		"name": "oneshot", "delta": "late", "accumulated": "late",
	})

	select {
	case info := <-stale:
		t.Fatalf("a finished foreground dispatch still received a delta: %+v", info)
	case <-time.After(200 * time.Millisecond):
	}
}

// TestChildQuestionIsAnswered pins the blocking case. The child's run is halted
// until the answer arrives, so the SDK must call OnChildQuestion and send the
// result back without the caller doing anything.
func TestChildQuestionIsAnswered(t *testing.T) {
	fe := newFakeEngine(t, WithName("child-question-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)

	done := make(chan error, 1)
	go func() {
		_, err := ctx.DispatchAgent(context.Background(), DispatchAgentOpts{
			Name:       "asker",
			Task:       "ask something",
			Background: true,
			OnChildQuestion: func(info DispatchChildQuestionInfo) (string, bool, error) {
				return "the answer is 42", false, nil
			},
		})
		done <- err
	}()

	frame := fe.awaitMethod("ext/dispatch_agent")
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"name": "asker", "dispatchId": "d-q"})
	if err := <-done; err != nil {
		t.Fatalf("dispatch failed: %v", err)
	}

	fe.notify("dispatch_child_question", map[string]any{
		"name": "asker", "dispatchId": "d-q", "requestId": "q-1",
		"question": "what is it?", "depth": 1,
	})

	answer := fe.awaitMethod("ext/answer_dispatch_question")
	params, _ := answer["params"].(map[string]any)
	if params["answer"] != "the answer is 42" {
		t.Errorf("answer = %v, want the handler's reply", params["answer"])
	}
	if params["requestId"] != "q-1" || params["dispatchId"] != "d-q" {
		t.Errorf("answer routing = %+v, want requestId q-1 / dispatchId d-q", params)
	}
	if params["cancelled"] != false {
		t.Errorf("cancelled = %v, want false", params["cancelled"])
	}
}

// TestChildQuestionHandlerErrorStillAnswers pins the failure path. The child is
// blocked on a reply, so a handler error must still produce one — a
// cancellation — rather than leaving the child's run hung forever.
func TestChildQuestionHandlerErrorStillAnswers(t *testing.T) {
	fe := newFakeEngine(t, WithName("child-question-error-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)

	done := make(chan error, 1)
	go func() {
		_, err := ctx.DispatchAgent(context.Background(), DispatchAgentOpts{
			Name:       "asker",
			Task:       "ask",
			Background: true,
			OnChildQuestion: func(info DispatchChildQuestionInfo) (string, bool, error) {
				return "", false, errTestToolFailed
			},
		})
		done <- err
	}()

	frame := fe.awaitMethod("ext/dispatch_agent")
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"name": "asker", "dispatchId": "d-e"})
	if err := <-done; err != nil {
		t.Fatalf("dispatch failed: %v", err)
	}

	fe.notify("dispatch_child_question", map[string]any{
		"name": "asker", "dispatchId": "d-e", "requestId": "q-2", "question": "?",
	})

	answer := fe.awaitMethod("ext/answer_dispatch_question")
	params, _ := answer["params"].(map[string]any)
	if params["cancelled"] != true {
		t.Errorf("cancelled = %v, want true so the child is released", params["cancelled"])
	}
	fe.awaitLog("child question handler failed")
}
