package ion

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// transport_test.go — framing, id allocation, and reentrancy.
//
// These are the properties an SDK in any language has to get right, and each
// one has a specific failure it prevents: a wrong id base silently misroutes
// responses, a read loop that blocks on its own pending call deadlocks the
// webhook veto, and split-write handling is the difference between working on
// a pipe and working only in tests.

// TestFramingHandlesSplitAndCoalescedWrites pins that the SDK frames on
// newlines rather than on write boundaries. A pipe delivers whatever the
// kernel gives it: two frames can arrive in one read, and one frame can arrive
// in three. An implementation that treats a read as a frame works in tests and
// fails against a real engine.
func TestFramingHandlesSplitAndCoalescedWrites(t *testing.T) {
	fe := newFakeEngine(t, WithName("framing-test"))
	fe.start()

	// One request split across three writes, mid-token.
	frame := `{"jsonrpc":"2.0","id":1,"method":"init","params":{}}` + "\n"
	fe.sendRaw([]byte(frame[:20]))
	time.Sleep(10 * time.Millisecond)
	fe.sendRaw([]byte(frame[20:40]))
	time.Sleep(10 * time.Millisecond)
	fe.sendRaw([]byte(frame[40:]))

	fe.awaitResponse(1)

	// Two requests coalesced into a single write.
	both := `{"jsonrpc":"2.0","id":2,"method":"hook/session_start","params":{}}` + "\n" +
		`{"jsonrpc":"2.0","id":3,"method":"hook/session_end","params":{}}` + "\n"
	fe.sendRaw([]byte(both))

	fe.awaitResponse(2)
	fe.awaitResponse(3)
}

