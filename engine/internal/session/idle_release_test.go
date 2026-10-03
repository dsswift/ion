package session

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// idleReleaseManager returns a manager with a quiet heartbeat goroutine, so
// the tests drive emitHeartbeatTick themselves.
func idleReleaseManager(t *testing.T, workspace *types.WorkspaceConfig) *Manager {
	t.Helper()
	mgr := NewManager(newMockBackend())
	t.Cleanup(mgr.Shutdown)
	mgr.SetHeartbeatInterval(time.Hour)
	mgr.SetConfig(&types.EngineRuntimeConfig{Workspace: workspace})
	return mgr
}

func hasSession(mgr *Manager, key string) bool {
	mgr.mu.RLock()
	defer mgr.mu.RUnlock()
	_, ok := mgr.sessions[key]
	return ok
}

// backdateQuiescence makes the session look quiescent for d already.
func backdateQuiescence(mgr *Manager, key string, d time.Duration) {
	mgr.mu.Lock()
	mgr.sessions[key].quiescentSince = time.Now().Add(-d)
	mgr.mu.Unlock()
}

type releaseRecorder struct {
	mu      sync.Mutex
	reasons map[string]string
}

func recordReleases(mgr *Manager) *releaseRecorder {
	r := &releaseRecorder{reasons: map[string]string{}}
	mgr.OnSessionReleased(func(key, reason string) {
		r.mu.Lock()
		r.reasons[key] = reason
		r.mu.Unlock()
	})
	return r
}

func (r *releaseRecorder) reason(key string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reasons[key]
}

func TestIdleRelease_ReleasesSessionQuiescentPastLimit(t *testing.T) {
	mgr := idleReleaseManager(t, &types.WorkspaceConfig{SessionIdleReleaseMs: 60_000})
	releases := recordReleases(mgr)
	_, _ = mgr.StartSession("idle-a", defaultConfig())

	// Terminal agent records are the retained state the release exists to
	// drop; they must not count as work.
	mgr.mu.RLock()
	s := mgr.sessions["idle-a"]
	mgr.mu.RUnlock()
	s.agents.AppendOrUpdateByID(types.AgentStateUpdate{Name: "worker", ID: "d1", Status: "done"}, func(*types.AgentStateUpdate) {})
	s.agents.AppendOrUpdateByID(types.AgentStateUpdate{Name: "worker", ID: "d2", Status: "cancelled"}, func(*types.AgentStateUpdate) {})

	// First tick starts the clock; the session is younger than the limit.
	mgr.emitHeartbeatTick()
	if !hasSession(mgr, "idle-a") {
		t.Fatal("session released before the limit elapsed")
	}

	backdateQuiescence(mgr, "idle-a", 2*time.Minute)
	statuses := newCaptureEngineStatus()
	var dead int
	mgr.OnEvent(func(key string, ev types.EngineEvent) {
		statuses.handler()(key, ev)
		if key == "idle-a" && ev.Type == "engine_dead" {
			dead++
		}
	})
	mgr.emitHeartbeatTick()

	if hasSession(mgr, "idle-a") {
		t.Fatal("session quiescent past the limit was not released")
	}
	if got := releases.reason("idle-a"); got != extension.SessionReleaseReasonIdleTimeout {
		t.Errorf("release reason = %q, want %q", got, extension.SessionReleaseReasonIdleTimeout)
	}
	if dead != 1 {
		t.Errorf("engine_dead emissions = %d, want 1", dead)
	}
	if got := statuses.countFor("idle-a"); got != 0 {
		t.Errorf("released session still got %d heartbeat status emission(s)", got)
	}
}

