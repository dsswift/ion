//go:build integration

package integration

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

// resumeEventCollector captures events emitted by the session manager.
type resumeEventCollector struct {
	mu     sync.Mutex
	events []types.EngineEvent
}

func newResumeEventCollector(mgr *session.Manager) *resumeEventCollector {
	ec := &resumeEventCollector{}
	mgr.OnEvent(func(key string, event types.EngineEvent) {
		ec.mu.Lock()
		ec.events = append(ec.events, event)
		ec.mu.Unlock()
	})
	return ec
}

func (ec *resumeEventCollector) all() []types.EngineEvent {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	out := make([]types.EngineEvent, len(ec.events))
	copy(out, ec.events)
	return out
}

func (ec *resumeEventCollector) byType(t string) []types.EngineEvent {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	var out []types.EngineEvent
	for _, e := range ec.events {
		if e.Type == t {
			out = append(out, e)
		}
	}
	return out
}

// ─── Test 1: ConversationID from config flows through to RunOptions ───

func TestStartSessionWithSessionID(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	config := defaultConfig()
	config.SessionID = "existing-conv"

	if _, err := mgr.StartSession("resume-1", config); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("resume-1") })

	if err := mgr.SendPrompt("resume-1", "continue where we left off", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	keys := mb.StartedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}

	opts, ok := mb.GetStarted(keys[0])
	if !ok {
		t.Fatal("started run not found")
	}
	if opts.ConversationID != "existing-conv" {
		t.Errorf("expected ConversationID='existing-conv', got %q", opts.ConversationID)
	}
}

