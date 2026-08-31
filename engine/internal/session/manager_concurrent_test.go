package session

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestConcurrent_StartStop(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	var wg sync.WaitGroup
	// Start 20 sessions concurrently
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			key := fmt.Sprintf("concurrent-%d", idx)
			_, _ = mgr.StartSession(key, defaultConfig())
		}(i)
	}
	wg.Wait()

	sessions := mgr.ListSessions()
	if len(sessions) != 20 {
		t.Fatalf("expected 20 sessions, got %d", len(sessions))
	}

	// Stop all concurrently
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			key := fmt.Sprintf("concurrent-%d", idx)
			_ = mgr.StopSession(key)
		}(i)
	}
	wg.Wait()

	if len(mgr.ListSessions()) != 0 {
		t.Error("expected 0 sessions after concurrent stop")
	}
}

func TestConcurrent_SimultaneousPrompts(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	// Start multiple sessions and send prompts concurrently
	for i := 0; i < 10; i++ {
		key := fmt.Sprintf("par-%d", i)
		_, _ = mgr.StartSession(key, defaultConfig())
	}

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			key := fmt.Sprintf("par-%d", idx)
			_ = mgr.SendPrompt(key, fmt.Sprintf("prompt-%d", idx), nil)
		}(i)
	}
	wg.Wait()

	keys := mb.startedKeys()
	if len(keys) != 10 {
		t.Errorf("expected 10 runs, got %d", len(keys))
	}
}

func TestConcurrent_ListDuringMutation(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	var wg sync.WaitGroup
	// Continuously list sessions while starting/stopping
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func(idx int) {
			defer wg.Done()
			key := fmt.Sprintf("mut-%d", idx)
			_, _ = mgr.StartSession(key, defaultConfig())
			time.Sleep(time.Millisecond)
			_ = mgr.StopSession(key)
		}(i)
		go func() {
			defer wg.Done()
			_ = mgr.ListSessions()
		}()
	}
	wg.Wait()
}

func TestConcurrent_EventEmissionDuringStop(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("race", defaultConfig())
	_ = mgr.SendPrompt("race", "go", nil)

	keys := mb.startedKeys()
	if len(keys) == 0 {
		t.Fatal("no runs started")
	}

	var wg sync.WaitGroup
	// Emit events while stopping
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 10; i++ {
			mb.emitNormalized(keys[0], types.NormalizedEvent{
				Data: &types.TextChunkEvent{Text: fmt.Sprintf("chunk-%d", i)},
			})
		}
	}()
	go func() {
		defer wg.Done()
		time.Sleep(time.Millisecond)
		_ = mgr.StopSession("race")
	}()
	wg.Wait()

	// Should not panic; event count is non-deterministic due to race
	_ = ec.count()
}

// ---------------------------------------------------------------------------
// ForkSession tests (unit-level -- no real conversation on disk)
// ---------------------------------------------------------------------------

func TestForkSession_UnknownSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, err := mgr.ForkSession("nonexistent", 0)
	if err == nil {
		t.Fatal("expected error for unknown session")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found' in error, got %q", err.Error())
	}
}

func TestForkSession_NoConversation(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("no-conv", defaultConfig())

	_, err := mgr.ForkSession("no-conv", 0)
	if err == nil {
		t.Fatal("expected error for session with no conversation")
	}
	if !strings.Contains(err.Error(), "no conversation") {
		t.Errorf("expected 'no conversation' in error, got %q", err.Error())
	}
}