func TestIdleRelease_WorkBlocksAndResetsClock(t *testing.T) {
	cases := map[string]func(mgr *Manager, s *engineSession){
		"running agent": func(_ *Manager, s *engineSession) {
			s.agents.AppendOrUpdateByID(types.AgentStateUpdate{Name: "worker", ID: "d1", Status: "running"}, func(*types.AgentStateUpdate) {})
		},
		"active run": func(mgr *Manager, s *engineSession) {
			mgr.mu.Lock()
			s.requestID, s.dispatchingRunID = "run-1", "run-1"
			mgr.mu.Unlock()
		},
		"queued prompt": func(mgr *Manager, s *engineSession) {
			mgr.mu.Lock()
			s.promptQueue = append(s.promptQueue, pendingPrompt{})
			mgr.mu.Unlock()
		},
		"settled": func(mgr *Manager, s *engineSession) {
			mgr.mu.Lock()
			s.settled = true
			mgr.mu.Unlock()
		},
	}
	for name, makeBusy := range cases {
		t.Run(name, func(t *testing.T) {
			mgr := idleReleaseManager(t, &types.WorkspaceConfig{SessionIdleReleaseMs: 60_000})
			_, _ = mgr.StartSession("busy", defaultConfig())
			mgr.emitHeartbeatTick()
			backdateQuiescence(mgr, "busy", 2*time.Minute)

			mgr.mu.RLock()
			s := mgr.sessions["busy"]
			mgr.mu.RUnlock()
			makeBusy(mgr, s)
			mgr.emitHeartbeatTick()

			if !hasSession(mgr, "busy") {
				t.Fatal("session with work was released")
			}
			mgr.mu.RLock()
			since := s.quiescentSince
			mgr.mu.RUnlock()
			if !since.IsZero() {
				t.Errorf("idle clock not reset by work: quiescentSince = %v", since)
			}
		})
	}
}

func TestIdleRelease_TimedReleaseDisabled(t *testing.T) {
	mgr := idleReleaseManager(t, &types.WorkspaceConfig{SessionIdleReleaseMs: -1})
	_, _ = mgr.StartSession("kept", defaultConfig())
	mgr.emitHeartbeatTick()
	backdateQuiescence(mgr, "kept", 24*time.Hour)
	mgr.emitHeartbeatTick()
	if !hasSession(mgr, "kept") {
		t.Fatal("session released with timed release disabled")
	}
}

// hookedGroup returns a group whose session_before_release handler records
// its payload and answers keep.
func hookedGroup(keep bool, got *extension.SessionReleaseInfo) *extension.ExtensionGroup {
	host := extension.NewHost()
	host.SDK().On(extension.HookSessionBeforeRelease, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		if info, ok := payload.(extension.SessionReleaseInfo); ok {
			*got = info
		}
		return keep, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)
	return group
}

func TestIdleRelease_HookKeepsSessionAndRestartsClock(t *testing.T) {
	mgr := idleReleaseManager(t, &types.WorkspaceConfig{SessionIdleReleaseMs: 60_000})
	_, _ = mgr.StartSession("vetoed", defaultConfig())
	var got extension.SessionReleaseInfo
	mgr.mu.Lock()
	s := mgr.sessions["vetoed"]
	s.extGroup = hookedGroup(true, &got)
	mgr.mu.Unlock()

	mgr.emitHeartbeatTick()
	backdateQuiescence(mgr, "vetoed", 2*time.Minute)
	mgr.emitHeartbeatTick()

	if !hasSession(mgr, "vetoed") {
		t.Fatal("session released despite a session_before_release keep")
	}
	if got.Reason != extension.SessionReleaseReasonIdleTimeout || got.IdleMs < 60_000 {
		t.Errorf("hook payload = %+v, want reason idle_timeout and idleMs past the limit", got)
	}
	mgr.mu.RLock()
	idle := time.Since(s.quiescentSince)
	mgr.mu.RUnlock()
	if idle > 30*time.Second {
		t.Errorf("idle clock not restarted after keep: %v", idle)
	}
}

