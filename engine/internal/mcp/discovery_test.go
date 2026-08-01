package mcp

// discovery_test.go — behavior pins for OAuth metadata discovery.
//
// Fixtures mirror the shapes a real discovery-capable MCP server serves (an
// RFC 9728 protected-resource document naming a Supabase-style authorization
// server whose issuer carries a path component), because the path-vs-root
// probe ordering is the part that breaks against real deployments.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// writeJSON is a fixture helper for well-known handlers.
func writeJSON(t *testing.T, w http.ResponseWriter, payload any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		t.Errorf("encode fixture response: %v", err)
	}
}

func TestWellKnownCandidates_PathFormFirst(t *testing.T) {
	got, err := wellKnownCandidates("https://api.example.com/mcp", "oauth-protected-resource")
	if err != nil {
		t.Fatalf("wellKnownCandidates: %v", err)
	}
	want := []string{
		"https://api.example.com/.well-known/oauth-protected-resource/mcp",
		"https://api.example.com/.well-known/oauth-protected-resource",
	}
	if len(got) != len(want) {
		t.Fatalf("candidates = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("candidate[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestWellKnownCandidates_RootPathYieldsSingleProbe(t *testing.T) {
	got, err := wellKnownCandidates("https://api.example.com/", "oauth-authorization-server")
	if err != nil {
		t.Fatalf("wellKnownCandidates: %v", err)
	}
	if len(got) != 1 || got[0] != "https://api.example.com/.well-known/oauth-authorization-server" {
		t.Errorf("candidates = %v; a path-less base must probe the root form once", got)
	}
}

func TestWellKnownCandidates_RejectsRelativeURL(t *testing.T) {
	if _, err := wellKnownCandidates("not-a-url", "oauth-protected-resource"); err == nil {
		t.Error("expected an error for a non-absolute URL")
	}
}

// TestDiscoverProtectedResource_PathProbeWins pins that the spec-correct
// path-suffix probe is preferred when both forms are served. A server can
// legitimately serve different documents at the two URLs (one per resource),
// so taking the root form first would authorize against the wrong resource.
func TestDiscoverProtectedResource_PathProbeWins(t *testing.T) {
	var rootHits atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ProtectedResourceMetadata{
			Resource:             "https://example.test/mcp",
			AuthorizationServers: []string{"https://auth.example.test/auth/v1"},
			ScopesSupported:      []string{"openid"},
		})
	})
	mux.HandleFunc("/.well-known/oauth-protected-resource", func(w http.ResponseWriter, r *http.Request) {
		rootHits.Add(1)
		writeJSON(t, w, ProtectedResourceMetadata{
			Resource:             "https://example.test/",
			AuthorizationServers: []string{"https://WRONG.example.test"},
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	doc, err := DiscoverProtectedResource("t", server.URL+"/mcp")
	if err != nil {
		t.Fatalf("DiscoverProtectedResource: %v", err)
	}
	if len(doc.AuthorizationServers) != 1 || doc.AuthorizationServers[0] != "https://auth.example.test/auth/v1" {
		t.Errorf("authorization servers = %v; the path-form document must win", doc.AuthorizationServers)
	}
	if rootHits.Load() != 0 {
		t.Errorf("root form was probed %d times; it must not be reached when the path form answers", rootHits.Load())
	}
}

// TestDiscoverProtectedResource_RootFallback pins the fallback: real servers
// serve only the root form, and treating a 404 on the path form as fatal would
// reject them.
func TestDiscoverProtectedResource_RootFallback(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/oauth-protected-resource", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ProtectedResourceMetadata{
			Resource:             "https://example.test/mcp",
			AuthorizationServers: []string{"https://auth.example.test"},
			ScopesSupported:      []string{"openid", "profile"},
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	doc, err := DiscoverProtectedResource("t", server.URL+"/mcp")
	if err != nil {
		t.Fatalf("DiscoverProtectedResource: %v", err)
	}
	if len(doc.ScopesSupported) != 2 {
		t.Errorf("scopes = %v, want two entries from the root document", doc.ScopesSupported)
	}
}

// TestDiscoverProtectedResource_SkipsDocumentWithNoAuthServer pins that a
// document naming zero authorization servers is not accepted as an answer: it
// cannot drive a grant, and accepting it would produce a confusing empty-issuer
// failure further along.
func TestDiscoverProtectedResource_SkipsDocumentWithNoAuthServer(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ProtectedResourceMetadata{Resource: "https://example.test/mcp"})
	})
	mux.HandleFunc("/.well-known/oauth-protected-resource", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ProtectedResourceMetadata{
			Resource:             "https://example.test/mcp",
			AuthorizationServers: []string{"https://auth.example.test"},
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	doc, err := DiscoverProtectedResource("t", server.URL+"/mcp")
	if err != nil {
		t.Fatalf("DiscoverProtectedResource: %v", err)
	}
	if len(doc.AuthorizationServers) != 1 {
		t.Errorf("authorization servers = %v; must fall through to the usable document", doc.AuthorizationServers)
	}
}

func TestDiscoverProtectedResource_NoMetadataIsAnError(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()

	_, err := DiscoverProtectedResource("t", server.URL+"/mcp")
	if err == nil {
		t.Fatal("expected an error when no protected-resource metadata exists")
	}
	// The error must name both probes so an operator can verify by hand.
	if !strings.Contains(err.Error(), ".well-known/oauth-protected-resource") {
		t.Errorf("error should name the probed URLs, got %q", err)
	}
}

// TestDiscoverAuthServer_PathIssuer pins the RFC 8414 spelling for an issuer
// WITH a path component — the shape that reads backwards (well-known segment
// between host and path) and the one a Supabase-hosted authorization server
// serves.
func TestDiscoverAuthServer_PathIssuer(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/oauth-authorization-server/auth/v1", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ServerMetadata{
			Issuer:                        "https://auth.example.test/auth/v1",
			AuthorizationEndpoint:         "https://auth.example.test/auth/v1/oauth/authorize",
			TokenEndpoint:                 "https://auth.example.test/auth/v1/oauth/token",
			RegistrationEndpoint:          "https://auth.example.test/auth/v1/oauth/clients/register",
			ScopesSupported:               []string{"openid", "profile", "email"},
			CodeChallengeMethodsSupported: []string{"S256", "plain"},
			GrantTypesSupported:           []string{"authorization_code", "refresh_token"},
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	meta, err := DiscoverAuthServer("t", server.URL+"/auth/v1")
	if err != nil {
		t.Fatalf("DiscoverAuthServer: %v", err)
	}
	if meta.RegistrationEndpoint == "" {
		t.Error("registration endpoint must be carried through; it is what enables DCR")
	}
	if !meta.SupportsS256() {
		t.Error("SupportsS256 must be true when S256 is advertised")
	}
}

// TestDiscoverAuthServer_OpenIDConfigurationFallback pins that an issuer
// serving only the OIDC document resolves. Many providers publish
// openid-configuration and no RFC 8414 document.
func TestDiscoverAuthServer_OpenIDConfigurationFallback(t *testing.T) {
	var rfc8414Hits atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		rfc8414Hits.Add(1)
		http.NotFound(w, r)
	})
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ServerMetadata{
			Issuer:                "https://auth.example.test",
			AuthorizationEndpoint: "https://auth.example.test/authorize",
			TokenEndpoint:         "https://auth.example.test/token",
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	meta, err := DiscoverAuthServer("t", server.URL)
	if err != nil {
		t.Fatalf("DiscoverAuthServer: %v", err)
	}
	if meta.TokenEndpoint != "https://auth.example.test/token" {
		t.Errorf("token endpoint = %q, want the OIDC document's value", meta.TokenEndpoint)
	}
	if rfc8414Hits.Load() == 0 {
		t.Error("the RFC 8414 document must be probed before the OIDC fallback")
	}
}

// TestDiscoverAuthServer_SkipsIncompleteDocument pins that a document missing
// the token endpoint is rejected rather than returned: it cannot complete a
// grant, and returning it would fail later with an empty-URL POST.
func TestDiscoverAuthServer_SkipsIncompleteDocument(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ServerMetadata{
			Issuer:                "https://auth.example.test",
			AuthorizationEndpoint: "https://auth.example.test/authorize",
			// no token_endpoint
		})
	})
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ServerMetadata{
			Issuer:                "https://auth.example.test",
			AuthorizationEndpoint: "https://auth.example.test/authorize",
			TokenEndpoint:         "https://auth.example.test/token",
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	meta, err := DiscoverAuthServer("t", server.URL)
	if err != nil {
		t.Fatalf("DiscoverAuthServer: %v", err)
	}
	if meta.TokenEndpoint == "" {
		t.Error("an incomplete document must be skipped in favor of a complete one")
	}
}

// TestSupportsS256_EmptyListIsPermitted pins the documented decision: RFC 8414
// makes the field optional, so an absent list must not reject a working server.
func TestSupportsS256_EmptyListIsPermitted(t *testing.T) {
	if !(&ServerMetadata{}).SupportsS256() {
		t.Error("an absent code_challenge_methods_supported must be treated as S256-capable")
	}
	if (&ServerMetadata{CodeChallengeMethodsSupported: []string{"plain"}}).SupportsS256() {
		t.Error("a list advertising only plain must not report S256 support")
	}
}

// TestDiscoverForServer_TwoHop pins the full path an operator's bare URL takes:
// resource metadata, then the authorization server it names, with the
// resource's scopes returned for the authorization request.
func TestDiscoverForServer_TwoHop(t *testing.T) {
	authMux := http.NewServeMux()
	authServer := httptest.NewServer(authMux)
	defer authServer.Close()
	authMux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ServerMetadata{
			Issuer:                authServer.URL,
			AuthorizationEndpoint: authServer.URL + "/authorize",
			TokenEndpoint:         authServer.URL + "/token",
			RegistrationEndpoint:  authServer.URL + "/register",
		})
	})

	resourceMux := http.NewServeMux()
	resourceServer := httptest.NewServer(resourceMux)
	defer resourceServer.Close()
	resourceMux.HandleFunc("/.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ProtectedResourceMetadata{
			Resource:             resourceServer.URL + "/mcp",
			AuthorizationServers: []string{authServer.URL},
			ScopesSupported:      []string{"openid", "email"},
		})
	})

	meta, scope, err := DiscoverForServer("t", resourceServer.URL+"/mcp")
	if err != nil {
		t.Fatalf("DiscoverForServer: %v", err)
	}
	if meta.RegistrationEndpoint != authServer.URL+"/register" {
		t.Errorf("registration endpoint = %q", meta.RegistrationEndpoint)
	}
	if scope != "openid email" {
		t.Errorf("scope = %q, want the resource's advertised scopes space-joined", scope)
	}
}

