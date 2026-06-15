//go:build e2e

package e2e

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
)

// waitForIdleStatus subscribes for engine_status events and returns the
// sessionId carried on the first `idle` status the engine emits while `armed`
// is set. The engine emits an idle engine_status (with SessionID) on run exit
// (event_translation.go), which is the manager-level completion signal. The
// caller arms the gate immediately before SendPrompt so a pre-prompt idle does
// not falsely trigger.
type idleWaiter struct {
	mu        sync.Mutex
	armed     bool
	done      chan string
	fired     bool
}

func newIdleWaiter(mgr *session.Manager) *idleWaiter {
	w := &idleWaiter{done: make(chan string, 1)}
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type != "engine_status" || ev.Fields == nil {
			return
		}
		if ev.Fields.State != "idle" {
			return
		}
		w.mu.Lock()
		defer w.mu.Unlock()
		if w.armed && !w.fired {
			w.fired = true
			w.done <- ev.Fields.SessionID
		}
	})
	return w
}

func (w *idleWaiter) arm() {
	w.mu.Lock()
	w.armed = true
	w.fired = false
	w.mu.Unlock()
}

func (w *idleWaiter) wait(t *testing.T, timeout time.Duration) string {
	t.Helper()
	select {
	case sid := <-w.done:
		w.mu.Lock()
		w.armed = false
		w.mu.Unlock()
		return sid
	case <-time.After(timeout):
		t.Fatalf("timed out after %s waiting for idle engine_status", timeout)
		return ""
	}
}