func TestForkSessionToKey_CreatesIndependentDurableConversation(t *testing.T) {
	mgr := NewManager(newMockBackend())
	const sourceKey = "fork-source"
	if _, err := mgr.StartSession(sourceKey, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.RLock()
	sourceID := mgr.sessions[sourceKey].conversationID
	mgr.mu.RUnlock()

	source := conversation.CreateConversation(sourceID, "system", "test-model")
	conversation.AddUserMessage(source, "first")
	conversation.AddAssistantMessage(source, []types.LlmContentBlock{{Type: "text", Text: "answer"}}, types.LlmUsage{})
	conversation.AddUserMessage(source, "second")
	if err := conversation.Save(source, ""); err != nil {
		t.Fatalf("save source: %v", err)
	}

	newKey, forkID, err := mgr.ForkSessionToKey(sourceKey, "fork-target", 1)
	if err != nil {
		t.Fatalf("ForkSessionToKey: %v", err)
	}
	if newKey != "fork-target" || forkID == "" || forkID == sourceID {
		t.Fatalf("fork identity = (%q, %q), source = %q", newKey, forkID, sourceID)
	}
	forked, err := conversation.Load(forkID, "")
	if err != nil {
		t.Fatalf("load fork: %v", err)
	}
	if len(forked.Messages) != 2 {
		t.Fatalf("fork messages = %d, want 2", len(forked.Messages))
	}
	loadedSource, err := conversation.Load(sourceID, "")
	if err != nil {
		t.Fatalf("reload source: %v", err)
	}
	if len(loadedSource.Messages) != 3 {
		t.Fatalf("source messages = %d, want 3", len(loadedSource.Messages))
	}
	mgr.mu.RLock()
	created := mgr.sessions[newKey]
	mgr.mu.RUnlock()
	if created == nil || created.conversationID != forkID {
		t.Fatalf("forked live session missing or bound to wrong conversation")
	}
}

func TestForkSessionBeforeUserTurn_ExactAndOrdinalTargets(t *testing.T) {
	mgr := NewManager(newMockBackend())
	defer mgr.Shutdown()
	if _, err := mgr.StartSession("fork-before-source", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.RLock()
	sourceID := mgr.sessions["fork-before-source"].conversationID
	mgr.mu.RUnlock()
	source := conversation.CreateConversation(sourceID, "system", "test-model")
	conversation.AddUserMessage(source, "first")
	conversation.AddAssistantMessage(source, []types.LlmContentBlock{{Type: "text", Text: "answer"}}, types.LlmUsage{})
	target := conversation.AddUserMessage(source, "second")
	if err := conversation.Save(source, ""); err != nil {
		t.Fatalf("save source: %v", err)
	}

	for _, test := range []struct {
		name    string
		key     string
		entryID string
		ordinal int
	}{
		{name: "exact", key: "fork-before-exact", entryID: target.ID, ordinal: 99},
		{name: "ordinal", key: "fork-before-ordinal", ordinal: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, forkID, err := mgr.ForkSessionBeforeUserTurn("fork-before-source", test.key, test.entryID, test.ordinal)
			if err != nil {
				t.Fatalf("ForkSessionBeforeUserTurn: %v", err)
			}
			forked, err := conversation.Load(forkID, "")
			if err != nil {
				t.Fatalf("load fork: %v", err)
			}
			if len(forked.Messages) != 2 {
				t.Fatalf("fork messages = %d, want 2", len(forked.Messages))
			}
		})
	}
}

func TestForkSessionBeforeUserTurn_RejectsInvalidTargetWithoutArtifacts(t *testing.T) {
	mgr := NewManager(newMockBackend())
	defer mgr.Shutdown()
	if _, err := mgr.StartSession("fork-invalid-source", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.RLock()
	sourceID := mgr.sessions["fork-invalid-source"].conversationID
	mgr.mu.RUnlock()
	source := conversation.CreateConversation(sourceID, "system", "test-model")
	conversation.AddUserMessage(source, "first")
	conversation.AddAssistantMessage(source, []types.LlmContentBlock{{Type: "text", Text: "answer"}}, types.LlmUsage{})
	assistantID := source.Entries[1].ID
	if err := conversation.Save(source, ""); err != nil {
		t.Fatalf("save source: %v", err)
	}
	before, err := conversation.ListStored("", 100000)
	if err != nil {
		t.Fatalf("list before: %v", err)
	}

	for i, entryID := range []string{"stale-entry", assistantID} {
		key := fmt.Sprintf("fork-invalid-%d", i)
		if _, _, err := mgr.ForkSessionBeforeUserTurn("fork-invalid-source", key, entryID, 0); err == nil {
			t.Fatalf("target %q unexpectedly accepted", entryID)
		}
		mgr.mu.RLock()
		_, exists := mgr.sessions[key]
		_, reserved := mgr.forkReservations[key]
		mgr.mu.RUnlock()
		if exists || reserved {
			t.Fatalf("rejected target retained session=%t reservation=%t", exists, reserved)
		}
	}
	after, err := conversation.ListStored("", 100000)
	if err != nil {
		t.Fatalf("list after: %v", err)
	}
	if len(after) != len(before) {
		t.Fatalf("rejected targets changed stored conversations: before=%d after=%d", len(before), len(after))
	}
}

func TestForkSessionToKey_ConcurrentReservationPreventsOrphan(t *testing.T) {
	mgr := NewManager(newMockBackend())
	defer mgr.Shutdown()
	for _, key := range []string{"fork-race-a", "fork-race-b"} {
		if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
			t.Fatalf("StartSession(%s): %v", key, err)
		}
		mgr.mu.RLock()
		sourceID := mgr.sessions[key].conversationID
		mgr.mu.RUnlock()
		source := conversation.CreateConversation(sourceID, "system", "test-model")
		conversation.AddUserMessage(source, key)
		if err := conversation.Save(source, ""); err != nil {
			t.Fatalf("save source: %v", err)
		}
	}
	before, err := conversation.ListStored("", 100000)
	if err != nil {
		t.Fatalf("list before: %v", err)
	}

	type result struct {
		id  string
		err error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for _, sourceKey := range []string{"fork-race-a", "fork-race-b"} {
		go func(key string) {
			<-start
			_, id, err := mgr.ForkSessionToKey(key, "fork-race-target", 0)
			results <- result{id: id, err: err}
		}(sourceKey)
	}
	close(start)
	first, second := <-results, <-results
	successes := 0
	for _, got := range []result{first, second} {
		if got.err == nil {
			successes++
		} else if !strings.Contains(got.err.Error(), "already exists") {
			t.Fatalf("losing fork error = %v", got.err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful forks = %d, want 1", successes)
	}
	after, err := conversation.ListStored("", 100000)
	if err != nil {
		t.Fatalf("list after: %v", err)
	}
	if len(after) != len(before)+1 {
		t.Fatalf("stored conversations grew by %d, want 1", len(after)-len(before))
	}
	mgr.mu.RLock()
	_, reserved := mgr.forkReservations["fork-race-target"]
	mgr.mu.RUnlock()
	if reserved {
		t.Fatal("successful fork left a reservation behind")
	}
}

func TestBranchSession_UnknownSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.BranchSession("nonexistent", "entry-1")
	if err == nil {
		t.Fatal("expected error for unknown session")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found', got %q", err.Error())
	}
}

func TestBranchSession_NoConversation(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("no-conv-branch", defaultConfig())

	err := mgr.BranchSession("no-conv-branch", "entry-1")
	if err == nil {
		t.Fatal("expected error for session with no conversation")
	}
	if !strings.Contains(err.Error(), "no conversation") {
		t.Errorf("expected 'no conversation', got %q", err.Error())
	}
}

// ---------------------------------------------------------------------------
// NavigateSession tests (unit-level)
// ---------------------------------------------------------------------------

func TestNavigateSession_UnknownSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.NavigateSession("nonexistent", "target-1")
	if err == nil {
		t.Fatal("expected error for unknown session")
	}
}

func TestNavigateSession_NoConversation(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("no-conv-nav", defaultConfig())

	err := mgr.NavigateSession("no-conv-nav", "target-1")
	if err == nil {
		t.Fatal("expected error for session with no conversation")
	}
	if !strings.Contains(err.Error(), "no conversation") {
		t.Errorf("expected 'no conversation', got %q", err.Error())
	}
}

// ---------------------------------------------------------------------------
// GetSessionTree tests (unit-level)
// ---------------------------------------------------------------------------

func TestGetSessionTree_UnknownSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	tree := mgr.GetSessionTree("nonexistent")
	if tree != nil {
		t.Error("expected nil for unknown session")
	}
}

func TestGetSessionTree_NoConversation(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("no-conv-tree", defaultConfig())

	tree := mgr.GetSessionTree("no-conv-tree")
	if tree != nil {
		t.Error("expected nil for session with no conversation")
	}
}

// ---------------------------------------------------------------------------
// SendDialogResponse + SendCommand (placeholder coverage)
// ---------------------------------------------------------------------------

func TestSendDialogResponse_NoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("dlg", defaultConfig())

	// Should not panic even though not yet wired
	mgr.SendDialogResponse("dlg", "dialog-1", "yes")
	mgr.SendDialogResponse("nonexistent", "dialog-2", "no")
}

