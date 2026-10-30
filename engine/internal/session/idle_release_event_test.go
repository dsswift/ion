package session

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

type releasedEventRecorder struct {
	mu     sync.Mutex
	events []types.EngineEvent
}

func recordReleasedEvents(mgr *Manager, key string) *releasedEventRecorder {
	r := &releasedEventRecorder{}
	mgr.OnEvent(func(k string, ev types.EngineEvent) {
		if k != key || ev.Type != "engine_session_released" {
			return
		}
		r.mu.Lock()
		r.events = append(r.events, ev)
		r.mu.Unlock()
	})
	return r
}

func (r *releasedEventRecorder) all() []types.EngineEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]types.EngineEvent(nil), r.events...)
}

func conversationOf(mgr *Manager, key string) string {
	mgr.mu.RLock()
	defer mgr.mu.RUnlock()
	return mgr.sessions[key].conversationID
}

// A client holding the key hears of an engine-initiated release only through
// engine_session_released, so every release path must emit it exactly once.
func TestIdleRelease_EmitsSessionReleased(t *testing.T) {
	t.Run("timed", func(t *testing.T) {
		mgr := idleReleaseManager(t, &types.WorkspaceConfig{SessionIdleReleaseMs: 60_000})
		_, _ = mgr.StartSession("rel-t", defaultConfig())
		convID := conversationOf(mgr, "rel-t")
		mgr.emitHeartbeatTick()
		backdateQuiescence(mgr, "rel-t", 2*time.Minute)
		events := recordReleasedEvents(mgr, "rel-t")

		mgr.emitHeartbeatTick()

		assertReleasedEvent(t, events.all(), extension.SessionReleaseReasonIdleTimeout, convID)
	})
	t.Run("abort", func(t *testing.T) {
		mgr := idleReleaseManager(t, nil)
		_, _ = mgr.StartSession("rel-a", defaultConfig())
		convID := conversationOf(mgr, "rel-a")
		events := recordReleasedEvents(mgr, "rel-a")

		if !mgr.AbortOrRelease("rel-a", AbortScopeAll) {
			t.Fatal("idle session was not released by abort")
		}

		assertReleasedEvent(t, events.all(), extension.SessionReleaseReasonIdleAbort, convID)
	})
	t.Run("with work", func(t *testing.T) {
		mgr := idleReleaseManager(t, &types.WorkspaceConfig{SessionIdleReleaseMs: 60_000})
		_, _ = mgr.StartSession("rel-k", defaultConfig())
		mgr.emitHeartbeatTick()
		backdateQuiescence(mgr, "rel-k", 2*time.Minute)
		mgr.mu.Lock()
		mgr.sessions["rel-k"].promptQueue = append(mgr.sessions["rel-k"].promptQueue, pendingPrompt{})
		mgr.mu.Unlock()
		events := recordReleasedEvents(mgr, "rel-k")

		mgr.emitHeartbeatTick()

		if n := len(events.all()); n != 0 {
			t.Fatalf("session with work emitted %d engine_session_released event(s), want 0", n)
		}
	})
}

// stop_session is the client's own act; it never reports a release.
func TestStopSession_EmitsNoSessionReleased(t *testing.T) {
	mgr := idleReleaseManager(t, nil)
	_, _ = mgr.StartSession("rel-s", defaultConfig())
	events := recordReleasedEvents(mgr, "rel-s")

	if err := mgr.StopSession("rel-s"); err != nil {
		t.Fatal(err)
	}

	if n := len(events.all()); n != 0 {
		t.Fatalf("stop_session emitted %d engine_session_released event(s), want 0", n)
	}
}

func assertReleasedEvent(t *testing.T, events []types.EngineEvent, reason, convID string) {
	t.Helper()
	if len(events) != 1 {
		t.Fatalf("engine_session_released emissions = %d, want 1", len(events))
	}
	if got := events[0].SessionReleaseReason; got != reason {
		t.Errorf("sessionReleaseReason = %q, want %q", got, reason)
	}
	if got := events[0].SessionReleaseConversationID; got != convID || got == "" {
		t.Errorf("sessionReleaseConversationId = %q, want %q", got, convID)
	}
}

// Clients read these fields off the engine wire; pin their JSON names.
func TestTranslate_SessionReleased(t *testing.T) {
	ev := translateToEngineEvent(types.NormalizedEvent{Data: &types.SessionReleasedEvent{Reason: "idle_timeout", ConversationID: "c-1"}}, 0)
	b, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"type":"engine_session_released"`, `"sessionReleaseReason":"idle_timeout"`, `"sessionReleaseConversationId":"c-1"`} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("missing %s in %s", want, b)
		}
	}
}