// TestLiveSessionLifecycleStableConversationIDAcrossResume verifies that the
// engine assigns a STABLE conversationId to a session and PRESERVES it across a
// Stop/Start resume cycle when the same sessionId is supplied in config. This
// is the core guarantee the desktop's eager-restore relies on: reopening a
// persisted conversation resumes the same engine-side conversation identity
// rather than minting a new one.
func TestLiveSessionLifecycleStableConversationIDAcrossResume(t *testing.T) {
	model := setupAnthropicProvider(t)

	mgr := session.NewManager(backend.NewApiBackend())
	mgr.SetConfig(&types.EngineRuntimeConfig{DefaultModel: model})

	const key = "e2e-lifecycle-resume"
	cfg := types.EngineConfig{
		ProfileID:        "e2e-lifecycle",
		WorkingDirectory: t.TempDir(),
	}

	// First start: mint a fresh conversation.
	res1, err := mgr.StartSession(key, cfg)
	if err != nil {
		t.Fatalf("StartSession #1: %v", err)
	}
	convID := res1.ConversationID
	waiter := newIdleWaiter(mgr)

	// Submit a prompt so the conversation has content and a settled id.
	waiter.arm()
	if err := mgr.SendPrompt(key, "Reply with exactly: ALPHA", nil); err != nil {
		t.Fatalf("SendPrompt #1: %v", err)
	}
	sid1 := waiter.wait(t, 60*time.Second)
	if sid1 != "" {
		if convID == "" {
			convID = sid1
		} else if sid1 != convID {
			t.Fatalf("conversationId changed within a single session: start=%s idle=%s", convID, sid1)
		}
	}
	if convID == "" {
		t.Fatal("could not determine a conversationId from start or first prompt")
	}
	t.Logf("session %s established conversationId=%s", key, convID)

	// Stop the session (simulates the desktop closing the tab / app quit).
	if err := mgr.StopSession(key); err != nil {
		t.Fatalf("StopSession: %v", err)
	}

	// Resume: start the same key with the captured sessionId in config.
	resumeCfg := cfg
	resumeCfg.SessionID = convID
	res2, err := mgr.StartSession(key, resumeCfg)
	if err != nil {
		t.Fatalf("StartSession #2 (resume): %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) })
	if res2.ConversationID != "" && res2.ConversationID != convID {
		t.Fatalf("resume minted a NEW conversationId: resumed=%s want=%s", res2.ConversationID, convID)
	}

	// Submit a second prompt on the resumed session; its conversationId must
	// still be the original.
	waiter.arm()
	if err := mgr.SendPrompt(key, "Reply with exactly: BETA", nil); err != nil {
		t.Fatalf("SendPrompt #2: %v", err)
	}
	sid2 := waiter.wait(t, 60*time.Second)
	if sid2 != "" && sid2 != convID {
		t.Fatalf("resumed prompt used a different conversationId: got=%s want=%s", sid2, convID)
	}
	t.Logf("resume preserved conversationId=%s across Stop/Start", convID)
}

// TestLiveSessionLifecycleClearOnLiveSession verifies that `/clear` on a LIVE
// real session wipes the conversation's messages and clears retained denials,
// while preserving the conversation identity (clear is a checkpoint, not a
// session restart). Exercises dispatchClear → clearConversationCore end to end
// against a real backend.
func TestLiveSessionLifecycleClearOnLiveSession(t *testing.T) {
	model := setupAnthropicProvider(t)

	mgr := session.NewManager(backend.NewApiBackend())
	mgr.SetConfig(&types.EngineRuntimeConfig{DefaultModel: model})

	const key = "e2e-lifecycle-clear"
	cfg := types.EngineConfig{
		ProfileID:        "e2e-lifecycle",
		WorkingDirectory: t.TempDir(),
	}
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) })

	// Build conversation content.
	waiter := newIdleWaiter(mgr)
	waiter.arm()
	if err := mgr.SendPrompt(key, "Reply with exactly: GAMMA", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	convID := waiter.wait(t, 60*time.Second)
	if convID == "" {
		t.Fatal("no conversationId after first prompt")
	}

	home, _ := os.UserHomeDir()
	convDir := filepath.Join(home, ".ion", "conversations")

	// Pre-clear: the conversation's LLM-authoritative history (.llm.jsonl —
	// what the model actually saw) has messages, and the tree (.tree.jsonl —
	// the render/branch history) has entries.
	beforeConv, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("Load (pre-clear): %v", err)
	}
	if len(beforeConv.Messages) == 0 {
		t.Fatalf("expected conversation %s to have LLM messages before clear", convID)
	}
	treeEntriesBefore := len(beforeConv.Entries)
	t.Logf("pre-clear: conversation %s has %d LLM messages, %d tree entries", convID, len(beforeConv.Messages), treeEntriesBefore)

	// Capture the clear signal the engine emits (engine_command_result{clear}).
	clearSeen := make(chan struct{}, 1)
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_command_result" {
			clearSeen <- struct{}{}
		}
	})

	// Fire /clear on the LIVE session.
	mgr.SendCommand(key, "clear", "")

	select {
	case <-clearSeen:
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for engine_command_result after /clear")
	}

	// Post-clear contract (a checkpoint, NOT a delete):
	//   - the LLM-authoritative Messages are wiped (the model's context is
	//     reset — clearConversationCore sets conv.Messages = nil), AND
	//   - the conversation IDENTITY + the tree are PRESERVED (the .tree.jsonl
	//     entries remain so the prior turns are still renderable/branchable;
	//     clearConversationCore logs "entries preserved in tree").
	afterConv, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("Load (post-clear): %v", err)
	}
	if len(afterConv.Messages) != 0 {
		var roles []string
		for _, m := range afterConv.Messages {
			roles = append(roles, m.Role)
		}
		t.Fatalf("expected LLM Messages wiped after /clear, conversation %s still has %d (roles=%s)", convID, len(afterConv.Messages), strings.Join(roles, ","))
	}
	if len(afterConv.Entries) != treeEntriesBefore {
		t.Fatalf("/clear must PRESERVE the tree: entries changed %d → %d for %s", treeEntriesBefore, len(afterConv.Entries), convID)
	}
	t.Logf("post-clear: conversation %s LLM Messages wiped (0), tree preserved (%d entries), identity intact", convID, len(afterConv.Entries))
}
