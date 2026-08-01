package mcp

// login_test.go — behavior pins for interactive MCP OAuth login.
//
// The headline regression: before this feature, OAuthStore.SetToken had no
// producer. A token could be refreshed but never obtained, so every
// authorization-requiring server connected unauthenticated and 401'd forever.
// TestBeginLogin_PersistsToken drives the full loopback exchange and asserts a
// token lands in the store — it fails on the unfixed code because no code path
// existed to reach.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// authServerFixture stands up an authorization server that supports dynamic
// registration and the authorization-code grant. tokenForm captures the token
// exchange body so the test can assert on what the engine sent.
type authServerFixture struct {
	server    *httptest.Server
	mu        sync.Mutex
	tokenForm url.Values
	tokenResp map[string]any
	tokenCode int
}

func newAuthServerFixture(t *testing.T) *authServerFixture {
	t.Helper()
	fix := &authServerFixture{
		tokenCode: http.StatusOK,
		tokenResp: map[string]any{
			"access_token":  "access-xyz",
			"refresh_token": "refresh-xyz",
			"token_type":    "bearer",
			"expires_in":    3600,
			"scope":         "openid",
		},
	}

	mux := http.NewServeMux()
	fix.server = httptest.NewServer(mux)

	mux.HandleFunc("/register", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		if err := json.NewEncoder(w).Encode(map[string]any{"client_id": "dcr-client"}); err != nil {
			t.Errorf("encode registration: %v", err)
		}
	})

	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse token form: %v", err)
		}
		fix.mu.Lock()
		fix.tokenForm = r.PostForm
		code := fix.tokenCode
		resp := fix.tokenResp
		fix.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			t.Errorf("encode token response: %v", err)
		}
	})

	// Protected-resource + authorization-server metadata, served from the same
	// host so one fixture covers the whole two-hop discovery.
	mux.HandleFunc("/.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ProtectedResourceMetadata{
			Resource:             fix.server.URL + "/mcp",
			AuthorizationServers: []string{fix.server.URL},
			ScopesSupported:      []string{"openid"},
		})
	})
	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, ServerMetadata{
			Issuer:                        fix.server.URL,
			AuthorizationEndpoint:         fix.server.URL + "/authorize",
			TokenEndpoint:                 fix.server.URL + "/token",
			RegistrationEndpoint:          fix.server.URL + "/register",
			CodeChallengeMethodsSupported: []string{"S256"},
			GrantTypesSupported:           []string{"authorization_code", "refresh_token"},
		})
	})

	t.Cleanup(fix.server.Close)
	return fix
}

func (f *authServerFixture) config() types.McpServerConfig {
	return types.McpServerConfig{Type: "http", URL: f.server.URL + "/mcp"}
}

func (f *authServerFixture) capturedTokenForm() url.Values {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tokenForm
}

// completeCallback drives the browser half of the flow: it GETs the loopback
// redirect_uri from the authorization URL with a code and the matching state,
// exactly as a provider would after the user consents.
func completeCallback(t *testing.T, authorizationURL, code string) {
	t.Helper()

	parsed, err := url.Parse(authorizationURL)
	if err != nil {
		t.Fatalf("parse authorization url: %v", err)
	}
	q := parsed.Query()
	redirectURI := q.Get("redirect_uri")
	state := q.Get("state")
	if redirectURI == "" || state == "" {
		t.Fatalf("authorization url is missing redirect_uri/state: %s", authorizationURL)
	}

	callback := fmt.Sprintf("%s?code=%s&state=%s", redirectURI, url.QueryEscape(code), url.QueryEscape(state))
	resp, err := http.Get(callback) //nolint:gosec // fixture URL built from the flow's own redirect_uri
	if err != nil {
		t.Fatalf("drive callback: %v", err)
	}
	if closeErr := resp.Body.Close(); closeErr != nil {
		t.Errorf("close callback response: %v", closeErr)
	}
}

