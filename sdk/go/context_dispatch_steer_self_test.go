package ion

import (
	"context"
	"testing"
)

// context_dispatch_steer_self_test.go — the kind classification on ext/steer_self.
//
// A steer that carries no kind is delivered unclassified, and every client's
// suppression check keys on the kind — so an unclassified dispatch completion or
// scheduled heartbeat renders in the transcript as a message the operator
// appears to have typed. These tests pin the wire bytes, because the field
// being present-and-correct is the whole contract.

// TestSteerSelfSendsKind pins that a classified steer puts kind on the wire
// alongside the message.
func TestSteerSelfSendsKind(t *testing.T) {
	fe := newFakeEngine(t, WithName("steer-self-kind-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)

	done := make(chan error, 1)
	go func() {
		_, err := ctx.SteerSelf(context.Background(), "[Agent dev-lead completed in 42s]", SteerSelfOpts{
			Kind: "agent_completion",
		})
		done <- err
	}()

	frame := fe.awaitMethod("ext/steer_self")
	params, ok := frame["params"].(map[string]any)
	if !ok {
		t.Fatalf("ext/steer_self frame has no params object: %+v", frame)
	}
	if got := params["message"]; got != "[Agent dev-lead completed in 42s]" {
		t.Errorf("message = %v, want the completion text", got)
	}
	if got := params["kind"]; got != "agent_completion" {
		t.Errorf("kind = %v, want agent_completion", got)
	}

	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"delivered": true, "outcome": "steered"})
	if err := <-done; err != nil {
		t.Fatalf("SteerSelf: %v", err)
	}
}

// TestSteerSelfOmitsEmptyKind pins that an unclassified steer sends no kind key
// at all. The engine's field is omitempty, so an explicit "" is a different
// message from an absent one.
func TestSteerSelfOmitsEmptyKind(t *testing.T) {
	fe := newFakeEngine(t, WithName("steer-self-nokind-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)

	done := make(chan error, 1)
	go func() {
		_, err := ctx.SteerSelf(context.Background(), "plain message", SteerSelfOpts{})
		done <- err
	}()

	frame := fe.awaitMethod("ext/steer_self")
	params, ok := frame["params"].(map[string]any)
	if !ok {
		t.Fatalf("ext/steer_self frame has no params object: %+v", frame)
	}
	if _, present := params["kind"]; present {
		t.Errorf("kind key present on an unclassified steer: %+v", params)
	}

	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"delivered": true, "outcome": "sent"})
	if err := <-done; err != nil {
		t.Fatalf("SteerSelf: %v", err)
	}
}

// TestSteerSelfReturnsOutcome pins that the engine's verdict reaches the
// caller. bubbleToParent branches on it: "steered" means a live run took the
// message mid-turn, "sent" means the run was idle and it arrived as a prompt.
func TestSteerSelfReturnsOutcome(t *testing.T) {
	fe := newFakeEngine(t, WithName("steer-self-outcome-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)

	type res struct {
		out SteerDispatchResult
		err error
	}
	got := make(chan res, 1)
	go func() {
		out, err := ctx.SteerSelf(context.Background(), "msg", SteerSelfOpts{Kind: "checkin"})
		got <- res{out, err}
	}()

	frame := fe.awaitMethod("ext/steer_self")
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"delivered": true, "outcome": "sent"})

	r := <-got
	if r.err != nil {
		t.Fatalf("SteerSelf: %v", r.err)
	}
	if !r.out.Delivered || r.out.Outcome != "sent" {
		t.Errorf("result = %+v, want delivered with outcome sent", r.out)
	}
}
