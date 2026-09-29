//go:build integration

package integration

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// recordingAuthProvider is a minimal LlmProvider stub that inspects the
// RequestAuthenticator observed on ctx for every Stream call, instead of
// asserting on a fixed scripted response like helpers.MockProvider. This is
// the load-bearing assertion for R-27/R-03/R-10: what actually reached the
// outbound request, not what options were passed in. recordAuth (set per
// test) extracts whatever signal that test cares about from the applied
// request.
type recordingAuthProvider struct {
	id string

	mu      sync.Mutex
	results []string // one entry per Stream call, as recordAuth reports it

	// recordAuth inspects the authenticated request (and whether an
	// authenticator was present at all) and returns the value to append to
	// results.
	recordAuth func(hadAuthenticator bool, req *http.Request) string
}

func (p *recordingAuthProvider) ID() string { return p.id }

func (p *recordingAuthProvider) CountTokens(context.Context, providers.CountTokensRequest) (int, error) {
	return 0, providers.ErrCountUnsupported
}

func (p *recordingAuthProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 4)
	errc := make(chan error, 1)

	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://example.invalid/v1/messages", nil) //nolint:errcheck // test fixture
	a, ok := providers.RequestCredentialFrom(ctx)
	if ok && a != nil {
		_ = a.Authenticate(ctx, req, nil) //nolint:errcheck // test authenticators never fail
	}
	result := p.recordAuth(ok && a != nil, req)
	p.mu.Lock()
	p.results = append(p.results, result)
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

func (p *recordingAuthProvider) recorded() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]string, len(p.results))
	copy(out, p.results)
	return out
}

// testHeaderAuthenticator stamps a fixed value onto X-Test-Auth so a test
// can identify which principal's authenticator produced a given request,
// without touching real credential material.
type testHeaderAuthenticator struct{ value string }

func (a testHeaderAuthenticator) Authenticate(_ context.Context, req *http.Request, _ []byte) error {
	req.Header.Set("X-Test-Auth", a.value)
	return nil
}

// stubPrincipalSource is a minimal auth.PrincipalCredentialSource for tests
// in this package.
type stubPrincipalSource struct {
	name    string
	resolve func(context.Context, auth.CredentialScope) (auth.RequestAuthenticator, error)
}

func (s stubPrincipalSource) Name() string { return s.name }
func (s stubPrincipalSource) Resolve(ctx context.Context, scope auth.CredentialScope) (auth.RequestAuthenticator, error) {
	return s.resolve(ctx, scope)
}

// TestConcurrentPrincipalCredentialIsolation is the program's motivating
// regression test (R-27). It fails at 1815d4438 because providerKeys is one
// entry per provider for the whole process: two principals racing
// concurrent turns against the same provider id last-writer-wins into a
// single shared credential, so one principal's request can carry another's.
// After child 03, each run's CredentialContext carries its OWN authenticator
// attached to that run's own request context, so no cross-principal
// crossing is possible regardless of scheduling.
func TestConcurrentPrincipalCredentialIsolation(t *testing.T) {
	providers.ResetRegistries()
	t.Cleanup(func() { providers.ResetRegistries() })
	auth.UnregisterAllPrincipalSourcesForTest()
	t.Cleanup(func() { auth.UnregisterAllPrincipalSourcesForTest() })

	rp := &recordingAuthProvider{
		id: "mock",
		recordAuth: func(_ bool, req *http.Request) string {
			return req.Header.Get("X-Test-Auth")
		},
	}
	providers.RegisterProvider(rp)
	providers.RegisterModel("mock-model", types.ModelInfo{ProviderID: "mock", ContextWindow: 200000})

	// A stand-in principal source: alice's requests authenticate with
	// "key-alice", bob's with "key-bob". This is the seam child 09 fills in
	// production (the client-asking source); a test source proves the
	// resolution mechanism identically.
	auth.RegisterPrincipalSource(stubPrincipalSource{
		name: "test",
		resolve: func(_ context.Context, scope auth.CredentialScope) (auth.RequestAuthenticator, error) {
			switch scope.Subject {
			case "alice":
				return testHeaderAuthenticator{value: "key-alice"}, nil
			case "bob":
				return testHeaderAuthenticator{value: "key-bob"}, nil
			default:
				return nil, nil
			}
		},
	})

	t.Setenv("HOME", t.TempDir())

	const turnsPerPrincipal = 8
	var wg sync.WaitGroup
	runTurns := func(subject string) {
		defer wg.Done()
		b := backend.NewApiBackend()
		principal := &types.SessionPrincipal{Subject: subject}
		cc := auth.NewCredentialContext(principal, auth.NewResolver(nil), nil)
		for i := 0; i < turnsPerPrincipal; i++ {
			done := make(chan struct{})
			b.OnExit(func(string, *int, *string, string) { close(done) })
			b.StartRunWithConfig(fmt.Sprintf("run-%s-%d", subject, i), types.RunOptions{
				Prompt:         "hi",
				Model:          "mock-model",
				ConversationID: fmt.Sprintf("conv-%s-%d", subject, i),
			}, &backend.RunConfig{CredentialContext: cc})
			select {
			case <-done:
			case <-time.After(mockRunExitTimeout):
				t.Errorf("%s turn %d: timed out waiting for exit", subject, i)
				return
			}
		}
	}

	wg.Add(2)
	go runTurns("alice")
	go runTurns("bob")
	wg.Wait()

	results := rp.recorded()
	if len(results) != 2*turnsPerPrincipal {
		t.Fatalf("expected %d recorded requests, got %d", 2*turnsPerPrincipal, len(results))
	}
	aliceCount, bobCount, crossed := 0, 0, 0
	for _, h := range results {
		switch h {
		case "key-alice":
			aliceCount++
		case "key-bob":
			bobCount++
		default:
			crossed++
		}
	}
	if crossed != 0 {
		t.Errorf("expected zero crossings, got %d requests with an unexpected credential", crossed)
	}
	if aliceCount != turnsPerPrincipal || bobCount != turnsPerPrincipal {
		t.Errorf("expected %d requests each, got alice=%d bob=%d", turnsPerPrincipal, aliceCount, bobCount)
	}
}