// ─── Test 2: backend-reported sessionID resumes via CliResumeSessionID ───
//
// Corrected two-identity-space contract: the backend-reported sessionID
// (claude's native UUID for the CLI backend) does NOT replace Ion's
// pre-minted conversation-file id (RunOptions.ConversationID). Instead it is
// captured into cliSessionID and fed to the next run via
// RunOptions.CliResumeSessionID — the only value the CLI backend passes to
// `claude --resume`. Ion's ConversationID stays stable across prompts so every
// Ion subsystem keyed on the conversation-file id keeps resolving the right
// files. (Previously this test asserted the defective behavior of
// overwriting ConversationID with the backend value.)
func TestSessionIDPersistsAcrossPrompts(t *testing.T) {
	mb := helpers.NewMockBackend()
	// The resume-vs-bridge contract under test is native-session behavior:
	// cursor capture on exit and CliResumeSessionID threading at dispatch
	// only engage when the serving backend reports a native-session,
	// resume-capable descriptor (see resolveCliContinuity / handleRunExit).
	mb.Caps = &backend.BackendCapabilities{
		Kind:         "mock-cli",
		ContextModel: backend.ContextModelNativeSession,
		PlanMode:     true,
		Steering:     true,
		Resume:       true,
	}
	mgr := session.NewManager(mb)

	ec := newResumeEventCollector(mgr)

	// Unique session key per run: this test captures a native-session cursor
	// which persistence writes into the real conversation store (keyed by the
	// session-key binding). A static key would rehydrate the previous run's
	// cursor at StartSession and the first prompt would resume instead of
	// starting fresh — making the test fail on every second local run.
	key := "resume-2-" + time.Now().Format("20060102150405.000000000")

	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) })

	// First prompt.
	if err := mgr.SendPrompt(key, "first message", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	keys := mb.StartedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}
	firstRunID := keys[0]

	// First run carries the pre-minted conversation ID (assigned at session
	// start since the conversationId-on-context feature) and no resume id
	// yet (no claude UUID has been captured).
	opts1, _ := mb.GetStarted(firstRunID)
	if opts1.ConversationID == "" {
		t.Errorf("expected pre-minted ConversationID on first run, got empty")
	}
	if opts1.CliResumeSessionID != "" {
		t.Errorf("first run must omit CliResumeSessionID (no captured UUID), got %q", opts1.CliResumeSessionID)
	}
	preMinted := opts1.ConversationID

	// Simulate exit with a sessionID returned by the backend (claude UUID).
	mb.EmitExit(firstRunID, nil, nil, "conv-abc")
	time.Sleep(100 * time.Millisecond)

	// Verify we got an idle status (run completed) and that it reports Ion's
	// stable conversation id, not the backend-provided value.
	idleEvents := ec.byType("engine_status")
	foundIdle := false
	for _, e := range idleEvents {
		if e.Fields != nil && e.Fields.State == "idle" {
			foundIdle = true
			if e.Fields.SessionID != preMinted {
				t.Errorf("idle status SessionID = %q, want Ion id %q (not backend value 'conv-abc')", e.Fields.SessionID, preMinted)
			}
			break
		}
	}
	if !foundIdle {
		t.Fatal("expected engine_status with state=idle after first run exit")
	}

	// Second prompt: ConversationID stays the Ion id; the backend-provided value
	// flows through CliResumeSessionID for --resume.
	if err := mgr.SendPrompt(key, "second message", nil); err != nil {
		t.Fatalf("SendPrompt (second): %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	keys = mb.StartedKeys()
	if len(keys) != 2 {
		t.Fatalf("expected 2 started runs, got %d", len(keys))
	}

	// Find the second run (the one that isn't firstRunID).
	var secondRunID string
	for _, k := range keys {
		if k != firstRunID {
			secondRunID = k
			break
		}
	}
	if secondRunID == "" {
		t.Fatal("could not find second run ID")
	}

	opts2, ok := mb.GetStarted(secondRunID)
	if !ok {
		t.Fatal("second started run not found")
	}
	if opts2.ConversationID != preMinted {
		t.Errorf("second run ConversationID = %q, want stable Ion id %q", opts2.ConversationID, preMinted)
	}
	if opts2.CliResumeSessionID != "conv-abc" {
		t.Errorf("second run CliResumeSessionID = %q, want backend-provided 'conv-abc'", opts2.CliResumeSessionID)
	}
}

// ─── Test 3: Normal exit (nil code, nil signal) emits idle but NOT engine_dead ───

func TestEngineDeadCodeZeroNoDeadEvent(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	ec := newResumeEventCollector(mgr)

	if _, err := mgr.StartSession("resume-3", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("resume-3") })

	if err := mgr.SendPrompt("resume-3", "do something", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	keys := mb.StartedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}

	// Normal completion: code=nil, signal=nil.
	mb.EmitExit(keys[0], nil, nil, "")
	time.Sleep(100 * time.Millisecond)

	// Should NOT have engine_dead.
	deadEvents := ec.byType("engine_dead")
	if len(deadEvents) != 0 {
		t.Errorf("expected no engine_dead event for normal exit (nil code/signal), got %d", len(deadEvents))
	}

	// Should have engine_status with state=idle.
	statusEvents := ec.byType("engine_status")
	foundIdle := false
	for _, e := range statusEvents {
		if e.Fields != nil && e.Fields.State == "idle" {
			foundIdle = true
			break
		}
	}
	if !foundIdle {
		t.Error("expected engine_status with state=idle after normal exit")
	}
}

// ─── Test 4: Non-zero exit code emits engine_dead ───

func TestEngineDeadNonZeroEmitsDeadEvent(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	ec := newResumeEventCollector(mgr)

	if _, err := mgr.StartSession("resume-4", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("resume-4") })

	if err := mgr.SendPrompt("resume-4", "do something", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	keys := mb.StartedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 started run, got %d", len(keys))
	}

	// Non-zero exit.
	exitCode := 1
	mb.EmitExit(keys[0], &exitCode, nil, "")
	time.Sleep(100 * time.Millisecond)

	// Should have engine_dead with exitCode=1.
	deadEvents := ec.byType("engine_dead")
	if len(deadEvents) == 0 {
		t.Fatal("expected engine_dead event for non-zero exit code")
	}
	if deadEvents[0].ExitCode == nil {
		t.Fatal("expected engine_dead event to have non-nil ExitCode")
	}
	if *deadEvents[0].ExitCode != 1 {
		t.Errorf("expected exitCode=1, got %d", *deadEvents[0].ExitCode)
	}
}