// TestBeginLogin_AuthorizationURLCarriesPKCE pins that the URL handed to the
// consumer is a real S256 PKCE authorization request.
func TestBeginLogin_AuthorizationURLCarriesPKCE(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	fix := newAuthServerFixture(t)

	login, err := BeginLogin("srv", fix.config(), "")
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	defer login.Cancel()

	parsed, err := url.Parse(login.AuthorizationURL)
	if err != nil {
		t.Fatalf("parse authorization url: %v", err)
	}
	q := parsed.Query()
	if q.Get("code_challenge") == "" {
		t.Error("authorization url must carry code_challenge")
	}
	if got := q.Get("code_challenge_method"); got != "S256" {
		t.Errorf("code_challenge_method = %q, want S256", got)
	}
	if got := q.Get("response_type"); got != "code" {
		t.Errorf("response_type = %q, want code", got)
	}
	if got := q.Get("client_id"); got != "dcr-client" {
		t.Errorf("client_id = %q, want the dynamically registered client", got)
	}
	if !strings.HasPrefix(q.Get("redirect_uri"), "http://127.0.0.1:") {
		t.Errorf("redirect_uri = %q, want a loopback URI", q.Get("redirect_uri"))
	}
	if !strings.HasSuffix(q.Get("redirect_uri"), loginRedirectPath) {
		t.Errorf("redirect_uri = %q, want the MCP callback path", q.Get("redirect_uri"))
	}
}

// TestBeginLogin_PersistsToken is the regression test for the missing producer.
// On the unfixed code there is no way to reach SetToken at all.
func TestBeginLogin_PersistsToken(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	fix := newAuthServerFixture(t)

	login, err := BeginLogin("srv", fix.config(), "")
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	defer login.Cancel()

	completeCallback(t, login.AuthorizationURL, "auth-code-1")

	select {
	case <-login.Done:
	case loginErr := <-login.Err:
		t.Fatalf("login reported an error: %v", loginErr)
	case <-time.After(10 * time.Second):
		t.Fatal("login did not complete")
	}

	// The token must be in the store the connect path reads.
	token := getOAuthStore().GetToken("srv")
	if token == nil {
		t.Fatal("no token persisted after a successful login")
	}
	if token.AccessToken != "access-xyz" {
		t.Errorf("access token = %q", token.AccessToken)
	}
	if token.RefreshToken != "refresh-xyz" {
		t.Errorf("refresh token = %q; without it the grant cannot be silently renewed", token.RefreshToken)
	}
	if token.ExpiresAt.IsZero() {
		t.Error("expiry must be computed from expires_in")
	}
	if !IsAuthenticated("srv") {
		t.Error("IsAuthenticated must report true after a completed login")
	}

	// The token exchange must be a PKCE exchange for the registered client.
	form := fix.capturedTokenForm()
	if form.Get("grant_type") != "authorization_code" {
		t.Errorf("grant_type = %q", form.Get("grant_type"))
	}
	if form.Get("code_verifier") == "" {
		t.Error("token exchange must send code_verifier")
	}
	if form.Get("code") != "auth-code-1" {
		t.Errorf("code = %q, want the code delivered to the callback", form.Get("code"))
	}
	if form.Get("client_secret") != "" {
		t.Error("a public client must not send client_secret")
	}
}

// TestBeginLogin_AuthorizedHeaderReachesConnect closes the loop: after login,
// the header-resolution path the connect code uses must produce a Bearer header
// with NO oauth block in engine.json. This is what makes a zero-config server
// work; gating token resolution on config.OAuth != nil would fail here.
func TestBeginLogin_AuthorizedHeaderReachesConnect(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	fix := newAuthServerFixture(t)

	login, err := BeginLogin("srv", fix.config(), "")
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	defer login.Cancel()
	completeCallback(t, login.AuthorizationURL, "auth-code-2")
	select {
	case <-login.Done:
	case loginErr := <-login.Err:
		t.Fatalf("login reported an error: %v", loginErr)
	case <-time.After(10 * time.Second):
		t.Fatal("login did not complete")
	}

	headers := resolveOAuthHeaders("srv", nil)
	if headers == nil {
		t.Fatal("no auth headers resolved for a logged-in server with no oauth config block")
	}
	if got := headers["Authorization"]; got != "Bearer access-xyz" {
		t.Errorf("Authorization = %q, want a capitalized Bearer header", got)
	}
}

