//go:build integration

// Integration test proving that background extension execution re-wires to a
// session AFTER a Stop/Start resume cycle — the engine-side guarantee behind
// the desktop's eager-restore work (a reopened conversation is immediately
// background-job capable, not a sessionless shell).
//
// Shape: a real Manager loads the async-canary via StartSession; we capture the
// session's conversationId, StopSession, then StartSession AGAIN on the same key
// with that conversationId in config (resume), and assert the canary's async
// declarations (engine_webhook_registered / engine_schedule_registered) route
// to the RESUMED session key — i.e. the extension host was re-wired and is live
// on the reopened session, not merely that an async fired once.

package integration

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
)

// asyncEventRecorder collects engine_*_registered events per session key with
// a mutex (the manager fans events from multiple goroutines).
type asyncEventRecorder struct {
	mu      sync.Mutex
	entries []asyncEntry
}

type asyncEntry struct {
	key string
	ev  types.EngineEvent
}

func (r *asyncEventRecorder) record(key string, ev types.EngineEvent) {
	r.mu.Lock()
	r.entries = append(r.entries, asyncEntry{key, ev})
	r.mu.Unlock()
}

// awaitRegistered waits until both the webhook and schedule registrations for
// the canary have arrived on `wantKey` (registered SINCE `sinceIdx`), or the
// deadline elapses. Returns whether both were seen on the wanted key.
func (r *asyncEventRecorder) awaitRegistered(wantKey string, sinceIdx int, timeout time.Duration) (bool, bool) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var sawWebhook, sawSchedule bool
		r.mu.Lock()
		for i := sinceIdx; i < len(r.entries); i++ {
			e := r.entries[i]
			if e.key != wantKey {
				continue
			}
			if e.ev.Type == "engine_webhook_registered" && e.ev.AsyncID == "/test/hello" {
				sawWebhook = true
			}
			if e.ev.Type == "engine_schedule_registered" && e.ev.AsyncID == "async-canary-tick" {
				sawSchedule = true
			}
		}
		r.mu.Unlock()
		if sawWebhook && sawSchedule {
			return true, true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false, false
}

func (r *asyncEventRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.entries)
}

// TestAsyncCanaryRewiresOnResumedSession proves background extension execution
// is live on a session that was stopped and resumed under the same key with the
// same conversationId.
func TestAsyncCanaryRewiresOnResumedSession(t *testing.T) {
	requireEsbuild(t)
	t.Setenv("ASYNC_CANARY_TOKEN", "x")

	mgr := session.NewManager(&nullBackend{})
	mgr.SetConfig(&types.EngineRuntimeConfig{
		Webhooks: &types.WebhooksConfig{Port: 0, BindInterface: "127.0.0.1"},
	})
	t.Cleanup(mgr.Shutdown)

	rec := &asyncEventRecorder{}
	mgr.OnEvent(rec.record)

	const key = "async-resume"
	cfg := types.EngineConfig{
		ProfileID:        "test",
		WorkingDirectory: t.TempDir(),
		Extensions:       []string{asyncCanaryEntry(t)},
	}

	// First start: the canary registers its async declarations.
	res1, err := mgr.StartSession(key, cfg)
	if err != nil {
		t.Fatalf("StartSession #1: %v", err)
	}
	convID := res1.ConversationID

	okW, okS := rec.awaitRegistered(key, 0, 5*time.Second)
	if !okW || !okS {
		t.Fatalf("first start: canary async declarations did not register on %q (webhook=%v schedule=%v)", key, okW, okS)
	}
	t.Logf("first start: canary wired on %q conversationId=%q", key, convID)

	// Stop the session — tears down the extension host (the registrations from
	// the first start are no longer live).
	if err := mgr.StopSession(key); err != nil {
		t.Fatalf("StopSession: %v", err)
	}
	resumeFromIdx := rec.count()

	// Resume: same key, same conversationId in config (the eager-restore path).
	resumeCfg := cfg
	resumeCfg.SessionID = convID
	if _, err := mgr.StartSession(key, resumeCfg); err != nil {
		t.Fatalf("StartSession #2 (resume): %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	// The canary's async declarations must register AGAIN on the resumed
	// session — proving the extension host re-wired and background execution is
	// live on the reopened conversation, not just on the original start.
	okW2, okS2 := rec.awaitRegistered(key, resumeFromIdx, 5*time.Second)
	if !okW2 {
		t.Errorf("resume: engine_webhook_registered did not re-arrive on resumed session %q", key)
	}
	if !okS2 {
		t.Errorf("resume: engine_schedule_registered did not re-arrive on resumed session %q", key)
	}
	if okW2 && okS2 {
		t.Logf("resume: canary re-wired on resumed session %q — background execution live after Stop/Start", key)
	}
}