func TestIdleRelease_HookAbstainReleases(t *testing.T) {
	mgr := idleReleaseManager(t, &types.WorkspaceConfig{SessionIdleReleaseMs: 60_000})
	_, _ = mgr.StartSession("abstain", defaultConfig())
	var got extension.SessionReleaseInfo
	mgr.mu.Lock()
	mgr.sessions["abstain"].extGroup = hookedGroup(false, &got)
	mgr.mu.Unlock()

	mgr.emitHeartbeatTick()
	backdateQuiescence(mgr, "abstain", 2*time.Minute)
	mgr.emitHeartbeatTick()

	if hasSession(mgr, "abstain") {
		t.Fatal("session kept though the hook did not ask to keep it")
	}
}

func TestAbortOrRelease(t *testing.T) {
	busy := func(mgr *Manager, key string) {
		mgr.mu.Lock()
		mgr.sessions[key].promptQueue = append(mgr.sessions[key].promptQueue, pendingPrompt{})
		mgr.mu.Unlock()
	}
	cases := []struct {
		name      string
		workspace *types.WorkspaceConfig
		scope     AbortScope
		prepare   func(mgr *Manager, key string)
		released  bool
	}{
		{name: "idle session, scope all", scope: AbortScopeAll, released: true},
		{name: "idle session, scope all_work", scope: AbortScopeAllWork, released: true},
		{name: "idle session, timed release disabled", workspace: &types.WorkspaceConfig{SessionIdleReleaseMs: -1}, scope: AbortScopeAll, released: true},
		{name: "idle session, scope orchestrator", scope: AbortScopeOrchestrator},
		{name: "idle session, onAbort off", workspace: &types.WorkspaceConfig{ReleaseIdleSessionOnAbort: boolPtr(false)}, scope: AbortScopeAll},
		{name: "session with work", scope: AbortScopeAll, prepare: busy},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mgr := idleReleaseManager(t, tc.workspace)
			releases := recordReleases(mgr)
			_, _ = mgr.StartSession("ab", defaultConfig())
			if tc.prepare != nil {
				tc.prepare(mgr, "ab")
			}

			got := mgr.AbortOrRelease("ab", tc.scope)

			if got != tc.released {
				t.Errorf("AbortOrRelease = %v, want %v", got, tc.released)
			}
			if hasSession(mgr, "ab") == tc.released {
				t.Errorf("session resident = %v, want %v", !tc.released, !tc.released)
			}
			wantReason := ""
			if tc.released {
				wantReason = extension.SessionReleaseReasonIdleAbort
			}
			if reason := releases.reason("ab"); reason != wantReason {
				t.Errorf("release reason = %q, want %q", reason, wantReason)
			}
		})
	}
}

// An abort from inside an extension (ctx.abort) reaches SendAbort, which must
// never tear down the calling extension's own session.
func TestSendAbort_IdleSessionIsRetained(t *testing.T) {
	mgr := idleReleaseManager(t, nil)
	_, _ = mgr.StartSession("ext-abort", defaultConfig())
	mgr.SendAbort("ext-abort")
	if !hasSession(mgr, "ext-abort") {
		t.Fatal("SendAbort released an idle session")
	}
}

func TestAbortOrRelease_UnknownSession(t *testing.T) {
	mgr := idleReleaseManager(t, nil)
	if mgr.AbortOrRelease("nope", AbortScopeAll) {
		t.Fatal("AbortOrRelease reported a release for an unknown session")
	}
}

func TestStopSessionGuarded_RefusalLeavesSession(t *testing.T) {
	mgr := idleReleaseManager(t, nil)
	_, _ = mgr.StartSession("guarded", defaultConfig())

	err := mgr.stopSessionGuarded("guarded", func(*engineSession) string { return "busy" })
	if !errors.Is(err, errStopGuardRefused) {
		t.Fatalf("err = %v, want errStopGuardRefused", err)
	}
	if !hasSession(mgr, "guarded") {
		t.Fatal("refused stop removed the session")
	}
	if err := mgr.stopSessionGuarded("guarded", func(*engineSession) string { return "" }); err != nil {
		t.Fatalf("permitted stop failed: %v", err)
	}
	if hasSession(mgr, "guarded") {
		t.Fatal("permitted stop left the session")
	}
}
