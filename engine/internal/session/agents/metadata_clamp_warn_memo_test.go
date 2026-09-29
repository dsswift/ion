package agents

import "testing"

// A clamp that repeats identically must warn once; a change in what was
// clamped, or a doubling of the original size, must warn again.
func TestShouldWarnClamp_OncePerSignature(t *testing.T) {
	resetClampWarnMemoForTest()
	rep := &ClampReport{Scope: "value", ClampedKeys: []string{"dispatches", "task"}, OriginalBytes: 92_000}
	attr := ClampAttribution{Key: "tab-1", ConversationID: "c1"}

	sig := clampSignature(attr, "ios-dev", rep)
	if !shouldWarnClamp(sig) {
		t.Fatal("first occurrence must warn")
	}
	if shouldWarnClamp(sig) {
		t.Fatal("identical repeat must not warn again")
	}

	// Same keys, same size class: still silent.
	rep.OriginalBytes = 100_000
	if shouldWarnClamp(clampSignature(attr, "ios-dev", rep)) {
		t.Fatal("a size change inside the same log2 bucket is the same signature")
	}
	// Doubling crosses a bucket: warns again.
	rep.OriginalBytes = 200_000
	if !shouldWarnClamp(clampSignature(attr, "ios-dev", rep)) {
		t.Fatal("a size class change must warn again")
	}
	// A different agent on the same session is its own signature.
	if !shouldWarnClamp(clampSignature(attr, "comms", rep)) {
		t.Fatal("another agent must warn on its first clamp")
	}
}

func TestShouldWarnClamp_MemoIsBounded(t *testing.T) {
	resetClampWarnMemoForTest()
	for i := 0; i < clampWarnMemoCap+10; i++ {
		shouldWarnClamp(clampSignature(ClampAttribution{Key: "k"}, "agent", &ClampReport{OriginalBytes: i + 1, ClampedKeys: []string{string(rune('a' + i%26)), string(rune(i))}}))
	}
	clampWarnMu.Lock()
	n := len(clampWarnSeen)
	clampWarnMu.Unlock()
	if n > clampWarnMemoCap {
		t.Fatalf("memo must stay bounded at %d, has %d", clampWarnMemoCap, n)
	}
}