// TestConnect_SendsStoredTokenWithoutOAuthConfigBlock pins the same guarantee
// at the seam that actually matters: Connect itself.
//
// This is deliberately a Connect-level test rather than a resolveOAuthHeaders
// one. The gate that was wrong is in Connect ("only resolve a token when
// config.OAuth != nil"), and a unit test calling resolveOAuthHeaders directly
// passes with that gate still in place — false coverage. Here the MCP server
// demands a Bearer token and answers 401 without one, so a Connect that fails
// to attach the stored token cannot succeed.
func TestConnect_SendsStoredTokenWithoutOAuthConfigBlock(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	// A stored token and its endpoints, exactly as a completed login leaves them.
	getOAuthStore().SetToken("srv", &OAuthToken{
		AccessToken: "stored-access", TokenType: "bearer",
		ExpiresAt: time.Now().Add(time.Hour),
	})
	getClientStore().Set("srv", &ClientRegistration{
		ClientID: "dcr-client",
		AuthURL:  "https://auth.example.test/authorize",
		TokenURL: "https://auth.example.test/token",
	})

	var sawAuth sync.Map
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		sawAuth.Store("last", auth)
		if auth != "Bearer stored-access" {
			w.WriteHeader(http.StatusUnauthorized)
			if _, err := w.Write([]byte(`{"error":"unauthorized"}`)); err != nil {
				t.Errorf("write 401 body: %v", err)
			}
			return
		}

		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode rpc request: %v", err)
		}
		result := map[string]any{}
		if req.Method == "tools/list" {
			result["tools"] = []map[string]any{{"name": "search", "description": "d"}}
		}
		writeJSON(t, w, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	}))
	defer server.Close()

	// No OAuth block at all — the zero-config shape `ion mcp add` writes.
	conn, err := Connect("srv", types.McpServerConfig{Type: "http", URL: server.URL})
	if err != nil {
		last, _ := sawAuth.Load("last")
		t.Fatalf("Connect failed for a logged-in server with no oauth block: %v (Authorization sent: %q)", err, last)
	}
	defer func() {
		if closeErr := conn.Close(); closeErr != nil {
			t.Errorf("close connection: %v", closeErr)
		}
	}()

	if len(conn.Tools()) != 1 {
		t.Errorf("tools = %d, want the server's single tool", len(conn.Tools()))
	}
}

// TestConnect_UnauthorizedErrorNamesRemediation pins that a real 401 from a
// server the operator has NOT logged into produces an actionable error, not a
// bare status code.
func TestConnect_UnauthorizedErrorNamesRemediation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	_, err := Connect("needs-auth", types.McpServerConfig{Type: "http", URL: server.URL})
	if err == nil {
		t.Fatal("expected Connect to fail against a 401 server")
	}
	if !strings.Contains(err.Error(), "ion mcp login needs-auth") {
		t.Errorf("connect error must name the remediation, got %q", err)
	}
}

// TestBeginLogin_ReusesRegisteredRedirectPort pins that a second login presents
// the same redirect URI the client was registered with. RFC 7591 binds it, so a
// fresh ephemeral port would be rejected by a provider that validates strictly.
func TestBeginLogin_ReusesRegisteredRedirectPort(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	fix := newAuthServerFixture(t)

	first, err := BeginLogin("srv", fix.config(), "")
	if err != nil {
		t.Fatalf("first BeginLogin: %v", err)
	}
	firstURI := mustRedirectURI(t, first.AuthorizationURL)
	first.Cancel()

	second, err := BeginLogin("srv", fix.config(), "")
	if err != nil {
		t.Fatalf("second BeginLogin: %v", err)
	}
	defer second.Cancel()
	secondURI := mustRedirectURI(t, second.AuthorizationURL)

	if firstURI != secondURI {
		t.Errorf("redirect_uri changed between logins: %q then %q; the registered URI must be reused", firstURI, secondURI)
	}
}

