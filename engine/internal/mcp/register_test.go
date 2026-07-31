package mcp

// register_test.go — behavior pins for RFC 7591 dynamic client registration.
//
// Registration is what makes a zero-config remote MCP server usable: no
// client_id exists until it runs. The request body shape matters (a public
// client with a bound redirect URI), and idempotence matters even more —
// re-registering on every login would orphan clients with the provider.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// registrationFixture spins up an authorization server that accepts dynamic
// registration, returning the server, an accessor for the captured request
// bodies, and metadata pointing at it.
func registrationFixture(t *testing.T, status int, response map[string]any) (*httptest.Server, func() []registrationRequest, *ServerMetadata) {
	t.Helper()

	var mu sync.Mutex
	var captured []registrationRequest

	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	mux.HandleFunc("/register", func(w http.ResponseWriter, r *http.Request) {
		var body registrationRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("registration body did not decode: %v", err)
		}
		mu.Lock()
		captured = append(captured, body)
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if err := json.NewEncoder(w).Encode(response); err != nil {
			t.Errorf("encode registration response: %v", err)
		}
	})

	meta := &ServerMetadata{
		Issuer:                server.URL,
		AuthorizationEndpoint: server.URL + "/authorize",
		TokenEndpoint:         server.URL + "/token",
		RegistrationEndpoint:  server.URL + "/register",
	}
	requests := func() []registrationRequest {
		mu.Lock()
		defer mu.Unlock()
		return append([]registrationRequest{}, captured...)
	}
	return server, requests, meta
}

// TestRegisterClient_RequestShape pins the RFC 7591 client-metadata document
// the engine submits. token_endpoint_auth_method "none" is the load-bearing
// field: the engine runs on the operator's machine and cannot hold a secret, so
// registering as a confidential client would produce a secret it must then
// store in plaintext.
func TestRegisterClient_RequestShape(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	server, captured, meta := registrationFixture(t, http.StatusCreated, map[string]any{"client_id": "issued-1"})
	defer server.Close()

	redirectURI := "http://127.0.0.1:51234/mcp/callback"
	reg, err := RegisterClient("srv", meta, redirectURI, "openid email")
	if err != nil {
		t.Fatalf("RegisterClient: %v", err)
	}
	if reg.ClientID != "issued-1" {
		t.Errorf("client id = %q, want the issued value", reg.ClientID)
	}

	requests := captured()
	if len(requests) != 1 {
		t.Fatalf("registration requests = %d, want 1", len(requests))
	}
	body := requests[0]
	if body.TokenEndpointAuthMethod != "none" {
		t.Errorf("token_endpoint_auth_method = %q, want \"none\" (public client)", body.TokenEndpointAuthMethod)
	}
	if len(body.RedirectURIs) != 1 || body.RedirectURIs[0] != redirectURI {
		t.Errorf("redirect_uris = %v, want exactly [%q]", body.RedirectURIs, redirectURI)
	}
	if body.Scope != "openid email" {
		t.Errorf("scope = %q, want the requested scope", body.Scope)
	}
	if body.ClientName == "" {
		t.Error("client_name must be sent; providers show it on the consent screen")
	}
	var hasCode, hasRefresh bool
	for _, g := range body.GrantTypes {
		if g == "authorization_code" {
			hasCode = true
		}
		if g == "refresh_token" {
			hasRefresh = true
		}
	}
	if !hasCode {
		t.Error("grant_types must include authorization_code")
	}
	if !hasRefresh {
		t.Error("grant_types must include refresh_token; without it a login expires with no silent renewal")
	}
}

// TestRegisterClient_PersistsRegistration pins that the issued client survives
// a store reload — the whole point of the client store.
func TestRegisterClient_PersistsRegistration(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	server, _, meta := registrationFixture(t, http.StatusCreated, map[string]any{
		"client_id": "issued-2", "client_secret": "provider-issued",
	})
	defer server.Close()

	if _, err := RegisterClient("srv", meta, "http://127.0.0.1:5000/mcp/callback", "openid"); err != nil {
		t.Fatalf("RegisterClient: %v", err)
	}

	stored := NewClientStore().Get("srv")
	if stored == nil {
		t.Fatal("registration was not persisted")
	}
	if stored.ClientID != "issued-2" {
		t.Errorf("persisted client id = %q", stored.ClientID)
	}
	// A provider that issues a secret despite the "none" request must have it
	// kept: omitting it makes the token exchange fail with invalid_client.
	if stored.ClientSecret != "provider-issued" {
		t.Errorf("persisted client secret = %q; a provider-issued secret must be kept", stored.ClientSecret)
	}
	if stored.RegisteredAt.IsZero() {
		t.Error("registered_at must be stamped")
	}
}