func TestSendCommand_NoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("cmd", defaultConfig())

	mgr.SendCommand("cmd", "reload", "")
	mgr.SendCommand("nonexistent", "reload", "")
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

func TestNewManager_RegistersCallbacks(t *testing.T) {
	mb := newMockBackend()
	_ = NewManager(mb)

	mb.mu.Lock()
	hasNorm := mb.onNorm != nil
	hasExit := mb.onExitF != nil
	hasErr := mb.onErrF != nil
	mb.mu.Unlock()

	if !hasNorm {
		t.Error("expected OnNormalized callback to be registered")
	}
	if !hasExit {
		t.Error("expected OnExit callback to be registered")
	}
	if !hasErr {
		t.Error("expected OnError callback to be registered")
	}
}

func TestEmit_NoCallbackNoPanic(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	// Deliberately not setting OnEvent
	mgr.emit("key", types.EngineEvent{Type: "test"})
}

func TestDerefInt(t *testing.T) {
	if derefInt(nil) != 0 {
		t.Error("derefInt(nil) should be 0")
	}
	v := 42
	if derefInt(&v) != 42 {
		t.Errorf("derefInt(&42) should be 42, got %d", derefInt(&v))
	}
}

func TestKeyForRun_NotFound(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("s", defaultConfig())

	key := mgr.keyForRun("nonexistent-run")
	if key != "" {
		t.Errorf("expected empty key for unknown run, got %q", key)
	}
}