func mustRedirectURI(t *testing.T, authorizationURL string) string {
	t.Helper()
	parsed, err := url.Parse(authorizationURL)
	if err != nil {
		t.Fatalf("parse authorization url: %v", err)
	}
	return parsed.Query().Get("redirect_uri")
}

// TestBeginLogin_ScopeOverride pins that an operator-supplied scope reaches the
// authorization request instead of the discovered default.
func TestBeginLogin_ScopeOverride(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	fix := newAuthServerFixture(t)

	login, err := BeginLogin("srv", fix.config(), "openid profile email")
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	defer login.Cancel()

	parsed, err := url.Parse(login.AuthorizationURL)
	if err != nil {
		t.Fatalf("parse authorization url: %v", err)
	}
	if got := parsed.Query().Get("scope"); got != "openid profile email" {
		t.Errorf("scope = %q, want the override", got)
	}
}

// TestBeginLogin_TokenExchangeFailureReportsError pins that a rejected exchange
// surfaces on Err and leaves NO token behind — a half-completed login that
// looked authenticated would 401 on every later call with no explanation.
func TestBeginLogin_TokenExchangeFailureReportsError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	fix := newAuthServerFixture(t)
	fix.mu.Lock()
	fix.tokenCode = http.StatusBadRequest
	fix.tokenResp = map[string]any{"error": "invalid_grant", "error_description": "code already used"}
	fix.mu.Unlock()

	login, err := BeginLogin("srv", fix.config(), "")
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	defer login.Cancel()

	completeCallback(t, login.AuthorizationURL, "stale-code")

	select {
	case <-login.Done:
		t.Fatal("login reported success despite a rejected token exchange")
	case loginErr := <-login.Err:
		if !strings.Contains(loginErr.Error(), "invalid_grant") &&
			!strings.Contains(loginErr.Error(), "400") {
			t.Errorf("error should carry the provider's rejection, got %v", loginErr)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("login neither completed nor failed")
	}

	if getOAuthStore().GetToken("srv") != nil {
		t.Error("a failed exchange must leave no token in the store")
	}
	if IsAuthenticated("srv") {
		t.Error("IsAuthenticated must stay false after a failed login")
	}
}

// TestBeginLogin_StateMismatchIsRejected pins CSRF protection on the callback:
// a code delivered with the wrong state must not be exchanged.
func TestBeginLogin_StateMismatchIsRejected(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	fix := newAuthServerFixture(t)

	login, err := BeginLogin("srv", fix.config(), "")
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	defer login.Cancel()

	redirectURI := mustRedirectURI(t, login.AuthorizationURL)
	resp, err := http.Get(redirectURI + "?code=injected&state=attacker") //nolint:gosec // fixture URL from the flow's own redirect_uri
	if err != nil {
		t.Fatalf("drive callback: %v", err)
	}
	if closeErr := resp.Body.Close(); closeErr != nil {
		t.Errorf("close response: %v", closeErr)
	}

	select {
	case <-login.Done:
		t.Fatal("login completed on a state mismatch")
	case <-login.Err:
		// Expected.
	case <-time.After(10 * time.Second):
		t.Fatal("state mismatch produced neither completion nor error")
	}
	if getOAuthStore().GetToken("srv") != nil {
		t.Error("a state mismatch must leave no token in the store")
	}
}

// TestLogout_DropsTokenAndRegistration pins that logout forgets the client_id
// too. Leaving it would silently reuse a client the operator believes they
// revoked.
func TestLogout_DropsTokenAndRegistration(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	fix := newAuthServerFixture(t)

	login, err := BeginLogin("srv", fix.config(), "")
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	defer login.Cancel()
	completeCallback(t, login.AuthorizationURL, "code-for-logout")
	select {
	case <-login.Done:
	case loginErr := <-login.Err:
		t.Fatalf("login failed: %v", loginErr)
	case <-time.After(10 * time.Second):
		t.Fatal("login did not complete")
	}

	if getClientStore().Get("srv") == nil {
		t.Fatal("precondition: registration should be stored after login")
	}

	Logout("srv")

	if getOAuthStore().GetToken("srv") != nil {
		t.Error("logout must delete the token")
	}
	if getClientStore().Get("srv") != nil {
		t.Error("logout must delete the client registration")
	}
	if IsAuthenticated("srv") {
		t.Error("IsAuthenticated must be false after logout")
	}
}