// TestUnattributedRunUsesResolverLevels pins R-10: with no principal, no
// registered sources, and a programmatically-set key, the outbound request
// still authenticates -- through auth.Resolver's levels -- exactly as the
// pre-existing single-user path did, and never carries a principal-source
// credential.
func TestUnattributedRunUsesResolverLevels(t *testing.T) {
	providers.ResetRegistries()
	t.Cleanup(func() { providers.ResetRegistries() })
	auth.UnregisterAllPrincipalSourcesForTest()
	t.Cleanup(func() { auth.UnregisterAllPrincipalSourcesForTest() })

	rp := &recordingAuthProvider{
		id: "mock",
		recordAuth: func(had bool, req *http.Request) string {
			if !had {
				return "none"
			}
			if v := req.Header.Get("X-Test-Auth"); v != "" {
				return v
			}
			return req.Header.Get("Authorization")
		},
	}
	providers.RegisterProvider(rp)
	providers.RegisterModel("mock-model", types.ModelInfo{ProviderID: "mock", ContextWindow: 200000})

	t.Setenv("HOME", t.TempDir())

	resolver := auth.NewResolver(nil)
	resolver.SetProgrammatic("mock", "unattributed-key")

	b := backend.NewApiBackend()
	b.SetAuthResolver(resolver)
	done := make(chan struct{})
	b.OnExit(func(string, *int, *string, string) { close(done) })

	b.StartRunWithConfig("run-unattributed", types.RunOptions{
		Prompt:         "hi",
		Model:          "mock-model",
		ConversationID: "conv-unattributed",
	}, nil) // no CredentialContext: exercises the defensive-fallback path (b's own resolver)

	select {
	case <-done:
	case <-time.After(mockRunExitTimeout):
		t.Fatal("timed out waiting for exit")
	}

	results := rp.recorded()
	if len(results) != 1 {
		t.Fatalf("expected 1 recorded request, got %d", len(results))
	}
	if results[0] == "none" {
		t.Fatal("expected the unattributed run to still authenticate via the resolver's programmatic level")
	}
	if results[0] == "key-alice" || results[0] == "key-bob" {
		t.Errorf("unattributed run must never carry a principal-source credential, got %q", results[0])
	}
	if results[0] != "Bearer unattributed-key" {
		t.Errorf("expected the resolver's programmatic key as a bearer token, got %q", results[0])
	}
}

// TestBakedInKeyNoLongerOutranksPrincipal pins R-03: a principal source
// registered alongside a would-be engine.json-configured key must win. Since
// providers no longer hold any baked-in key field (R-23), there is nothing
// left for a config-supplied key to outrank the principal WITH -- this test
// proves the principal source's authenticator reaches the request even when
// the process-wide resolver ALSO has a programmatic key configured for the
// same provider.
func TestBakedInKeyNoLongerOutranksPrincipal(t *testing.T) {
	providers.ResetRegistries()
	t.Cleanup(func() { providers.ResetRegistries() })
	auth.UnregisterAllPrincipalSourcesForTest()
	t.Cleanup(func() { auth.UnregisterAllPrincipalSourcesForTest() })

	rp := &recordingAuthProvider{
		id: "mock",
		recordAuth: func(_ bool, req *http.Request) string {
			return req.Header.Get("X-Test-Auth")
		},
	}
	providers.RegisterProvider(rp)
	providers.RegisterModel("mock-model", types.ModelInfo{ProviderID: "mock", ContextWindow: 200000})

	auth.RegisterPrincipalSource(stubPrincipalSource{
		name: "test",
		resolve: func(_ context.Context, scope auth.CredentialScope) (auth.RequestAuthenticator, error) {
			if scope.Subject == "alice" {
				return testHeaderAuthenticator{value: "key-alice"}, nil
			}
			return nil, nil
		},
	})

	t.Setenv("HOME", t.TempDir())

	// A configured "baked-in" key on the resolver -- the equivalent of
	// engine.json's providers.mock.apiKey, which ApplyConfig used to bake
	// into the provider singleton before this program deleted p.apiKey.
	resolver := auth.NewResolver(nil)
	resolver.SetProgrammatic("mock", "engine-json-key")

	b := backend.NewApiBackend()
	principal := &types.SessionPrincipal{Subject: "alice"}
	cc := auth.NewCredentialContext(principal, resolver, nil)
	done := make(chan struct{})
	b.OnExit(func(string, *int, *string, string) { close(done) })

	b.StartRunWithConfig("run-baked-in", types.RunOptions{
		Prompt:         "hi",
		Model:          "mock-model",
		ConversationID: "conv-baked-in",
	}, &backend.RunConfig{CredentialContext: cc})

	select {
	case <-done:
	case <-time.After(mockRunExitTimeout):
		t.Fatal("timed out waiting for exit")
	}

	results := rp.recorded()
	if len(results) != 1 {
		t.Fatalf("expected 1 recorded request, got %d", len(results))
	}
	if results[0] != "key-alice" {
		t.Errorf("expected alice's principal-source credential to win over the configured key, got %q", results[0])
	}
}
