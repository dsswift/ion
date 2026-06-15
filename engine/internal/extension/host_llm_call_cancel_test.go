package extension

import (
	"context"
	"testing"
)

// host_llm_call_cancel_test.go — unit tests for the per-RPC llm_call
// cancellation registry (#225). These exercise the register / cancel /
// complete lifecycle directly on a Host value (no subprocess), pinning:
//   - cancel invokes exactly the registered CancelFunc for an id,
//   - unknown ids are a benign no-op (returns false),
//   - complete removes the entry so the map does not leak.

func TestInflightLLMCall_CancelInvokesCancelFunc(t *testing.T) {
	h := &Host{}

	cancelled := false
	ctx, cancel := context.WithCancel(context.Background())
	wrapped := func() {
		cancelled = true
		cancel()
	}

	h.registerInflightLLMCall(42, wrapped)

	if ok := h.cancelInflightLLMCall(42); !ok {
		t.Fatal("cancelInflightLLMCall returned false for a registered id")
	}
	if !cancelled {
		t.Error("registered CancelFunc was not invoked")
	}
	select {
	case <-ctx.Done():
		// expected
	default:
		t.Error("context not cancelled after cancelInflightLLMCall")
	}
}

func TestInflightLLMCall_UnknownIDIsNoOp(t *testing.T) {
	h := &Host{}
	if ok := h.cancelInflightLLMCall(999); ok {
		t.Error("cancelInflightLLMCall returned true for an unknown id")
	}
}

func TestInflightLLMCall_CompleteRemovesEntry(t *testing.T) {
	h := &Host{}
	_, cancel := context.WithCancel(context.Background())
	h.registerInflightLLMCall(7, cancel)

	h.completeInflightLLMCall(7)

	// After completion the id is unknown — a late cancel (racing a finished
	// call) must be a no-op, proving the entry was removed (no leak).
	if ok := h.cancelInflightLLMCall(7); ok {
		t.Error("entry still present after completeInflightLLMCall; map leaked")
	}

	h.inflightLLMMu.Lock()
	n := len(h.inflightLLMCalls)
	h.inflightLLMMu.Unlock()
	if n != 0 {
		t.Errorf("inflightLLMCalls has %d entries after complete, want 0", n)
	}
}

func TestInflightLLMCall_MultipleCallsIndependent(t *testing.T) {
	h := &Host{}
	aCancelled, bCancelled := false, false
	h.registerInflightLLMCall(1, func() { aCancelled = true })
	h.registerInflightLLMCall(2, func() { bCancelled = true })

	// Cancelling one must not affect the other.
	if ok := h.cancelInflightLLMCall(1); !ok {
		t.Fatal("cancel id=1 returned false")
	}
	if !aCancelled {
		t.Error("id=1 CancelFunc not invoked")
	}
	if bCancelled {
		t.Error("id=2 CancelFunc invoked when only id=1 was cancelled")
	}

	// id=2 still in flight and cancellable.
	if ok := h.cancelInflightLLMCall(2); !ok {
		t.Fatal("cancel id=2 returned false; should still be in flight")
	}
	if !bCancelled {
		t.Error("id=2 CancelFunc not invoked")
	}
}