// TestResolveClient_ExplicitConfigWins pins the precedence rule: an operator's
// oauth block beats a stored dynamic registration.
func TestResolveClient_ExplicitConfigWins(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	getClientStore().Set("srv", &ClientRegistration{
		ClientID: "stored-client",
		AuthURL:  "https://stored.example.test/authorize",
		TokenURL: "https://stored.example.test/token",
	})

	reg, err := ResolveClient("srv", types.McpServerConfig{
		Type: "http", URL: "https://api.example.test/mcp",
		OAuth: &types.McpOAuthConfig{
			ClientID: "configured-client",
			AuthURL:  "https://configured.example.test/authorize",
			TokenURL: "https://configured.example.test/token",
			Scope:    "custom",
		},
	}, "", "http://127.0.0.1:5000/mcp/callback")
	if err != nil {
		t.Fatalf("ResolveClient: %v", err)
	}
	if reg.ClientID != "configured-client" {
		t.Errorf("client id = %q, want the operator's configured client", reg.ClientID)
	}
	if reg.Scope != "custom" {
		t.Errorf("scope = %q, want the configured scope", reg.Scope)
	}
}

// TestResolveClient_StoredRegistrationBeatsFreshRegistration pins that a stored
// client is reused without contacting the provider.
func TestResolveClient_StoredRegistrationBeatsFreshRegistration(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	getClientStore().Set("srv", &ClientRegistration{
		ClientID: "stored-client",
		AuthURL:  "https://stored.example.test/authorize",
		TokenURL: "https://stored.example.test/token",
		Scope:    "openid",
	})

	// A URL that would fail discovery: reaching it at all is the failure.
	reg, err := ResolveClient("srv", types.McpServerConfig{
		Type: "http", URL: "http://127.0.0.1:1/mcp",
	}, "", "http://127.0.0.1:5000/mcp/callback")
	if err != nil {
		t.Fatalf("ResolveClient: %v", err)
	}
	if reg.ClientID != "stored-client" {
		t.Errorf("client id = %q; the stored registration must be reused without discovery", reg.ClientID)
	}
}

// TestResolveClient_ConfiguredClientIDDiscoversMissingEndpoints pins the hybrid
// path: a client_id with no endpoints is completed by discovery rather than
// forcing the operator to hand-write three URLs.
func TestResolveClient_ConfiguredClientIDDiscoversMissingEndpoints(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	fix := newAuthServerFixture(t)

	reg, err := ResolveClient("srv", types.McpServerConfig{
		Type: "http", URL: fix.server.URL + "/mcp",
		OAuth: &types.McpOAuthConfig{ClientID: "configured-only"},
	}, "", "http://127.0.0.1:5000/mcp/callback")
	if err != nil {
		t.Fatalf("ResolveClient: %v", err)
	}
	if reg.ClientID != "configured-only" {
		t.Errorf("client id = %q, want the configured client", reg.ClientID)
	}
	if reg.AuthURL != fix.server.URL+"/authorize" || reg.TokenURL != fix.server.URL+"/token" {
		t.Errorf("endpoints not filled from discovery: %+v", reg)
	}
}

// TestResolveClient_NoURLIsAnError pins that a stdio server cannot be logged
// into: there is no endpoint to discover or authorize against.
func TestResolveClient_NoURLIsAnError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	_, err := ResolveClient("srv", types.McpServerConfig{Type: "stdio", Command: "cat"}, "", "http://127.0.0.1:5000/mcp/callback")
	if err == nil {
		t.Fatal("expected an error for a server with no url")
	}
	if !strings.Contains(err.Error(), "http/sse/ws") {
		t.Errorf("error should explain which transports support login, got %q", err)
	}
}

