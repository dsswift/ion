package utils

import (
	"context"
	"testing"
)

// TestAmbientCtx_PlainLogPicksUpCorrelation pins the core ambient-logging
// invariant: a goroutine that called SetAmbientCtx with a correlated context
// will have session_id and conversation_id stamped on subsequent plain
// Log/Debug/Info/Warn/Error calls — WITHOUT LogCtx. Revert ambientCorrelationIDs
// from logAtWithFields and this test goes red.
func TestAmbientCtx_PlainLogPicksUpCorrelation(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	ctx := WithSessionID(context.Background(), "ambient-sess-1")
	ctx = WithConversationID(ctx, "1783086029697-70bb70d8c91b")
	ctx = WithTraceID(ctx, "aaaabbbbccccddddeeeeffffaaaabbbb")

	SetAmbientCtx(ctx)
	defer ClearAmbientCtx()

	// Plain Log — no ctx passed. Must still stamp correlation IDs.
	Log("TestTag", "ambient log test")

	obj := readLastLine(t, dir)

	if got := obj["session_id"]; got != "ambient-sess-1" {
		t.Errorf("session_id = %v, want ambient-sess-1", got)
	}
	if got := obj["conversation_id"]; got != "1783086029697-70bb70d8c91b" {
		t.Errorf("conversation_id = %v, want 1783086029697-70bb70d8c91b", got)
	}
	if got := obj["trace_id"]; got != "aaaabbbbccccddddeeeeffffaaaabbbb" {
		t.Errorf("trace_id = %v, want the trace id", got)
	}
}

// TestAmbientCtx_ClearRemovesCorrelation asserts ClearAmbientCtx removes
// the ambient context so subsequent plain Log calls don't stamp stale IDs.
func TestAmbientCtx_ClearRemovesCorrelation(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	ctx := WithSessionID(context.Background(), "to-be-cleared")
	ctx = WithConversationID(ctx, "1783086029697-aabbccddeeff")
	SetAmbientCtx(ctx)
	ClearAmbientCtx()

	Log("TestTag", "after clear")

	obj := readLastLine(t, dir)

	if _, present := obj["session_id"]; present {
		t.Errorf("session_id must be absent after ClearAmbientCtx, got %v", obj["session_id"])
	}
	if _, present := obj["conversation_id"]; present {
		t.Errorf("conversation_id must be absent after ClearAmbientCtx, got %v", obj["conversation_id"])
	}
}

// TestAmbientCtx_ChildGoroutineInstall pins the child-goroutine ambient-install
// path. A goroutine spawned by errgroup or a plain go-statement gets a distinct
// goroutine ID. Without calling SetAmbientCtx inside the child, its log lines
// carry no correlation IDs. This test asserts that a child goroutine that
// installs its own ambient context — the pattern used by
//
//	defer installAmbientLogging(gCtx)()
//
// in runloop_tools.go — correctly stamps session_id and conversation_id on plain
// Log calls. Remove SetAmbientCtx from the goroutine below and the assertions go
// red: correlation IDs will be absent because the child has its own goroutine ID
// and no ambient entry.
func TestAmbientCtx_ChildGoroutineInstall(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	ctx := WithSessionID(context.Background(), "child-sess-99")
	ctx = WithConversationID(ctx, "1783086029697-childinstall")

	done := make(chan struct{})
	go func() {
		defer close(done)
		// Mirror what installAmbientLogging(ctx)() does inside an errgroup child.
		// Removing these two lines makes the test go red: session_id and
		// conversation_id will be absent from the log line below because this
		// goroutine's ID has no entry in the ambient map.
		SetAmbientCtx(ctx)
		defer ClearAmbientCtx()

		Log("ChildInstallTag", "child goroutine with ambient install")
	}()
	<-done

	obj := readLastLine(t, dir)
	if got := obj["session_id"]; got != "child-sess-99" {
		t.Errorf("session_id = %v, want child-sess-99 (child goroutine ambient install missing?)", got)
	}
	if got := obj["conversation_id"]; got != "1783086029697-childinstall" {
		t.Errorf("conversation_id = %v, want 1783086029697-childinstall (child goroutine ambient install missing?)", got)
	}
}

// TestAmbientCtx_GoroutineIsolation verifies that different goroutines have
// isolated ambient contexts — one goroutine's SetAmbientCtx does not bleed
// into another goroutine's log lines.
func TestAmbientCtx_GoroutineIsolation(t *testing.T) {
	dir := t.TempDir()
	resetLoggerForTest(t, dir)

	// This goroutine has no ambient context.
	Log("main-goroutine", "no ambient here")
	obj := readLastLine(t, dir)
	if _, present := obj["session_id"]; present {
		t.Errorf("session_id leaked from another goroutine: %v", obj["session_id"])
	}

	// Spawn a goroutine with its own ambient context. Its SetAmbientCtx keys on
	// the goroutine ID, so it must not affect this goroutine's ambient state.
	done := make(chan struct{})
	go func() {
		defer close(done)
		ctx := WithSessionID(context.Background(), "goroutine-sess")
		SetAmbientCtx(ctx)
		defer ClearAmbientCtx()
		// This goroutine's plain Log would carry session_id; the isolation is
		// structural (sync.Map keyed by goroutine ID). We don't assert the file
		// from here to avoid interleaving with the main goroutine's writes.
	}()
	<-done

	// After the goroutine exits, this goroutine still has no ambient context.
	Log("main-goroutine-after", "still no ambient")
	obj2 := readLastLine(t, dir)
	if _, present := obj2["session_id"]; present {
		t.Errorf("session_id leaked from exited goroutine: %v", obj2["session_id"])
	}
}