// TestRegisterClient_IdempotentNoSecondPost is the core regression: a second
// registration for the same server and endpoints must reuse the stored client
// and issue NO HTTP request.
func TestRegisterClient_IdempotentNoSecondPost(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	server, captured, meta := registrationFixture(t, http.StatusCreated, map[string]any{"client_id": "issued-3"})
	defer server.Close()

	first, err := RegisterClient("srv", meta, "http://127.0.0.1:5000/mcp/callback", "openid")
	if err != nil {
		t.Fatalf("first RegisterClient: %v", err)
	}
	second, err := RegisterClient("srv", meta, "http://127.0.0.1:5000/mcp/callback", "openid")
	if err != nil {
		t.Fatalf("second RegisterClient: %v", err)
	}

	if got := captured(); len(got) != 1 {
		t.Errorf("registration requests = %d; the second call must not contact the provider", len(got))
	}
	if first.ClientID != second.ClientID {
		t.Errorf("client id changed across calls: %q then %q", first.ClientID, second.ClientID)
	}
}

// TestRegisterClient_ReRegistersWhenEndpointsMoved pins the mismatch path: a
// stored client_id belongs to the OLD authorization server, so reusing it
// against a new one would fail with invalid_client.
func TestRegisterClient_ReRegistersWhenEndpointsMoved(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	oldServer, _, oldMeta := registrationFixture(t, http.StatusCreated, map[string]any{"client_id": "old-client"})
	defer oldServer.Close()
	if _, err := RegisterClient("srv", oldMeta, "http://127.0.0.1:5000/mcp/callback", "openid"); err != nil {
		t.Fatalf("initial RegisterClient: %v", err)
	}

	newServer, newCaptured, newMeta := registrationFixture(t, http.StatusCreated, map[string]any{"client_id": "new-client"})
	defer newServer.Close()
	reg, err := RegisterClient("srv", newMeta, "http://127.0.0.1:5000/mcp/callback", "openid")
	if err != nil {
		t.Fatalf("re-RegisterClient: %v", err)
	}

	if got := newCaptured(); len(got) != 1 {
		t.Errorf("new-server registration requests = %d, want 1", len(got))
	}
	if reg.ClientID != "new-client" {
		t.Errorf("client id = %q, want a freshly issued client for the moved endpoints", reg.ClientID)
	}
}

// TestRegisterClient_AcceptsHTTP200 pins tolerance for providers that return
// 200 instead of the spec's 201.
func TestRegisterClient_AcceptsHTTP200(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	server, _, meta := registrationFixture(t, http.StatusOK, map[string]any{"client_id": "issued-200"})
	defer server.Close()

	reg, err := RegisterClient("srv", meta, "http://127.0.0.1:5000/mcp/callback", "")
	if err != nil {
		t.Fatalf("RegisterClient with 200 response: %v", err)
	}
	if reg.ClientID != "issued-200" {
		t.Errorf("client id = %q", reg.ClientID)
	}
}

// TestRegisterClient_SurfacesOAuthError pins that the provider's own error
// code and description reach the operator rather than a bare status.
func TestRegisterClient_SurfacesOAuthError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	server, _, meta := registrationFixture(t, http.StatusBadRequest, map[string]any{
		"error":             "invalid_redirect_uri",
		"error_description": "loopback redirects must use 127.0.0.1",
	})
	defer server.Close()

	_, err := RegisterClient("srv", meta, "http://localhost:5000/mcp/callback", "")
	if err == nil {
		t.Fatal("expected an error for a rejected registration")
	}
	if !strings.Contains(err.Error(), "invalid_redirect_uri") {
		t.Errorf("error must carry the provider's error code, got %q", err)
	}
	if !strings.Contains(err.Error(), "loopback redirects") {
		t.Errorf("error must carry the provider's description, got %q", err)
	}
}

// TestRegisterClient_NoRegistrationEndpointNamesRemediation pins the
// non-DCR path: the operator must be told to configure a client_id, since
// nothing the engine can do will produce one.
func TestRegisterClient_NoRegistrationEndpointNamesRemediation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	_, err := RegisterClient("srv", &ServerMetadata{
		Issuer:                "https://auth.example.test",
		AuthorizationEndpoint: "https://auth.example.test/authorize",
		TokenEndpoint:         "https://auth.example.test/token",
	}, "http://127.0.0.1:5000/mcp/callback", "")
	if err == nil {
		t.Fatal("expected an error when the server supports no dynamic registration")
	}
	if !strings.Contains(err.Error(), "oauth.client_id") {
		t.Errorf("error must name the config remediation, got %q", err)
	}
}

// TestRegisterClient_MissingClientIDIsAnError pins that a 201 with no client_id
// is rejected instead of persisting an empty client that would fail later at
// the authorization endpoint.
func TestRegisterClient_MissingClientIDIsAnError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	server, _, meta := registrationFixture(t, http.StatusCreated, map[string]any{"client_secret": "orphan"})
	defer server.Close()

	if _, err := RegisterClient("srv", meta, "http://127.0.0.1:5000/mcp/callback", ""); err == nil {
		t.Fatal("expected an error when the response carries no client_id")
	}
	if NewClientStore().Get("srv") != nil {
		t.Error("a response with no client_id must not be persisted")
	}
}

func TestRegisterClient_NilMetadataIsAnError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	if _, err := RegisterClient("srv", nil, "http://127.0.0.1:5000/mcp/callback", ""); err == nil {
		t.Error("expected an error for nil metadata")
	}
}