func TestKeyForRun_MatchesCorrectSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, _ = mgr.StartSession("s1", defaultConfig())
	_, _ = mgr.StartSession("s2", defaultConfig())
	_ = mgr.SendPrompt("s1", "go1", nil)
	_ = mgr.SendPrompt("s2", "go2", nil)

	keys := mb.startedKeys()
	for _, k := range keys {
		sessionKey := mgr.keyForRun(k)
		if sessionKey == "" {
			t.Errorf("keyForRun(%q) returned empty", k)
		}
		// The request ID starts with the session key
		if !strings.HasPrefix(k, sessionKey+"-") {
			t.Errorf("run %q does not match session %q", k, sessionKey)
		}
	}
}

func TestStopSession_AllowsRestart(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, _ = mgr.StartSession("restart", defaultConfig())
	_ = mgr.StopSession("restart")

	// Should be able to start again with the same key
	_, err := mgr.StartSession("restart", defaultConfig())
	if err != nil {
		t.Fatalf("expected restart to succeed, got %v", err)
	}

	sessions := mgr.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session after restart, got %d", len(sessions))
	}
}

func TestSendPrompt_AfterRunExit_CanSendAgain(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, _ = mgr.StartSession("reuse", defaultConfig())
	_ = mgr.SendPrompt("reuse", "first", nil)

	keys := mb.startedKeys()
	code := 0
	mb.emitExit(keys[0], &code, nil, "session-1")

	if mgr.IsRunning("reuse") {
		t.Fatal("session should not be running after exit")
	}

	// Sleep to ensure different timestamp for request ID
	time.Sleep(time.Millisecond)

	// Now should be able to send another prompt
	err := mgr.SendPrompt("reuse", "second", nil)
	if err != nil {
		t.Fatalf("expected second prompt to succeed, got %v", err)
	}

	if !mgr.IsRunning("reuse") {
		t.Error("session should be running after second prompt")
	}

	allKeys := mb.startedKeys()
	if len(allKeys) < 2 {
		t.Errorf("expected at least 2 runs total, got %d", len(allKeys))
	}
}

func TestStopByPrefix_EmptyPrefix(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, _ = mgr.StartSession("a", defaultConfig())
	_, _ = mgr.StartSession("b", defaultConfig())

	// Empty prefix matches everything
	mgr.StopByPrefix("")

	if len(mgr.ListSessions()) != 0 {
		t.Error("empty prefix should match all sessions")
	}
}

func TestSetPlanMode_Toggle(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("toggle", defaultConfig())

	// Enable
	mgr.SetPlanMode("toggle", true, []string{"Read"}, "", "")
	// Disable
	mgr.SetPlanMode("toggle", false, nil, "", "")
	// Re-enable with different tools
	mgr.SetPlanMode("toggle", true, []string{"Grep", "Glob", "Read"}, "", "")

	_ = mgr.SendPrompt("toggle", "go", nil)

	keys := mb.startedKeys()
	opts, _ := mb.getStarted(keys[0])
	if !opts.PlanMode {
		t.Error("expected PlanMode=true")
	}
	if len(opts.PlanModeTools) != 3 {
		t.Errorf("expected 3 tools, got %d", len(opts.PlanModeTools))
	}
}