// TestDiscoverForServer_TriesEveryNamedAuthServer pins that a resource naming
// several authorization servers falls through past an unreachable one instead
// of failing on the first.
func TestDiscoverForServer_TriesEveryNamedAuthServer(t *testing.T) {
	deadServer := httptest.NewServer(http.NotFoundHandler())
	deadURL := deadServer.URL
	deadServer.Close()

	authMux := http.NewServeMux()
	authServer := httptest.NewServer(authMux)
	defer authServer.Close()
	authMux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ServerMetadata{
			Issuer:                authServer.URL,
			AuthorizationEndpoint: authServer.URL + "/authorize",
			TokenEndpoint:         authServer.URL + "/token",
		})
	})

	resourceMux := http.NewServeMux()
	resourceServer := httptest.NewServer(resourceMux)
	defer resourceServer.Close()
	resourceMux.HandleFunc("/.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ProtectedResourceMetadata{
			Resource:             resourceServer.URL + "/mcp",
			AuthorizationServers: []string{deadURL, authServer.URL},
		})
	})

	meta, _, err := DiscoverForServer("t", resourceServer.URL+"/mcp")
	if err != nil {
		t.Fatalf("DiscoverForServer: %v", err)
	}
	if meta.TokenEndpoint != authServer.URL+"/token" {
		t.Errorf("token endpoint = %q; the second named server must be tried", meta.TokenEndpoint)
	}
}

// TestFetchWellKnown_NonJSONBodyDoesNotAbortProbing pins that a 200 serving
// HTML (a catch-all SPA route, the common real-world case) is treated as a miss
// so the next candidate is still tried.
func TestFetchWellKnown_NonJSONBodyDoesNotAbortProbing(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		if _, err := fmt.Fprint(w, "<html><body>not found</body></html>"); err != nil {
			t.Errorf("write fixture: %v", err)
		}
	})
	mux.HandleFunc("/.well-known/oauth-protected-resource", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ProtectedResourceMetadata{
			Resource:             "https://example.test/mcp",
			AuthorizationServers: []string{"https://auth.example.test"},
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	doc, err := DiscoverProtectedResource("t", server.URL+"/mcp")
	if err != nil {
		t.Fatalf("DiscoverProtectedResource: %v", err)
	}
	if len(doc.AuthorizationServers) != 1 {
		t.Errorf("authorization servers = %v; an HTML 200 must count as a miss", doc.AuthorizationServers)
	}
}