// TestRequestIDsStartAtExtBase pins the id base. The engine numbers its own
// requests from 1; an SDK that also started at 1 would have the engine route
// its responses to the wrong pending call, and the symptom would be a hang or
// a wildly wrong result rather than an error.
func TestRequestIDsStartAtExtBase(t *testing.T) {
	fe := newFakeEngine(t, WithName("id-base-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	go func() {
		ctx := fe.sdk.newContext(nil)
		// Result is irrelevant; the id on the outbound frame is the assertion.
		_, _ = ctx.CallTool(context.Background(), "some_tool", nil) //nolint:errcheck // asserting the request frame, not the result
	}()

	frame := fe.awaitMethod("ext/call_tool")
	id, ok := frame["id"].(float64)
	if !ok {
		t.Fatalf("outbound request has no numeric id: %+v", frame)
	}
	if int64(id) != extRequestIDBase {
		t.Errorf("first outbound request id = %d, want %d", int64(id), extRequestIDBase)
	}
}

// TestRequestIDsIncrement pins that ids advance, so two concurrent calls
// cannot collide in the pending table.
func TestRequestIDsIncrement(t *testing.T) {
	fe := newFakeEngine(t, WithName("id-increment-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)
	for range 3 {
		go func() {
			_, _ = ctx.CallTool(context.Background(), "t", nil) //nolint:errcheck // asserting ids, not results
		}()
	}

	seen := map[int64]bool{}
	deadline := time.After(5 * time.Second)
	for len(seen) < 3 {
		select {
		case <-deadline:
			t.Fatalf("only saw %d distinct request ids", len(seen))
		default:
		}
		for _, f := range fe.allFrames() {
			if f["method"] == "ext/call_tool" {
				if id, ok := f["id"].(float64); ok {
					seen[int64(id)] = true
				}
			}
		}
		time.Sleep(5 * time.Millisecond)
	}

	for id := range seen {
		if id < extRequestIDBase {
			t.Errorf("request id %d is below the ext base %d", id, extRequestIDBase)
		}
	}
}

// TestServesInboundWhileOutboundPending is the reentrancy guarantee.
//
// Post-init webhook registration is an ext/register_webhook call, and the
// engine fires the veto-capable webhook_registered hook back at the extension
// before answering it. An SDK whose read loop waited for its own response
// would never see the hook, the engine would never get an answer, and the
// registration would hang forever. This reproduces exactly that sequence.
func TestServesInboundWhileOutboundPending(t *testing.T) {
	fe := newFakeEngine(t, WithName("reentrancy-test"))

	hookFired := make(chan struct{})
	OnHook(fe.sdk, HookWebhookRegistered,
		func(ctx *Context, info AsyncRegistrationInfo) (AsyncRegistrationVeto, error) {
			close(hookFired)
			return AsyncRegistrationVeto{}, nil
		})

	fe.start()
	fe.doInit(ExtensionConfig{})

	registered := make(chan error, 1)
	go func() {
		_, err := fe.sdk.Webhooks().Register(context.Background(),
			WebhookRoute{Path: "/hook", Auth: WebhookAuth{Kind: AuthNone}},
			func(c context.Context, ctx *Context, req WebhookRequest) (WebhookResponse, error) {
				return WebhookResponse{}, nil
			})
		registered <- err
	}()

	// The SDK's registration call is now pending.
	regFrame := fe.awaitMethod("ext/register_webhook")
	regID, ok := regFrame["id"].(float64)
	if !ok {
		t.Fatalf("register frame has no id: %+v", regFrame)
	}

	// Fire the hook *before* answering. A blocking read loop dies here.
	fe.request(500, "hook/"+HookNameWebhookRegistered, map[string]any{
		"kind": "webhook", "id": "/hook", "origin": "runtime",
	})

	select {
	case <-hookFired:
	case <-time.After(5 * time.Second):
		t.Fatal("hook did not fire while the registration call was pending: the read loop is blocked")
	}
	fe.awaitResponse(500)

	// Now answer the registration.
	fe.respond(regID, map[string]any{"ok": true, "id": "/hook"})

	select {
	case err := <-registered:
		if err != nil {
			t.Fatalf("webhook registration failed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("registration did not complete after the engine answered")
	}
}

// TestMethodNotFoundMapsToSentinel pins graceful degradation. The protocol has
// no version negotiation, so -32601 is how an SDK learns an engine build lacks
// a capability — and the connection must stay usable afterwards, because the
// caller is expected to carry on without that one method.
func TestMethodNotFoundMapsToSentinel(t *testing.T) {
	fe := newFakeEngine(t, WithName("degradation-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)

	result := make(chan error, 1)
	go func() {
		_, err := ctx.GetContextUsage(context.Background())
		result <- err
	}()

	frame := fe.awaitMethod("ext/get_context_usage")
	id, _ := frame["id"].(float64)
	fe.respondError(id, CodeMethodNotFound, "method not found: ext/get_context_usage")

	select {
	case err := <-result:
		if !errors.Is(err, ErrMethodNotFound) {
			t.Fatalf("error = %v, want it to match ErrMethodNotFound", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("call did not return after the -32601 response")
	}

	// The connection must still work: degradation means "skip that method",
	// not "the extension is finished".
	fe.request(600, "hook/"+HookNameSessionStart, map[string]any{})
	fe.awaitResponse(600)
}

// TestUnknownInboundMethodAnswers32601 pins the mirror case: an engine calling
// a method this SDK does not implement gets a well-formed refusal rather than
// silence, so the engine's own pending call resolves.
func TestUnknownInboundMethodAnswers32601(t *testing.T) {
	fe := newFakeEngine(t, WithName("unknown-method-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(700, "engine/some_future_method", map[string]any{})
	resp := fe.awaitResponse(700)

	errObj, ok := resp["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected an error response, got %+v", resp)
	}
	if code, _ := errObj["code"].(float64); int(code) != CodeMethodNotFound {
		t.Errorf("error code = %v, want %d", errObj["code"], CodeMethodNotFound)
	}
}

// TestLogNotificationShape pins the log wire format, which the engine's
// rpcLogNotification decodes into its structured logger. Fields must stay a
// nested object: flattening them into the message would make every extension
// log line unqueryable.
func TestLogNotificationShape(t *testing.T) {
	fe := newFakeEngine(t, WithName("log-test"))
	fe.start()

	fe.sdk.Log().Warn("something happened", map[string]any{"count": 3, "who": "tester"})

	frame := fe.awaitLog("something happened")
	params, ok := frame["params"].(map[string]any)
	if !ok {
		t.Fatalf("log frame has no params object: %+v", frame)
	}
	if params["level"] != "warn" {
		t.Errorf("level = %v, want warn", params["level"])
	}
	fields, ok := params["fields"].(map[string]any)
	if !ok {
		t.Fatalf("log params carry no fields object: %+v", params)
	}
	if fields["who"] != "tester" {
		t.Errorf("fields.who = %v, want tester", fields["who"])
	}
	if count, _ := fields["count"].(float64); int(count) != 3 {
		t.Errorf("fields.count = %v, want 3", fields["count"])
	}
}

// TestMalformedFrameIsLoggedNotFatal pins that garbage on the wire does not
// kill the connection. A frame the SDK cannot parse has no id to answer, so
// the only correct response is to record it and keep serving.
func TestMalformedFrameIsLoggedNotFatal(t *testing.T) {
	fe := newFakeEngine(t, WithName("malformed-test"))
	fe.start()

	fe.sendRaw([]byte("this is not json\n"))
	fe.awaitLog("unparseable inbound frame")

	// Still alive.
	fe.request(1, methodInit, ExtensionConfig{})
	fe.awaitResponse(1)
}

// TestCallRespectsContextCancellation pins that the caller's context is the
// timeout. The engine applies none of its own to an ext/* call, so a caller
// with no deadline waits forever by design — and one with a deadline must
// actually be released.
func TestCallRespectsContextCancellation(t *testing.T) {
	fe := newFakeEngine(t, WithName("cancel-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)
	c, cancel := context.WithCancel(context.Background())

	result := make(chan error, 1)
	go func() {
		_, err := ctx.CallTool(c, "slow_tool", nil)
		result <- err
	}()

	fe.awaitMethod("ext/call_tool")
	cancel()

	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelling the context did not release the call")
	}
}

// TestConcurrentWritesProduceValidFrames pins write serialisation. Handlers run
// concurrently, and two goroutines writing without a lock would interleave
// mid-line and produce output the engine cannot parse.
func TestConcurrentWritesProduceValidFrames(t *testing.T) {
	fe := newFakeEngine(t, WithName("concurrent-write-test"))
	fe.start()

	const writers = 20
	for i := range writers {
		go fe.sdk.Log().Info("concurrent line", map[string]any{"n": i})
	}

	// Every frame the reader decoded is valid JSON by construction — a torn
	// write would have failed the decoder and stopped the read loop. Waiting
	// for all of them proves none was lost or corrupted.
	seen := 0
	deadline := time.After(5 * time.Second)
	for seen < writers {
		select {
		case <-deadline:
			t.Fatalf("only %d of %d log frames arrived intact", seen, writers)
		default:
		}
		seen = 0
		for _, f := range fe.allFrames() {
			if f["method"] == methodLog {
				seen++
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestResponseToUnknownIDIsIgnored pins that a late response to an abandoned
// call is dropped rather than panicking on a closed channel. This is the
// normal aftermath of a cancelled call, not an edge case.
func TestResponseToUnknownIDIsIgnored(t *testing.T) {
	fe := newFakeEngine(t, WithName("stale-response-test"))
	fe.start()

	fe.respond(999999, map[string]any{"ok": true})
	fe.awaitLog("response for unknown request id")

	fe.request(1, methodInit, ExtensionConfig{})
	fe.awaitResponse(1)
}

// TestHandlerPanicBecomesErrorResponse pins that a panicking handler produces
// an error response and a log line instead of taking the process down. A
// crashed extension loses the stack that explains it; an error response keeps
// the diagnosis attached to the call that caused it.
func TestHandlerPanicBecomesErrorResponse(t *testing.T) {
	fe := newFakeEngine(t, WithName("panic-test"))

	OnHook(fe.sdk, HookSessionStart, func(ctx *Context, _ NoPayload) (NoResult, error) {
		panic("handler exploded")
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(800, "hook/"+HookNameSessionStart, map[string]any{})
	resp := fe.awaitResponse(800)

	errObj, ok := resp["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected an error response after a panic, got %+v", resp)
	}
	if msg, _ := errObj["message"].(string); !strings.Contains(msg, "handler exploded") {
		t.Errorf("error message = %q, want it to name the panic", msg)
	}
	fe.awaitLog("panic in inbound handler")
}

// TestJSONRPCVersionOnEveryFrame pins the envelope. A frame missing jsonrpc
// "2.0" is not a JSON-RPC message, and a strict peer may reject it.
func TestJSONRPCVersionOnEveryFrame(t *testing.T) {
	fe := newFakeEngine(t, WithName("envelope-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})
	fe.sdk.Log().Info("a line", nil)
	fe.awaitLog("a line")

	for _, f := range fe.allFrames() {
		if f["jsonrpc"] != "2.0" {
			data, _ := json.Marshal(f) //nolint:errcheck // diagnostic only
			t.Errorf("frame missing jsonrpc 2.0: %s", data)
		}
	}
}
