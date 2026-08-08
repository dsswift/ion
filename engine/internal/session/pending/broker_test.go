package pending

import (
	"sync"
	"testing"
	"time"
)

func TestBroker_PermissionRoundTrip(t *testing.T) {
	b := New()
	ch := b.RegisterPermission("q1")

	go func() {
		time.Sleep(time.Millisecond)
		b.ResolvePermission("q1", "allow")
	}()

	select {
	case v := <-ch:
		if v != "allow" {
			t.Errorf("expected 'allow', got %q", v)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout")
	}

	b.UnregisterPermission("q1")
}

func TestBroker_DialogRoundTrip(t *testing.T) {
	b := New()
	ch := b.RegisterDialog("d1")

	go func() {
		time.Sleep(time.Millisecond)
		b.ResolveDialog("d1", "yes")
	}()

	select {
	case v := <-ch:
		if v != "yes" {
			t.Errorf("expected 'yes', got %v", v)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout")
	}
}

func TestBroker_ElicitRoundTrip(t *testing.T) {
	b := New()
	ch := b.RegisterElicit("e1")

	go func() {
		time.Sleep(time.Millisecond)
		b.ResolveElicit("e1", ElicitReply{
			Response: map[string]interface{}{"answer": "42"},
		})
	}()

	select {
	case v := <-ch:
		if v.Response["answer"] != "42" {
			t.Errorf("expected answer=42, got %v", v.Response)
		}
		if v.Cancelled {
			t.Error("expected not cancelled")
		}
	case <-time.After(time.Second):
		t.Fatal("timeout")
	}
}

func TestBroker_ElicitCancelled(t *testing.T) {
	b := New()
	ch := b.RegisterElicit("e2")

	go func() {
		time.Sleep(time.Millisecond)
		b.ResolveElicit("e2", ElicitReply{Cancelled: true})
	}()

	select {
	case v := <-ch:
		if !v.Cancelled {
			t.Error("expected cancelled")
		}
	case <-time.After(time.Second):
		t.Fatal("timeout")
	}
}

func TestBroker_ResolveUnknownIsNoop(t *testing.T) {
	b := New()
	// None of these should panic.
	b.ResolvePermission("nope", "x")
	b.ResolveDialog("nope", "x")
	b.ResolveElicit("nope", ElicitReply{})
}

func TestBroker_UnregisterRemovesEntry(t *testing.T) {
	b := New()
	b.RegisterPermission("p1")
	b.UnregisterPermission("p1")

	// Resolve should be a no-op after unregister.
	b.ResolvePermission("p1", "late")
}

func TestBroker_ConcurrentAccess(t *testing.T) {
	b := New()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(3)
		go func(idx int) {
			defer wg.Done()
			id := "p" + string(rune('0'+idx%10))
			ch := b.RegisterPermission(id)
			go func() { b.ResolvePermission(id, "ok") }()
			select {
			case <-ch:
			case <-time.After(100 * time.Millisecond):
			}
			b.UnregisterPermission(id)
		}(i)
		go func(idx int) {
			defer wg.Done()
			id := "d" + string(rune('0'+idx%10))
			ch := b.RegisterDialog(id)
			go func() { b.ResolveDialog(id, "ok") }()
			select {
			case <-ch:
			case <-time.After(100 * time.Millisecond):
			}
			b.UnregisterDialog(id)
		}(i)
		go func(idx int) {
			defer wg.Done()
			id := "e" + string(rune('0'+idx%10))
			ch := b.RegisterElicit(id)
			go func() { b.ResolveElicit(id, ElicitReply{}) }()
			select {
			case <-ch:
			case <-time.After(100 * time.Millisecond):
			}
			b.UnregisterElicit(id)
		}(i)
	}
	wg.Wait()
}

func TestBroker_DialogResolveUnknownReturnsFalse(t *testing.T) {
	b := New()
	if b.ResolveDialog("missing", "x") {
		t.Error("expected false for unknown dialog")
	}
}

func TestBroker_ElicitResolveUnknownReturnsFalse(t *testing.T) {
	b := New()
	if b.ResolveElicit("missing", ElicitReply{}) {
		t.Error("expected false for unknown elicit")
	}
}

// TestBroker_EarlyStopRoundTrip exercises the happy path: register a
// pending early-stop wire request, resolve it from another goroutine,
// confirm the reply reaches the waiter. Mirrors the elicit round-trip
// pattern.
func TestBroker_EarlyStopRoundTrip(t *testing.T) {
	b := New()
	ch := b.RegisterEarlyStop("es-1")

	cont := true
	go func() {
		time.Sleep(time.Millisecond)
		b.ResolveEarlyStop("es-1", EarlyStopReply{
			ForceContinue:   &cont,
			ContinueMessage: "test msg",
		})
	}()

	select {
	case v := <-ch:
		if v.ForceContinue == nil || !*v.ForceContinue {
			t.Errorf("expected ForceContinue=&true, got %v", v.ForceContinue)
		}
		if v.ContinueMessage != "test msg" {
			t.Errorf("expected ContinueMessage='test msg', got %q", v.ContinueMessage)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout")
	}
}

// TestBroker_EarlyStopEmptyReply confirms a wholly-empty reply still
// reaches the waiter. The runloop treats an empty reply as "no opinion"
// but the broker must deliver it so the caller's select unblocks rather
// than timing out — distinguishing "consumer expressed no opinion" from
// "consumer never responded" matters for the engine's fall-through logic.
func TestBroker_EarlyStopEmptyReply(t *testing.T) {
	b := New()
	ch := b.RegisterEarlyStop("es-empty")

	go func() {
		time.Sleep(time.Millisecond)
		b.ResolveEarlyStop("es-empty", EarlyStopReply{})
	}()

	select {
	case v := <-ch:
		if v.ForceContinue != nil {
			t.Errorf("expected nil ForceContinue, got %v", v.ForceContinue)
		}
		if v.ContinueMessage != "" {
			t.Errorf("expected empty ContinueMessage, got %q", v.ContinueMessage)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout")
	}
}

// TestBroker_EarlyStopResolveUnknownReturnsFalse covers the missing-entry
// path. ResolveEarlyStop returns false when no pending request matches,
// matching the elicitation broker's semantics. The runloop calls
// UnregisterEarlyStop on timeout, so a late response after timeout will
// hit this path.
func TestBroker_EarlyStopResolveUnknownReturnsFalse(t *testing.T) {
	b := New()
	if b.ResolveEarlyStop("missing", EarlyStopReply{}) {
		t.Error("expected false for unknown early-stop request")
	}
}

// TestBroker_EarlyStopUnregisterStopsDelivery confirms that after
// UnregisterEarlyStop the channel-send path no longer hits. Defends
// against a race where the runloop times out and unregisters before the
// consumer's late response arrives — the late response should be
// silently dropped.
func TestBroker_EarlyStopUnregisterStopsDelivery(t *testing.T) {
	b := New()
	ch := b.RegisterEarlyStop("es-unreg")
	b.UnregisterEarlyStop("es-unreg")

	// Resolving after unregister is a no-op.
	b.ResolveEarlyStop("es-unreg", EarlyStopReply{ContinueMessage: "late"})

	select {
	case v := <-ch:
		t.Errorf("expected no delivery after unregister, got %+v", v)
	case <-time.After(20 * time.Millisecond):
		// Expected path.
	}
}

// TestBroker_ToolGateRoundTrip pins the tool-gate register/resolve path: a
// deny with a reason reaches the waiting tool loop.
func TestBroker_ToolGateRoundTrip(t *testing.T) {
	b := New()
	ch := b.RegisterToolGate("tg-1")

	go func() {
		time.Sleep(time.Millisecond)
		b.ResolveToolGate("tg-1", ToolGateReply{Decision: "deny", Reason: "policy"})
	}()

	select {
	case v := <-ch:
		if v.Decision != "deny" || v.Reason != "policy" {
			t.Errorf("expected (deny, policy), got (%q, %q)", v.Decision, v.Reason)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout")
	}
}

// TestBroker_ToolGateResolveUnknownReturnsFalse pins the stale-response
// signal: resolving an unknown gate ID reports false so the caller can log
// the drop.
func TestBroker_ToolGateResolveUnknownReturnsFalse(t *testing.T) {
	b := New()
	if b.ResolveToolGate("missing", ToolGateReply{Decision: "deny"}) {
		t.Error("expected false for unknown tool-gate ID")
	}
}

// TestBroker_ToolGateUnregisterStopsDelivery defends the timeout race: a late
// response after the tool loop unregistered is silently dropped.
func TestBroker_ToolGateUnregisterStopsDelivery(t *testing.T) {
	b := New()
	ch := b.RegisterToolGate("tg-unreg")
	b.UnregisterToolGate("tg-unreg")

	b.ResolveToolGate("tg-unreg", ToolGateReply{Decision: "deny", Reason: "late"})

	select {
	case v := <-ch:
		t.Errorf("expected no delivery after unregister, got %+v", v)
	case <-time.After(20 * time.Millisecond):
		// Expected path.
	}
}