func TestPortFromRedirectURI(t *testing.T) {
	cases := []struct {
		uri  string
		want int
	}{
		{"http://127.0.0.1:51234/mcp/callback", 51234},
		{"http://127.0.0.1:8080/", 8080},
		{"http://127.0.0.1/callback", 0},
		{"", 0},
		{"http://127.0.0.1:notaport/x", 0},
		{"http://127.0.0.1:99999/x", 0},
	}
	for _, tc := range cases {
		if got := portFromRedirectURI(tc.uri); got != tc.want {
			t.Errorf("portFromRedirectURI(%q) = %d, want %d", tc.uri, got, tc.want)
		}
	}
}

// TestTokenFromGrant_MissingExpiryGetsFallback pins that a grant with no
// expires_in does not land as the zero time, which IsExpired would read as
// already-expired and would make every request attempt a doomed refresh.
func TestTokenFromGrant_MissingExpiryGetsFallback(t *testing.T) {
	token := tokenFromGrant(&auth.TokenResponse{AccessToken: "a", RefreshToken: "r"})
	if token.ExpiresAt.IsZero() {
		t.Fatal("expiry must not be the zero time")
	}
	if IsExpired(token) {
		t.Error("a fresh token with no expires_in must not read as expired")
	}
	if token.TokenType != "Bearer" {
		t.Errorf("token type = %q, want a Bearer default", token.TokenType)
	}
}

// TestAnnotateAuthFailure_NamesRemediation pins that a 401 at connect time
// carries the command that fixes it. The engine is headless; this log line is
// the operator's only window into a server whose tools all vanished.
func TestAnnotateAuthFailure_NamesRemediation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	cfg := types.McpServerConfig{Type: "http", URL: "http://127.0.0.1:1/mcp"}
	err := annotateAuthFailure("mobbin", cfg, fmt.Errorf("mcp initialize mobbin: HTTP error (status 401): unauthorized"))
	if err == nil {
		t.Fatal("expected the error to be returned")
	}
	if !strings.Contains(err.Error(), "ion mcp login mobbin") {
		t.Errorf("error must name the remediation command, got %q", err)
	}
	// The original error text must survive so the underlying cause is not lost.
	if !strings.Contains(err.Error(), "status 401") {
		t.Errorf("error must still wrap the original failure, got %q", err)
	}
}

// TestAnnotateAuthFailure_AuthenticatedSuggestsReauth pins the distinction: an
// operator who already logged in must not be told to run the command they just
// ran — a rejected stored token needs logout-then-login.
func TestAnnotateAuthFailure_AuthenticatedSuggestsReauth(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	getOAuthStore().SetToken("srv", &OAuthToken{
		AccessToken: "stale", TokenType: "Bearer", ExpiresAt: time.Now().Add(time.Hour),
	})

	err := annotateAuthFailure("srv", types.McpServerConfig{Type: "http"},
		fmt.Errorf("mcp list tools srv: HTTP error (status 403): insufficient scope"))
	if !strings.Contains(err.Error(), "ion mcp logout srv") {
		t.Errorf("a rejected stored token must suggest re-authorization, got %q", err)
	}
}

// TestAnnotateAuthFailure_PassesThroughNonAuthErrors pins that unrelated
// failures are not decorated with a misleading login instruction.
func TestAnnotateAuthFailure_PassesThroughNonAuthErrors(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	original := fmt.Errorf("mcp initialize srv: receive: EOF")
	got := annotateAuthFailure("srv", types.McpServerConfig{Type: "http"}, original)
	if got.Error() != original.Error() {
		t.Errorf("non-auth error was modified: %q", got)
	}
	if annotateAuthFailure("srv", types.McpServerConfig{}, nil) != nil {
		t.Error("nil error must pass through as nil")
	}
}

func TestIsAuthRejection(t *testing.T) {
	cases := map[string]bool{
		"HTTP error (status 401): nope":     true,
		"HTTP error (status 403): no scope": true,
		"rpc error -32001: invalid_token":   true,
		"receive: EOF":                      false,
		"mcp call tools/list: timeout":      false,
	}
	for msg, want := range cases {
		if got := isAuthRejection(fmt.Errorf("%s", msg)); got != want {
			t.Errorf("isAuthRejection(%q) = %v, want %v", msg, got, want)
		}
	}
}
