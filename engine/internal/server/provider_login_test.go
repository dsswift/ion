package server

import (
	"context"
	"encoding/json"
	"errors"
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
	shutdownCtx, shutdownCancel := context.WithCancel(context.Background())
	s := &Server{
		clients:        make(map[net.Conn]*clientWriter),
		done:           make(chan struct{}),
		shutdownCtx:    shutdownCtx,
		shutdownCancel: shutdownCancel,
		config:         &types.EngineRuntimeConfig{Providers: map[string]types.ProviderConfig{"openai": {Backend: "codex"}}},
		probes:         cliprobe.NewRegistry(),
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
	// Wait for every login goroutine spawned by this Server to drain from the
	// package-level activeLogins/pendingCodes maps before returning. The
	// dispatchProviderLogin goroutine's defer clears its own entry, but that
	// happens asynchronously after ctx cancellation via close(s.done). Under
	// `go test -race -count=N` a returning cleanup left goroutines racing to
	// delete entries — a late deletion from iteration N would clobber the
	// entry iteration N+1 just wrote, and N+1's dispatchProviderLoginCode
	// would then find no pendingCodes[provider] and skip delivery.
	//
	// t.Cleanup is LIFO: register the map-drain wait FIRST so it runs LAST,
	// AFTER the close(s.done) registered next cancels the goroutines. That
	// gives every goroutine the chance to exit and clear its own entry before
	// the next test iteration begins.
	t.Cleanup(func() {
		deadline := time.Now().Add(2 * time.Second)
		for {
			loginMu.Lock()
			empty := len(activeLogins) == 0 && len(pendingCodes) == 0
			if empty || time.Now().After(deadline) {
				// On timeout, force-clear so the next test starts clean. A
				// hung goroutine would still be a bug worth surfacing, but
				// leaving stale entries silently would cascade the failure
				// into unrelated tests.
				for p := range activeLogins {
					delete(activeLogins, p)
				}
				for p := range pendingCodes {
					delete(pendingCodes, p)
				}
				loginMu.Unlock()
				return
			}
			loginMu.Unlock()
			time.Sleep(2 * time.Millisecond)
		}
	})
	t.Cleanup(func() {
		shutdownCancel()
		close(s.done)
	})
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

// A driver that fails WITHOUT emitting a terminal stage previously left every
// consumer parked on a login that had already ended — the inert "Sign in with
// Claude Code" button. The dispatch layer must always emit a terminal stage.
// Red on the unfixed dispatcher, which emitted nothing on the error path.
func TestDispatchProviderLogin_DriverErrorEmitsFailedStage(t *testing.T) {
	login := func(context.Context, string, cliprobe.LoginEmit) error {
		return errors.New("login not supported for backend \"codex\"")
	}
	s, events := loginTestServer(t, login, nil)
	s.dispatchProviderLogin(nil, &protocol.ClientCommand{Cmd: "provider_login", Provider: "openai"})

	stages := collectStages(t, events, 1)
	if stages[0] != types.ProviderLoginFailed {
		t.Fatalf("expected a %q stage on driver error, got %v", types.ProviderLoginFailed, stages)
	}
}

// When the driver already emitted its own terminal stage, the dispatch guard
// must not emit a second one.
func TestDispatchProviderLogin_DriverErrorAfterTerminalStageDoesNotDuplicate(t *testing.T) {
	login := func(_ context.Context, _ string, emit cliprobe.LoginEmit) error {
		emit(cliprobe.LoginStage{Stage: types.ProviderLoginFailed, Error: "cli said no"})
		return errors.New("cli said no")
	}
	s, events := loginTestServer(t, login, nil)
	s.dispatchProviderLogin(nil, &protocol.ClientCommand{Cmd: "provider_login", Provider: "openai"})

	stages := collectStages(t, events, 1)
	if stages[0] != types.ProviderLoginFailed {
		t.Fatalf("expected failed stage, got %v", stages)
	}
	// No duplicate terminal stage should follow.
	select {
	case e := <-events:
		if e.ProviderLogin != nil && e.ProviderLogin.Stage == types.ProviderLoginFailed {
			t.Fatal("dispatch emitted a duplicate failed stage")
		}
	case <-time.After(150 * time.Millisecond):
	}
}

// The await_auth_code → provider_login_code → completed path: a login that parks
// waiting for a browser-issued code receives it from a subsequent command.
func TestDispatchProviderLoginCode_DeliversCodeToWaitingLogin(t *testing.T) {
	gotCode := make(chan string, 1)
	login := func(ctx context.Context, _ string, emit cliprobe.LoginEmit) error {
		emit(cliprobe.LoginStage{Stage: types.ProviderLoginStarted})
		emit(cliprobe.LoginStage{Stage: types.ProviderLoginAwaitBrowser, AuthURL: "https://claude.com/cai/oauth/authorize?x=1"})
		emit(cliprobe.LoginStage{Stage: types.ProviderLoginAwaitAuthCode})
		code, err := cliprobe.WaitForAuthCode(ctx)
		if err != nil {
			emit(cliprobe.LoginStage{Stage: types.ProviderLoginFailed, Error: err.Error()})
			return err
		}
		gotCode <- code
		emit(cliprobe.LoginStage{Stage: types.ProviderLoginCompleted})
		return nil
	}
	s, events := loginTestServer(t, login, nil)
	s.dispatchProviderLogin(nil, &protocol.ClientCommand{Cmd: "provider_login", Provider: "anthropic"})

	// Wait for the login to park on await_auth_code before supplying the code.
	stages := collectStages(t, events, 3)
	if stages[2] != types.ProviderLoginAwaitAuthCode {
		t.Fatalf("expected %q, got %v", types.ProviderLoginAwaitAuthCode, stages)
	}

	s.dispatchProviderLoginCode(nil, &protocol.ClientCommand{Cmd: "provider_login_code", Provider: "anthropic", Text: "abc123"})

	select {
	case code := <-gotCode:
		if code != "abc123" {
			t.Fatalf("driver received code %q, want abc123", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("driver never received the auth code")
	}

	final := collectStages(t, events, 1)
	if final[0] != types.ProviderLoginCompleted {
		t.Fatalf("expected completed stage, got %v", final)
	}
}

// Two logins parked on await_auth_code for DIFFERENT providers must each
// receive their own code. Red on a package-global supplier: the second login's
// registration overwrote the first, so the first provider's code was routed into
// the second's driver (and the second's cleanup stranded the first).
func TestDispatchProviderLoginCode_ConcurrentLoginsAreIsolated(t *testing.T) {
	type received struct {
		provider string
		code     string
	}
	got := make(chan received, 2)
	parked := make(chan string, 2)

	login := func(ctx context.Context, kind string, emit cliprobe.LoginEmit) error {
		// The provider is recoverable from the CLI kind for the two under test.
		provider := "anthropic"
		if kind == "codex" {
			provider = "openai"
		}
		emit(cliprobe.LoginStage{Stage: types.ProviderLoginAwaitAuthCode})
		parked <- provider
		code, err := cliprobe.WaitForAuthCode(ctx)
		if err != nil {
			return err
		}
		got <- received{provider: provider, code: code}
		emit(cliprobe.LoginStage{Stage: types.ProviderLoginCompleted})
		return nil
	}

	s, _ := loginTestServer(t, login, nil)
	s.dispatchProviderLogin(nil, &protocol.ClientCommand{Cmd: "provider_login", Provider: "anthropic"})
	s.dispatchProviderLogin(nil, &protocol.ClientCommand{Cmd: "provider_login", Provider: "openai"})

	// Both must be parked before any code is delivered.
	for i := 0; i < 2; i++ {
		select {
		case <-parked:
		case <-time.After(2 * time.Second):
			t.Fatal("both logins did not park on await_auth_code")
		}
	}

	s.dispatchProviderLoginCode(nil, &protocol.ClientCommand{Cmd: "provider_login_code", Provider: "anthropic", Text: "anthropic-code"})
	s.dispatchProviderLoginCode(nil, &protocol.ClientCommand{Cmd: "provider_login_code", Provider: "openai", Text: "openai-code"})

	want := map[string]string{"anthropic": "anthropic-code", "openai": "openai-code"}
	for i := 0; i < 2; i++ {
		select {
		case r := <-got:
			if want[r.provider] != r.code {
				t.Fatalf("provider %q received code %q, want %q", r.provider, r.code, want[r.provider])
			}
			delete(want, r.provider)
		case <-time.After(2 * time.Second):
			t.Fatalf("a parked login never received its code; still waiting on %v", want)
		}
	}
	if len(want) != 0 {
		t.Fatalf("providers never received a code: %v", want)
	}
}

// A driver that reaches await_auth_code with no channel on its context must fail
// rather than block forever.
func TestCliprobeWaitForAuthCode_NoChannel(t *testing.T) {
	_, err := cliprobe.WaitForAuthCode(context.Background())
	if err == nil {
		t.Fatal("expected an error when the context carries no auth-code channel")
	}
}

// A code for a provider with no in-flight login is rejected rather than dropped.
func TestDispatchProviderLoginCode_NoInFlightLogin(t *testing.T) {
	s, _ := loginTestServer(t, nil, nil)

	// A real pipe conn captures the RPC result the dispatcher writes back.
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	done := make(chan protocol.ServerResult, 1)
	go func() {
		buf := make([]byte, 4096)
		n, err := client.Read(buf)
		if err != nil {
			return
		}
		var res protocol.ServerResult
		if json.Unmarshal([]byte(strings.TrimSpace(string(buf[:n]))), &res) == nil {
			done <- res
		}
	}()

	s.dispatchProviderLoginCode(server, &protocol.ClientCommand{
		Cmd: "provider_login_code", RequestID: "req-1", Provider: "anthropic", Text: "abc123",
	})

	select {
	case res := <-done:
		if res.OK {
			t.Fatal("expected failure for a provider with no in-flight login")
		}
		if !strings.Contains(res.Error, "no in-flight login") {
			t.Fatalf("expected a no-in-flight-login error, got %q", res.Error)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no result written for an unmatched auth code")
	}
}
