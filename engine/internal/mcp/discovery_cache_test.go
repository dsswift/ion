package mcp

// discovery_cache_test.go — pins that OAuth metadata discovery is fetched once
// per URL per process.
//
// Discovery answers a static question, but it sits on two hot paths (the connect
// path building an authorization request, and annotateAuthFailure naming the
// issuer in a 401's remediation). Uncached, a single MCP connect issued two
// well-known fetches, and a server with a dead credential re-issued them on
// every connect forever.
//
// The negative case is the one that matters most: a server publishing no
// metadata probes every candidate URL and 404s on each before failing, so
// caching only successes would leave the most expensive case uncached.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// discoveryFixture serves RFC 9728 + RFC 8414 documents and counts every
// well-known request it receives, so a test can assert on fetch counts rather
// than on wall-clock time.
type discoveryFixture struct {
	server             *httptest.Server
	protectedRequests  atomic.Int64
	authServerRequests atomic.Int64
	// serveProtected controls whether the protected-resource probe succeeds.
	serveProtected atomic.Bool
}

func newDiscoveryFixture(t *testing.T) *discoveryFixture {
	t.Helper()
	fix := &discoveryFixture{}
	fix.serveProtected.Store(true)

	mux := http.NewServeMux()
	fix.server = httptest.NewServer(mux)
	t.Cleanup(fix.server.Close)

	mux.HandleFunc("/.well-known/oauth-protected-resource/", func(w http.ResponseWriter, r *http.Request) {
		fix.protectedRequests.Add(1)
		if !fix.serveProtected.Load() {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"resource":              fix.server.URL + "/mcp",
			"authorization_servers": []string{fix.server.URL},
			"scopes_supported":      []string{"openid"},
		}); err != nil {
			t.Errorf("encode protected resource: %v", err)
		}
	})
	mux.HandleFunc("/.well-known/oauth-protected-resource", func(w http.ResponseWriter, r *http.Request) {
		fix.protectedRequests.Add(1)
		w.WriteHeader(http.StatusNotFound)
	})

	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		fix.authServerRequests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"issuer":                 fix.server.URL,
			"authorization_endpoint": fix.server.URL + "/authorize",
			"token_endpoint":         fix.server.URL + "/token",
		}); err != nil {
			t.Errorf("encode auth server: %v", err)
		}
	})

	return fix
}

// TestDiscoveryFetchedOncePerURL pins the success path: repeated two-hop
// discovery for one URL contacts each well-known endpoint exactly once.
func TestDiscoveryFetchedOncePerURL(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	fix := newDiscoveryFixture(t)
	resourceURL := fix.server.URL + "/mcp"

	meta, scope, err := DiscoverForServer("srv", resourceURL)
	if err != nil {
		t.Fatalf("DiscoverForServer: %v", err)
	}
	if meta.TokenEndpoint == "" {
		t.Fatal("expected a resolved token endpoint")
	}
	if scope != "openid" {
		t.Errorf("scope = %q, want %q", scope, "openid")
	}

	firstProtected := fix.protectedRequests.Load()
	firstAuth := fix.authServerRequests.Load()
	if firstProtected == 0 || firstAuth == 0 {
		t.Fatalf("precondition: the first discovery must fetch (protected=%d auth=%d)", firstProtected, firstAuth)
	}

	// Ten more resolutions, standing in for ten conversations connecting to the
	// same server. None may contact the network.
	for i := 0; i < 10; i++ {
		again, againScope, againErr := DiscoverForServer("srv", resourceURL)
		if againErr != nil {
			t.Fatalf("cached DiscoverForServer %d: %v", i, againErr)
		}
		if again.TokenEndpoint != meta.TokenEndpoint || againScope != scope {
			t.Errorf("cached result %d differs from the first (%q/%q vs %q/%q)",
				i, again.TokenEndpoint, againScope, meta.TokenEndpoint, scope)
		}
	}

	if got := fix.protectedRequests.Load(); got != firstProtected {
		t.Errorf("protected-resource fetched %d times, want %d — repeats must be served from cache", got, firstProtected)
	}
	if got := fix.authServerRequests.Load(); got != firstAuth {
		t.Errorf("authorization-server fetched %d times, want %d — repeats must be served from cache", got, firstAuth)
	}
}

// TestDiscoveryFailureIsCached pins the negative path. This is the expensive
// case: a server with no metadata probes every candidate and 404s on each, and
// it is exactly the case a success-only cache would leave uncached.
func TestDiscoveryFailureIsCached(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	fix := newDiscoveryFixture(t)
	fix.serveProtected.Store(false)
	resourceURL := fix.server.URL + "/mcp"

	if _, _, err := DiscoverForServer("srv", resourceURL); err == nil {
		t.Fatal("expected discovery to fail when no metadata is published")
	}
	afterFirst := fix.protectedRequests.Load()
	if afterFirst == 0 {
		t.Fatal("precondition: the first attempt must probe")
	}

	for i := 0; i < 10; i++ {
		if _, _, err := DiscoverForServer("srv", resourceURL); err == nil {
			t.Fatalf("cached attempt %d must keep failing", i)
		}
	}

	if got := fix.protectedRequests.Load(); got != afterFirst {
		t.Errorf("failed discovery re-probed: %d requests, want %d — a cached failure must not re-fetch", got, afterFirst)
	}
}

// TestLoginInvalidatesDiscovery pins the recovery path. A server whose first
// discovery failed must be re-probed when the operator logs in, otherwise the
// cached failure would outlive the problem for the daemon's life and no login
// could ever fix it.
func TestLoginInvalidatesDiscovery(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	fix := newDiscoveryFixture(t)
	fix.serveProtected.Store(false)
	resourceURL := fix.server.URL + "/mcp"

	if _, _, err := DiscoverForServer("srv", resourceURL); err == nil {
		t.Fatal("precondition: discovery must fail first")
	}
	cachedCount := fix.protectedRequests.Load()

	// The operator fixes whatever was wrong and logs in. BeginLogin invalidates
	// before probing; call the invalidation directly so the test does not need
	// to drive an interactive browser flow.
	fix.serveProtected.Store(true)
	invalidateDiscovery(resourceURL, "")

	meta, _, err := DiscoverForServer("srv", resourceURL)
	if err != nil {
		t.Fatalf("discovery after invalidation must re-probe and succeed: %v", err)
	}
	if meta.TokenEndpoint == "" {
		t.Error("expected a resolved token endpoint after re-probe")
	}
	if fix.protectedRequests.Load() <= cachedCount {
		t.Error("invalidation did not cause a re-fetch")
	}
}
