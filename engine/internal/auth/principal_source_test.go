package auth

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"regexp"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
)

// stubSource is a minimal PrincipalCredentialSource for tests below.
type stubSource struct {
	name    string
	resolve func(ctx context.Context, scope CredentialScope) (RequestAuthenticator, error)
}

func (s stubSource) Name() string { return s.name }
func (s stubSource) Resolve(ctx context.Context, scope CredentialScope) (RequestAuthenticator, error) {
	return s.resolve(ctx, scope)
}

type recordingAuthenticator struct{ label string }

func (a recordingAuthenticator) Authenticate(_ context.Context, req *http.Request, _ []byte) error {
	req.Header.Set("X-Test-Source", a.label)
	return nil
}

func TestResolvePrincipalCredential(t *testing.T) {
	UnregisterAllPrincipalSourcesForTest()
	defer UnregisterAllPrincipalSourcesForTest()

	var order []string
	RegisterPrincipalSource(stubSource{name: "first", resolve: func(_ context.Context, _ CredentialScope) (RequestAuthenticator, error) {
		order = append(order, "first")
		return nil, nil
	}})
	RegisterPrincipalSource(stubSource{name: "second", resolve: func(_ context.Context, _ CredentialScope) (RequestAuthenticator, error) {
		order = append(order, "second")
		return recordingAuthenticator{label: "second"}, nil
	}})
	RegisterPrincipalSource(stubSource{name: "third", resolve: func(_ context.Context, _ CredentialScope) (RequestAuthenticator, error) {
		order = append(order, "third")
		return recordingAuthenticator{label: "third"}, nil
	}})

	a, name, err := ResolvePrincipalCredential(context.Background(), CredentialScope{Subject: "alice", Provider: "anthropic"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if name != "second" {
		t.Fatalf("expected 'second' to win, got %q", name)
	}
	if len(order) != 2 || order[0] != "first" || order[1] != "second" {
		t.Fatalf("expected sequential consultation stopping at first answer, got %v", order)
	}
	req, _ := http.NewRequest(http.MethodGet, "https://example.com", nil)
	if err := a.Authenticate(context.Background(), req, nil); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("X-Test-Source") != "second" {
		t.Fatalf("expected authenticator from 'second', got header %q", req.Header.Get("X-Test-Source"))
	}
}

func TestPrincipalSourceFailureContinues(t *testing.T) {
	UnregisterAllPrincipalSourcesForTest()
	defer UnregisterAllPrincipalSourcesForTest()

	RegisterPrincipalSource(stubSource{name: "broken", resolve: func(_ context.Context, _ CredentialScope) (RequestAuthenticator, error) {
		return nil, errors.New("boom")
	}})
	RegisterPrincipalSource(stubSource{name: "healthy", resolve: func(_ context.Context, _ CredentialScope) (RequestAuthenticator, error) {
		return recordingAuthenticator{label: "healthy"}, nil
	}})

	a, name, err := ResolvePrincipalCredential(context.Background(), CredentialScope{Subject: "alice", Provider: "anthropic"})
	if err != nil {
		t.Fatalf("a failing source must not abort the chain: %v", err)
	}
	if name != "healthy" || a == nil {
		t.Fatalf("expected the later source to still answer, got name=%q a=%v", name, a)
	}
}

func TestRegisterPrincipalSourceIdempotent(t *testing.T) {
	UnregisterAllPrincipalSourcesForTest()
	defer UnregisterAllPrincipalSourcesForTest()

	RegisterPrincipalSource(stubSource{name: "a", resolve: func(_ context.Context, _ CredentialScope) (RequestAuthenticator, error) {
		return nil, nil
	}})
	RegisterPrincipalSource(stubSource{name: "b", resolve: func(_ context.Context, _ CredentialScope) (RequestAuthenticator, error) {
		return recordingAuthenticator{label: "b-v1"}, nil
	}})
	// Re-register "b" with new behavior; must replace in place at position 1,
	// not append at position 2.
	RegisterPrincipalSource(stubSource{name: "b", resolve: func(_ context.Context, _ CredentialScope) (RequestAuthenticator, error) {
		return recordingAuthenticator{label: "b-v2"}, nil
	}})

	principalSourceMu.RLock()
	count := len(principalSources)
	principalSourceMu.RUnlock()
	if count != 2 {
		t.Fatalf("expected re-registration to replace in place, got %d sources", count)
	}

	a, name, err := ResolvePrincipalCredential(context.Background(), CredentialScope{Subject: "x", Provider: "p"})
	if err != nil || name != "b" {
		t.Fatalf("expected 'b' to answer, got name=%q err=%v", name, err)
	}
	req, _ := http.NewRequest(http.MethodGet, "https://example.com", nil)
	if err := a.Authenticate(context.Background(), req, nil); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("X-Test-Source") != "b-v2" {
		t.Fatalf("expected the replaced 'b' behavior to be in effect, got %q", req.Header.Get("X-Test-Source"))
	}
}

// TestAuthenticatorDoesNotExposeKey pins R-06 structurally: RequestAuthenticator
// has exactly one method, Authenticate, which returns only an error. There is
// no method on the interface that could return a raw credential string.
func TestAuthenticatorDoesNotExposeKey(t *testing.T) {
	typ := reflect.TypeOf((*RequestAuthenticator)(nil)).Elem()
	if typ.NumMethod() != 1 {
		t.Fatalf("expected RequestAuthenticator to have exactly one method, got %d", typ.NumMethod())
	}
	m := typ.Method(0)
	if m.Name != "Authenticate" {
		t.Fatalf("expected the sole method to be Authenticate, got %q", m.Name)
	}
	// One return value, and it must be an error -- never a string.
	if m.Type.NumOut() != 1 {
		t.Fatalf("expected Authenticate to return exactly one value, got %d", m.Type.NumOut())
	}
	errType := reflect.TypeOf((*error)(nil)).Elem()
	if !m.Type.Out(0).Implements(errType) {
		t.Fatalf("expected Authenticate's return value to be an error, got %v", m.Type.Out(0))
	}
}

// credentialFieldPattern matches a field name that looks like it could carry
// a raw credential. Case-insensitive; matches "apiKey", "api_key",
// "credential", "secret", "token", "bearer" anywhere in the field name.
var credentialFieldPattern = regexp.MustCompile(`(?i)(apikey|api_key|credential|secret|token|bearer)`)

// preExistingCredentialWriteFields allowlists the fields that already carry
// a credential value on ClientCommand:
//
//   - Credential: the explicit store_credential write command (baseline.md
//     B-11/B-12, partitioned per principal by child 08). A deliberate,
//     user-initiated write to storage.
//   - CredentialRequestID/CredentialFound/CredentialToken/CredentialHeader:
//     credential_response (child 09, SC-9), the client's explicit ANSWER to
//     an engine-raised engine_credential_request. This is the opposite of
//     an implicit push -- the engine asks a specific question and the
//     client answers it once, on demand; nothing rides along with
//     start_session/send_prompt's own attribution the way R-05 forbids.
//
// This test still fails on any OTHER credential-shaped field added anywhere
// on the struct, which is what would silently reintroduce a push.
var preExistingCredentialWriteFields = map[string]bool{
	"Credential":          true,
	"CredentialRequestID": true,
	"CredentialFound":     true,
	"CredentialToken":     true,
	"CredentialHeader":    true,
}

// TestClientCommandCarriesNoCredential enforces R-05 structurally: no field
// on protocol.ClientCommand may look like it carries a raw credential (beyond
// the one pre-existing, explicit store_credential write field), so a later
// edit cannot quietly add an implicit credential push to the scrutinized wire
// contract.
func TestClientCommandCarriesNoCredential(t *testing.T) {
	typ := reflect.TypeOf(protocol.ClientCommand{})
	for i := 0; i < typ.NumField(); i++ {
		name := typ.Field(i).Name
		if preExistingCredentialWriteFields[name] {
			continue
		}
		if credentialFieldPattern.MatchString(name) {
			t.Errorf("ClientCommand field %q looks credential-shaped; the engine wire must never carry an implicit credential push (R-05)", name)
		}
	}
}

func TestNoSourcesFallsThroughUnchanged(t *testing.T) {
	UnregisterAllPrincipalSourcesForTest()
	defer UnregisterAllPrincipalSourcesForTest()

	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("ANTHROPIC_API_KEY", "sk-no-sources")

	r := NewResolver(nil)
	cc := NewCredentialContext(nil, r, nil)
	a, err := cc.Authenticator(context.Background(), "anthropic")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	req, _ := http.NewRequest(http.MethodGet, "https://api.anthropic.com/v1/messages", nil)
	if err := a.Authenticate(context.Background(), req, nil); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("x-api-key") != "sk-no-sources" {
		t.Fatalf("expected the resolver fallback to authenticate exactly as ResolveKey would, got %q", req.Header.Get("x-api-key"))
	}
}

func TestCredentialContext_Subject(t *testing.T) {
	var nilCC *CredentialContext
	if nilCC.Subject() != "" {
		t.Fatal("expected nil CredentialContext.Subject() to be empty")
	}
	cc := &CredentialContext{}
	if cc.Subject() != "" {
		t.Fatal("expected nil Principal to yield empty Subject")
	}
	cc.Principal = &types.SessionPrincipal{Subject: "alice"}
	if cc.Subject() != "alice" {
		t.Fatalf("expected Subject 'alice', got %q", cc.Subject())
	}
}

func TestCredentialContext_RefusalWhenFallThroughDisallowed(t *testing.T) {
	UnregisterAllPrincipalSourcesForTest()
	defer UnregisterAllPrincipalSourcesForTest()

	r := NewResolver(nil)
	cc := NewCredentialContext(&types.SessionPrincipal{Subject: "alice"}, r, refusePolicy{})
	_, err := cc.Authenticator(context.Background(), "anthropic")
	if !errors.Is(err, ErrPrincipalCredentialUnresolved) {
		t.Fatalf("expected ErrPrincipalCredentialUnresolved, got %v", err)
	}
}

type refusePolicy struct{}

func (refusePolicy) AllowFallThrough(string) bool { return false }

func TestMachineTokenCache_SubjectExpiry(t *testing.T) {
	cache := newMachineTokenCache(60 * time.Second)
	acquire := func(_ context.Context) (string, time.Time, error) {
		return "tok", time.Now().Add(10 * time.Minute), nil
	}
	if _, err := cache.getOrAcquire(context.Background(), "alice", "p", "s", "scope", "aud", acquire); err != nil {
		t.Fatal(err)
	}
	if cache.expiry("alice", "scope", "aud").IsZero() {
		t.Fatal("expected a non-zero expiry for alice's cached token")
	}
	if !cache.expiry("bob", "scope", "aud").IsZero() {
		t.Fatal("expected bob to have no cached expiry")
	}
}
