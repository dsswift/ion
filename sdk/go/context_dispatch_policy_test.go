package ion

import (
	"context"
	"testing"
	"time"
)

// context_dispatch_policy_test.go — the sub-agent policy on ext/dispatch_agent.
//
// SubAgentPolicy decides what an empty AllowedSubAgents means: "allowlist"
// makes it a hard restriction (the child may dispatch nothing), while the
// engine default leaves it meaning unrestricted. A harness that fans out
// through leaf agents depends on the field reaching the wire — dropped
// silently, a leaf agent may dispatch anything, including re-dispatching its
// own lead into the depth cap.

// TestDispatchAgentSendsSubAgentPolicy pins that the policy and the (empty)
// allowlist both serialise: policy present, empty list omitted (omitempty),
// which is exactly the combination that means "may dispatch nothing".
func TestDispatchAgentSendsSubAgentPolicy(t *testing.T) {
	fe := newFakeEngine(t, WithName("dispatch-policy-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)

	done := make(chan error, 1)
	go func() {
		_, err := ctx.DispatchAgent(context.Background(), DispatchAgentOpts{
			Name:           "leaf-agent",
			Task:           "do the thing",
			SubAgentPolicy: "allowlist",
		})
		done <- err
	}()

	frame := fe.awaitMethod("ext/dispatch_agent")
	params, ok := frame["params"].(map[string]any)
	if !ok {
		t.Fatalf("ext/dispatch_agent frame has no params object: %+v", frame)
	}
	if got := params["subAgentPolicy"]; got != "allowlist" {
		t.Errorf("subAgentPolicy = %v, want allowlist", got)
	}

	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"name": "leaf-agent", "dispatchId": "d-pol"})
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("DispatchAgent never returned")
	}
}

// TestDispatchAgentOmitsEmptySubAgentPolicy pins the omitempty behaviour: an
// unset policy sends no key, preserving the engine's default semantics.
func TestDispatchAgentOmitsEmptySubAgentPolicy(t *testing.T) {
	fe := newFakeEngine(t, WithName("dispatch-nopolicy-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)

	done := make(chan error, 1)
	go func() {
		_, err := ctx.DispatchAgent(context.Background(), DispatchAgentOpts{
			Name: "worker", Task: "t",
		})
		done <- err
	}()

	frame := fe.awaitMethod("ext/dispatch_agent")
	params, ok := frame["params"].(map[string]any)
	if !ok {
		t.Fatalf("ext/dispatch_agent frame has no params object: %+v", frame)
	}
	if _, present := params["subAgentPolicy"]; present {
		t.Errorf("subAgentPolicy key present when unset: %+v", params)
	}

	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"name": "worker", "dispatchId": "d-np"})
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("DispatchAgent: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("DispatchAgent never returned")
	}
}
