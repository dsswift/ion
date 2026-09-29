//go:build integration

package integration

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
)

// e2eRecordingProvider mirrors recordingAuthProvider (concurrent_principal_
// credentials_test.go) but records the raw Authorization/X-Api-Key header
// value the outbound request carried, so this test can assert the exact
// token the stand-in client answered with reached the request.
type e2eRecordingProvider struct {
	id string

	mu      sync.Mutex
	headers []string
}

func (p *e2eRecordingProvider) ID() string { return p.id }

func (p *e2eRecordingProvider) CountTokens(context.Context, providers.CountTokensRequest) (int, error) {
	return 0, providers.ErrCountUnsupported
}

func (p *e2eRecordingProvider) Stream(ctx context.Context, _ types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 4)
	errc := make(chan error, 1)

	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://example.invalid/v1/messages", nil) //nolint:errcheck // test fixture
	a, ok := providers.RequestCredentialFrom(ctx)
	header := ""
	if ok && a != nil {
		if err := a.Authenticate(ctx, req, nil); err == nil {
			header = req.Header.Get("Authorization")
		}
	}
	p.mu.Lock()
	p.headers = append(p.headers, header)
	p.mu.Unlock()

	go func() {
		defer close(events)
		defer close(errc)
		events <- types.LlmStreamEvent{
			Type:         "content_block_start",
			ContentBlock: &types.LlmStreamContentBlock{Type: "text", Text: ""},
		}
		events <- types.LlmStreamEvent{
			Type:  "content_block_delta",
			Delta: &types.LlmStreamDelta{Type: "text_delta", Text: "ok"},
		}
		stop := "end_turn"
		events <- types.LlmStreamEvent{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: &stop}}
	}()

	return events, errc
}

func (p *e2eRecordingProvider) recorded() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]string, len(p.headers))
	copy(out, p.headers)
	return out
}

// TestPrincipalSourceEndToEnd is acceptance criterion 6 for FR-05 child 09:
// the engine resolves a per-principal credential end to end ACROSS THE
// PROCESS BOUNDARY the spec describes -- the engine raises
// engine_credential_request, a stand-in client answers credential_response,
// and the run authenticates with exactly that answer. This is the real
// wire round trip (session.Manager.OnEvent observing the event,
// HandleCredentialResponse answering it), not a direct call into the
// resolution function.
func TestPrincipalSourceEndToEnd(t *testing.T) {
	providers.ResetRegistries()
	t.Cleanup(providers.ResetRegistries)
	auth.UnregisterAllPrincipalSourcesForTest()
	t.Cleanup(auth.UnregisterAllPrincipalSourcesForTest)
	t.Setenv("HOME", t.TempDir())

	rp := &e2eRecordingProvider{id: "mock"}
	providers.RegisterProvider(rp)
	providers.RegisterModel("mock-model", types.ModelInfo{ProviderID: "mock", ContextWindow: 200000})

	b := backend.NewApiBackend()
	b.SetAuthResolver(auth.NewResolver(nil))
	mgr := session.NewManager(b)
	mgr.RegisterClientCredentialSource()

	// The stand-in client: watches for engine_credential_request and
	// answers with a fixed token the moment it sees one for "alice".
	answered := make(chan struct{}, 1)
	// runFinished closes when the session goes running -> idle. The run keeps
	// persisting its conversation under the temp HOME after the provider has
	// seen the request, so the test must not return (and let t.TempDir clean
	// up) until the run has actually finished.
	runFinished := make(chan struct{})
	var runningSeen atomic.Bool
	var finishOnce sync.Once
	mgr.OnEvent(func(key string, ev types.EngineEvent) {
		if ev.Type == "engine_status" && ev.Fields != nil {
			switch ev.Fields.State {
			case "running":
				runningSeen.Store(true)
			case "idle":
				if runningSeen.Load() {
					finishOnce.Do(func() { close(runFinished) })
				}
			}
			return
		}
		if ev.Type != "engine_credential_request" {
			return
		}
		if ev.CredentialSubject != "alice" || ev.CredentialAxis != "provider" || ev.CredentialProvider != "mock" {
			t.Errorf("unexpected credential request: subject=%q axis=%q provider=%q", ev.CredentialSubject, ev.CredentialAxis, ev.CredentialProvider)
			return
		}
		mgr.HandleCredentialResponse(key, ev.CredentialRequestID, true, "e2e-token-alice", "bearer")
		select {
		case answered <- struct{}{}:
		default:
		}
	})

	principal := &types.SessionPrincipal{Subject: "alice"}
	if _, err := mgr.StartSession("e2e-session", types.EngineConfig{ProfileID: "test", WorkingDirectory: "/tmp"}, principal); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("e2e-session") }) //nolint:errcheck // test cleanup

	if err := mgr.SendPrompt("e2e-session", "hello", &session.PromptOverrides{Model: "mock-model"}); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	select {
	case <-answered:
	case <-time.After(5 * time.Second):
		t.Fatal("engine never asked the client for alice's credential")
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		headers := rp.recorded()
		if len(headers) > 0 {
			if headers[0] != "Bearer e2e-token-alice" {
				t.Fatalf("outbound request Authorization = %q, want %q", headers[0], "Bearer e2e-token-alice")
			}
			select {
			case <-runFinished:
			case <-time.After(5 * time.Second):
				t.Fatal("run never returned to idle after reaching the provider")
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("run never reached the provider (recorded %d headers)", len(headers))
		}
		time.Sleep(20 * time.Millisecond)
	}
}
