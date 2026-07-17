package server

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/cliprobe"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
)

// loginTestServer builds a minimal Server with a captured broadcast stream and
// an injected login/logout driver.
func loginTestServer(t *testing.T, login cliprobe.LoginFunc, logout cliprobe.LogoutFunc) (*Server, <-chan types.EngineEvent) {
	t.Helper()
	s := &Server{
		clients: make(map[net.Conn]*clientWriter),
		done:    make(chan struct{}),
		config:  &types.EngineRuntimeConfig{Providers: map[string]types.ProviderConfig{"openai": {Backend: "codex"}}},
		probes:  cliprobe.NewRegistry(),
	}
	s.probes.SetProbeFunc(func(kind string) cliprobe.Probe { return cliprobe.Probe{Kind: kind} })
	s.SetLoginFuncs(login, logout)

	events := make(chan types.EngineEvent, 16)
	s.OnBroadcast(func(line string) {
		var wrapper struct {
			Event json.RawMessage `json:"event"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(line)), &wrapper) != nil {
			return
		}
		var evt types.EngineEvent
		if json.Unmarshal(wrapper.Event, &evt) == nil && (evt.Type == types.EventProviderLogin || evt.Type == types.EventProvidersUpdated) {
			select {
			case events <- evt:
			default:
			}
		}
	})
	t.Cleanup(func() { close(s.done) })
	return s, events
}

func collectStages(t *testing.T, events <-chan types.EngineEvent, want int) []string {
	t.Helper()
	var stages []string
	deadline := time.After(2 * time.Second)
	for len(stages) < want {
		select {
		case e := <-events:
			if e.ProviderLogin != nil {
				stages = append(stages, e.ProviderLogin.Stage)
			}
		case <-deadline:
			t.Fatalf("timed out; got stages %v", stages)
		}
	}
	return stages
}

func TestDispatchProviderLogin_StageSequence(t *testing.T) {
	login := func(_ context.Context, kind string, emit cliprobe.LoginEmit) error {
		if kind != "codex" {
			t.Errorf("expected codex kind, got %q", kind)
		}
		emit(cliprobe.LoginStage{Stage: "started"})
		emit(cliprobe.LoginStage{Stage: "await_browser", AuthURL: "https://auth/x"})
		emit(cliprobe.LoginStage{Stage: "completed"})
		return nil
	}
	s, events := loginTestServer(t, login, nil)
	s.dispatchProviderLogin(nil, &protocol.ClientCommand{Cmd: "provider_login", Provider: "openai"})

	stages := collectStages(t, events, 3)
	if stages[0] != "started" || stages[1] != "await_browser" || stages[2] != "completed" {
		t.Fatalf("unexpected stage sequence: %v", stages)
	}
}

func TestDispatchProviderLogin_UnknownProvider(t *testing.T) {
	called := false
	login := func(context.Context, string, cliprobe.LoginEmit) error { called = true; return nil }
	s, _ := loginTestServer(t, login, nil)
	// "google" has no delegated CLI → the login driver must not be invoked.
	s.dispatchProviderLogin(nil, &protocol.ClientCommand{Cmd: "provider_login", Provider: "google"})
	time.Sleep(30 * time.Millisecond)
	if called {
		t.Fatal("login driver invoked for a provider with no CLI backend")
	}
}

func TestDispatchProviderLogin_Cancel(t *testing.T) {
	var mu sync.Mutex
	var sawCancel bool
	login := func(ctx context.Context, _ string, emit cliprobe.LoginEmit) error {
		emit(cliprobe.LoginStage{Stage: "started"})
		<-ctx.Done() // block until cancelled
		mu.Lock()
		sawCancel = true
		mu.Unlock()
		emit(cliprobe.LoginStage{Stage: "cancelled"})
		return ctx.Err()
	}
	s, events := loginTestServer(t, login, nil)
	s.dispatchProviderLogin(nil, &protocol.ClientCommand{Cmd: "provider_login", Provider: "openai"})
	// Wait for the started stage, then cancel.
	_ = collectStages(t, events, 1)
	s.dispatchProviderLoginCancel(nil, &protocol.ClientCommand{Cmd: "provider_login_cancel", Provider: "openai"})

	deadline := time.After(2 * time.Second)
	for {
		mu.Lock()
		done := sawCancel
		mu.Unlock()
		if done {
			return
		}
		select {
		case <-deadline:
			t.Fatal("login was not cancelled")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestDispatchProviderLogout_Invoked(t *testing.T) {
	done := make(chan string, 1)
	logout := func(_ context.Context, kind string) error { done <- kind; return nil }
	s, _ := loginTestServer(t, nil, logout)
	s.dispatchProviderLogout(nil, &protocol.ClientCommand{Cmd: "provider_logout", Provider: "openai"})
	select {
	case kind := <-done:
		if kind != "codex" {
			t.Fatalf("expected logout for codex, got %q", kind)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("logout driver not invoked")
	}
}

// TestDispatchProviderLogout_BroadcastsProvidersUpdated pins the fix for the
// "Sign out does nothing" defect: a completed logout must emit the advisory
// engine_providers_updated event (via the RefreshProviderProbes sequenced after
// the logout driver) so consumers re-query and the UI reflects the signed-out
// state. Without the broadcast this test fails.
func TestDispatchProviderLogout_BroadcastsProvidersUpdated(t *testing.T) {
	logout := func(context.Context, string) error { return nil }
	s, events := loginTestServer(t, nil, logout)
	s.dispatchProviderLogout(nil, &protocol.ClientCommand{Cmd: "provider_logout", Provider: "openai"})

	deadline := time.After(2 * time.Second)
	for {
		select {
		case e := <-events:
			if e.Type == types.EventProvidersUpdated {
				return
			}
		case <-deadline:
			t.Fatal("no engine_providers_updated broadcast after logout")
		}
	}
}

// TestDispatchProviderLogout_BoundsDriverContext pins the hang backstop: the
// logout driver must receive a context carrying a deadline, so a wedged CLI can
// never block the RefreshProviderProbes refresh sequenced after it. Removing the
// dispatch-level timeout wrapper fails this test.
func TestDispatchProviderLogout_BoundsDriverContext(t *testing.T) {
	gotDeadline := make(chan bool, 1)
	logout := func(ctx context.Context, _ string) error {
		_, ok := ctx.Deadline()
		gotDeadline <- ok
		return nil
	}
	s, _ := loginTestServer(t, nil, logout)
	s.dispatchProviderLogout(nil, &protocol.ClientCommand{Cmd: "provider_logout", Provider: "openai"})
	select {
	case ok := <-gotDeadline:
		if !ok {
			t.Fatal("logout driver received a context with no deadline; a wedged CLI would hang the refresh")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("logout driver not invoked")
	}
}

func TestCliprobeLogin_UnsupportedKind(t *testing.T) {
	err := cliprobe.Login(context.Background(), "nope", func(cliprobe.LoginStage) {})
	if err == nil || !strings.Contains(err.Error(), "not supported") {
		t.Fatalf("expected unsupported-kind error, got %v", err)
	}
}
