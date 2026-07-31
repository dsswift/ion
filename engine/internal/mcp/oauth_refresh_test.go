package mcp

// oauth_refresh_test.go — regression pins for mid-session token expiry.
//
// The defect these cover: the Authorization header was resolved once at Connect
// and then frozen into the transport. An MCP access token routinely outlives
// nothing — Mobbin's last an hour — so a conversation open longer than that sent
// a stale token on every request, the server answered 401, and the stored
// refresh token was never used. The failure needed a session restart to clear,
// which is exactly what a refresh token exists to avoid.
//
// The operator-token path already resolved per request for this reason. These
// tests hold the OAuth path to the same standard.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// refreshFixture is an MCP server that also serves a token endpoint, and which
// only accepts whatever token it most recently issued. Presenting a superseded
// token gets a 401, the way a real provider behaves after rotation.
type refreshFixture struct {
	server        *httptest.Server
	mu            sync.Mutex
	acceptedToken string
	refreshCalls  atomic.Int64
	toolCalls     atomic.Int64
	authFailures  atomic.Int64
	// refreshStatus, when non-zero, makes the token endpoint fail with it.
	refreshStatus atomic.Int64
}

func newRefreshFixture(t *testing.T, initialAccepted string) *refreshFixture {
	t.Helper()
	fix := &refreshFixture{acceptedToken: initialAccepted}

	mux := http.NewServeMux()
	fix.server = httptest.NewServer(mux)
	t.Cleanup(fix.server.Close)

	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		fix.refreshCalls.Add(1)
		if status := fix.refreshStatus.Load(); status != 0 {
			w.WriteHeader(int(status))
			if _, err := w.Write([]byte(`{"error":"invalid_grant"}`)); err != nil {
				t.Errorf("write refresh error: %v", err)
			}
			return
		}
		issued := "rotated-" + time.Now().Format("150405.000000000")
		fix.mu.Lock()
		fix.acceptedToken = issued
		fix.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"access_token": issued, "refresh_token": "rt-next",
			"token_type": "bearer", "expires_in": 3600,
		}); err != nil {
			t.Errorf("encode token response: %v", err)
		}
	})

	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		fix.mu.Lock()
		accepted := fix.acceptedToken
		fix.mu.Unlock()

		if r.Header.Get("Authorization") != "Bearer "+accepted {
			fix.authFailures.Add(1)
			w.WriteHeader(http.StatusUnauthorized)
			if _, err := w.Write([]byte(`{"error":"invalid_token"}`)); err != nil {
				t.Errorf("write 401: %v", err)
			}
			return
		}

		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode rpc: %v", err)
			return
		}
		result := map[string]any{}
		switch req.Method {
		case "tools/list":
			result["tools"] = []map[string]any{
				{"name": "search", "description": "d", "inputSchema": map[string]any{"type": "object"}},
			}
		case "tools/call":
			fix.toolCalls.Add(1)
			result["content"] = []map[string]any{{"type": "text", "text": "tool ok"}}
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result}); err != nil {
			t.Errorf("encode rpc response: %v", err)
		}
	})

	return fix
}

// seedStores installs a token with the given expiry plus the client
// registration that supplies the refresh endpoint.
func (f *refreshFixture) seedStores(accessToken string, expiresAt time.Time) {
	getOAuthStore().SetToken("srv", &OAuthToken{
		AccessToken: accessToken, RefreshToken: "rt-1", TokenType: "bearer",
		ExpiresAt: expiresAt,
	})
	getClientStore().Set("srv", &ClientRegistration{
		ClientID: "c1",
		AuthURL:  f.server.URL + "/authorize",
		TokenURL: f.server.URL + "/token",
	})
}

func (f *refreshFixture) config() types.McpServerConfig {
	return types.McpServerConfig{Type: "http", URL: f.server.URL + "/mcp"}
}

// TestTokenExpiresMidSession_ToolCallStillSucceeds is the regression test for the
// reported behavior: a session connects with a valid token, the token expires
// while the conversation is still open, and the next tool call must still work.
//
// On the unfixed transport the header was frozen at connect and this call
// returned 401 invalid_token.
func TestTokenExpiresMidSession_ToolCallStillSucceeds(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	fix := newRefreshFixture(t, "original")
	// Valid for now — the connection is established cleanly.
	fix.seedStores("original", time.Now().Add(50*time.Minute))

	conn, err := Connect("srv", fix.config())
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer func() {
		if closeErr := conn.Close(); closeErr != nil {
			t.Errorf("close: %v", closeErr)
		}
	}()
	if fix.refreshCalls.Load() != 0 {
		t.Fatalf("precondition: a valid token must not trigger a refresh, got %d", fix.refreshCalls.Load())
	}

	// An hour passes. Rewrite the stored expiry to the past, which is what the
	// clock advancing does to a real stored token.
	fix.seedStores("original", time.Now().Add(-1*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := conn.CallTool(ctx, "search", map[string]interface{}{"q": "x"})
	if err != nil {
		t.Fatalf("tool call after token expiry failed; the refresh token was not used: %v", err)
	}
	if out != "tool ok" {
		t.Errorf("tool output = %q", out)
	}
	if fix.refreshCalls.Load() == 0 {
		t.Error("expected a token refresh before the request")
	}
	if fix.authFailures.Load() != 0 {
		t.Errorf("server saw %d rejected request(s); the refresh must happen BEFORE the request, not after a 401", fix.authFailures.Load())
	}
}

// TestRevokedTokenRetriedOnce covers the other half: the stored token is not yet
// expired by the engine's reckoning, but the provider rejects it anyway (revoked
// or rotated elsewhere). The transport must refresh and retry once rather than
// surfacing the 401.
func TestRevokedTokenRetriedOnce(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	fix := newRefreshFixture(t, "original")
	fix.seedStores("original", time.Now().Add(50*time.Minute))

	conn, err := Connect("srv", fix.config())
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer func() {
		if closeErr := conn.Close(); closeErr != nil {
			t.Errorf("close: %v", closeErr)
		}
	}()

	// The provider rotates the accepted token out from under us. The engine's
	// stored expiry still says the old one is good, so only a retry can recover.
	fix.mu.Lock()
	fix.acceptedToken = "server-side-rotation"
	fix.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := conn.CallTool(ctx, "search", map[string]interface{}{"q": "x"})
	if err != nil {
		t.Fatalf("tool call with a revoked token failed; expected a refresh-and-retry: %v", err)
	}
	if out != "tool ok" {
		t.Errorf("tool output = %q", out)
	}
	if fix.authFailures.Load() != 1 {
		t.Errorf("server saw %d rejections, want exactly 1 (the initial attempt)", fix.authFailures.Load())
	}
	if fix.refreshCalls.Load() != 1 {
		t.Errorf("refresh called %d times, want exactly 1", fix.refreshCalls.Load())
	}
}

// TestAuthRejectionRetriedOnlyOnce pins the retry bound. When the grant itself is
// dead, a refresh succeeds but the server keeps refusing; the transport must not
// loop against the provider's token endpoint.
func TestAuthRejectionRetriedOnlyOnce(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	var requests atomic.Int64
	var refreshes atomic.Int64
	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	defer server.Close()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		refreshes.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"access_token": "still-no-good", "refresh_token": "rt", "token_type": "bearer", "expires_in": 3600,
		}); err != nil {
			t.Errorf("encode: %v", err)
		}
	})
	// Always 401, whatever token is presented.
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
	})

	getOAuthStore().SetToken("srv", &OAuthToken{
		AccessToken: "a", RefreshToken: "rt-1", TokenType: "bearer",
		ExpiresAt: time.Now().Add(time.Hour),
	})
	getClientStore().Set("srv", &ClientRegistration{
		ClientID: "c1", AuthURL: server.URL + "/authorize", TokenURL: server.URL + "/token",
	})

	_, err := Connect("srv", types.McpServerConfig{Type: "http", URL: server.URL + "/mcp"})
	if err == nil {
		t.Fatal("expected Connect to fail against a server that always rejects")
	}

	// Exactly two requests for the initialize attempt: the original and one retry.
	if got := requests.Load(); got != 2 {
		t.Errorf("server saw %d requests, want 2 (original + one retry)", got)
	}
	if got := refreshes.Load(); got != 1 {
		t.Errorf("token endpoint hit %d times, want 1; a retry loop would hammer the provider", got)
	}
}

// TestAuthRejectionWithoutCredentialsIsNotRetried pins that a server with no
// stored token — one that simply requires auth the operator never set up — is not
// retried. There is nothing to refresh, and a pointless second request would
// double the latency of every failure.
func TestAuthRejectionWithoutCredentialsIsNotRetried(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	// Count only MCP requests. A 401 at connect also triggers discovery probes
	// (annotateAuthFailure enriches the error with the authorization server), and
	// a catch-all counter would tally those as retries.
	var requests atomic.Int64
	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	defer server.Close()
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})

	_, err := Connect("no-creds", types.McpServerConfig{Type: "http", URL: server.URL + "/mcp"})
	if err == nil {
		t.Fatal("expected Connect to fail")
	}
	// Exactly one request: the initialize attempt, with no retry after it.
	// (Connect would go on to listTools, but initialize failing aborts first, so
	// a second request here could only be a retry.)
	if got := requests.Load(); got != 1 {
		t.Errorf("server saw %d requests, want 1; there is no credential to refresh", got)
	}
	// And the error still names the remediation.
	if !strings.Contains(err.Error(), "ion mcp login no-creds") {
		t.Errorf("error should carry the remediation, got %q", err)
	}
}

// TestRefreshFailureSurfacesOriginalRejection pins that when the refresh itself
// fails (a revoked refresh token), the operator sees the server's rejection
// rather than a confusing refresh error in its place.
func TestRefreshFailureSurfacesOriginalRejection(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	fix := newRefreshFixture(t, "accepted-by-nobody")
	fix.refreshStatus.Store(http.StatusBadRequest)
	fix.seedStores("stale", time.Now().Add(time.Hour))

	_, err := Connect("srv", fix.config())
	if err == nil {
		t.Fatal("expected Connect to fail")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("error should carry the server's 401, got %q", err)
	}
	if fix.refreshCalls.Load() != 1 {
		t.Errorf("refresh attempted %d times, want 1", fix.refreshCalls.Load())
	}
}

// TestConcurrentRequestsRefreshOnce pins that parallel tool calls against an
// expired token perform ONE refresh. Providers rotate the refresh token on use,
// so concurrent refreshes race to invalidate each other and can log the operator
// out entirely.
func TestConcurrentRequestsRefreshOnce(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	fix := newRefreshFixture(t, "original")
	fix.seedStores("original", time.Now().Add(50*time.Minute))

	conn, err := Connect("srv", fix.config())
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer func() {
		if closeErr := conn.Close(); closeErr != nil {
			t.Errorf("close: %v", closeErr)
		}
	}()

	// Expire the token, then fire several resolutions at once. The transport
	// serializes RPCs, so the resolver is exercised directly here — that is where
	// the single-flight guarantee lives.
	fix.seedStores("original", time.Now().Add(-time.Minute))

	resolver := newTokenResolver("srv", nil)
	if resolver == nil {
		t.Fatal("expected a resolver for a server with a stored registration")
	}

	var wg sync.WaitGroup
	values := make([]string, 8)
	errs := make([]error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			values[idx], errs[idx] = resolver.Token()
		}(i)
	}
	wg.Wait()

	for i, resolveErr := range errs {
		if resolveErr != nil {
			t.Fatalf("resolution %d failed: %v", i, resolveErr)
		}
	}
	if got := fix.refreshCalls.Load(); got != 1 {
		t.Errorf("refresh called %d times for 8 concurrent resolutions, want 1", got)
	}
	// Every caller must see the same refreshed token.
	for i := 1; i < len(values); i++ {
		if values[i] != values[0] {
			t.Errorf("resolution %d returned %q, want %q — all callers share one token", i, values[i], values[0])
		}
	}
}

// TestValidTokenIsNotRefreshed pins that the happy path costs nothing: a token
// comfortably inside its lifetime is used as-is.
func TestValidTokenIsNotRefreshed(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	fix := newRefreshFixture(t, "original")
	fix.seedStores("original", time.Now().Add(50*time.Minute))

	conn, err := Connect("srv", fix.config())
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer func() {
		if closeErr := conn.Close(); closeErr != nil {
			t.Errorf("close: %v", closeErr)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := conn.CallTool(ctx, "search", map[string]interface{}{"q": "x"}); err != nil {
		t.Fatalf("tool call: %v", err)
	}
	if got := fix.refreshCalls.Load(); got != 0 {
		t.Errorf("refresh called %d times for a valid token, want 0", got)
	}
}

// TestBearerValueNormalizesTokenType pins the header rendering, including the
// lowercase "bearer" real providers return.
func TestBearerValueNormalizesTokenType(t *testing.T) {
	cases := map[string]string{
		"bearer": "Bearer t",
		"Bearer": "Bearer t",
		"":       "Bearer t",
		"BEARER": "BEARER t",
	}
	for tokenType, want := range cases {
		got := bearerValue(&OAuthToken{AccessToken: "t", TokenType: tokenType})
		if got != want {
			t.Errorf("token type %q rendered %q, want %q", tokenType, got, want)
		}
	}
}

// TestSSETransport_RefreshesTokenOnMessagePost pins that the SSE transport also
// re-resolves per message POST. Its stream GET necessarily carries the token
// current at stream open, but the send path must not pin an expired one.
func TestSSETransport_RefreshesTokenOnMessagePost(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	var refreshes atomic.Int64
	var postAuth atomic.Value
	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	defer server.Close()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		refreshes.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"access_token": "sse-fresh", "refresh_token": "rt", "token_type": "bearer", "expires_in": 3600,
		}); err != nil {
			t.Errorf("encode: %v", err)
		}
	})
	mux.HandleFunc("/message", func(w http.ResponseWriter, r *http.Request) {
		postAuth.Store(r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
	})

	getOAuthStore().SetToken("srv", &OAuthToken{
		AccessToken: "sse-stale", RefreshToken: "rt-1", TokenType: "bearer",
		ExpiresAt: time.Now().Add(-time.Minute), // already expired
	})
	getClientStore().Set("srv", &ClientRegistration{
		ClientID: "c1", AuthURL: server.URL + "/authorize", TokenURL: server.URL + "/token",
	})

	tr := &sseTransport{
		baseURL:    server.URL,
		client:     &http.Client{},
		msgCh:      make(chan json.RawMessage, 4),
		done:       make(chan struct{}),
		serverName: "srv",
		oauth:      newTokenResolver("srv", nil),
	}
	defer tr.Close() //nolint:errcheck // test cleanup

	if err := tr.Send(json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"ping"}`)); err != nil {
		t.Fatalf("Send: %v", err)
	}

	if refreshes.Load() != 1 {
		t.Errorf("refresh called %d times, want 1", refreshes.Load())
	}
	if got := postAuth.Load(); got != "Bearer sse-fresh" {
		t.Errorf("message POST Authorization = %v, want the refreshed token", got)
	}
}

// --- Multi-conversation token sharing ---
//
// The engine is one daemon hosting many conversations, and an MCP server's token
// is a single on-disk credential shared by all of them. These tests pin how that
// sharing behaves across conversation boundaries — the case a per-connection view
// gets wrong.

// TestSecondConversationReusesValidToken pins that opening another conversation
// while the token is still good mints nothing. The token is per SERVER, not per
// conversation, so a second connection is free.
func TestSecondConversationReusesValidToken(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	fix := newRefreshFixture(t, "original")
	fix.seedStores("original", time.Now().Add(45*time.Minute))

	first, err := Connect("srv", fix.config())
	if err != nil {
		t.Fatalf("first conversation: %v", err)
	}
	defer func() { _ = first.Close() }() //nolint:errcheck // test cleanup

	second, err := Connect("srv", fix.config())
	if err != nil {
		t.Fatalf("second conversation: %v", err)
	}
	defer func() { _ = second.Close() }() //nolint:errcheck // test cleanup

	if got := fix.refreshCalls.Load(); got != 0 {
		t.Errorf("refresh called %d times, want 0: a valid token is shared, not re-minted per conversation", got)
	}
}

// TestNewConversationAfterExpiryRefreshesAtConnect pins the cold-start case: the
// stored token expired with nothing running, and a brand-new conversation must
// recover on its own rather than requiring a manual re-login.
func TestNewConversationAfterExpiryRefreshesAtConnect(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	fix := newRefreshFixture(t, "original")
	fix.seedStores("original", time.Now().Add(-5*time.Minute)) // expired while idle

	conn, err := Connect("srv", fix.config())
	if err != nil {
		t.Fatalf("connect with an expired stored token: %v", err)
	}
	defer func() { _ = conn.Close() }() //nolint:errcheck // test cleanup

	if got := fix.refreshCalls.Load(); got != 1 {
		t.Errorf("refresh called %d times, want 1 at connect", got)
	}
	// The server never saw a bad credential: the refresh precedes the request.
	if got := fix.authFailures.Load(); got != 0 {
		t.Errorf("server rejected %d request(s); an expired token must be refreshed before use", got)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := conn.CallTool(ctx, "search", map[string]interface{}{}); err != nil {
		t.Fatalf("first tool call in a fresh conversation: %v", err)
	}
	if got := fix.refreshCalls.Load(); got != 1 {
		t.Errorf("refresh called %d times total, want 1: the connect-time refresh covers the first call", got)
	}
}

// TestConcurrentConversationsRefreshOnce is the regression test for a real defect
// found while answering exactly this question.
//
// The refresh lock originally lived on the tokenResolver. Resolvers are built per
// connection, so two conversations hitting the expired token at the same moment
// each refreshed independently — 3 refreshes for 2 conversations, measured. With a
// provider that rotates the refresh token on use (Supabase does), the second
// refresh presents a token the first just invalidated: one conversation ends up
// authorized and the other is silently logged out with no path back except a
// fresh `ion mcp login`. The lock is now keyed by server name, process-wide,
// which is the real scope of the shared credential.
func TestConcurrentConversationsRefreshOnce(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	fix := newRefreshFixture(t, "original")
	fix.seedStores("original", time.Now().Add(50*time.Minute))

	// Several conversations, each with its own connection and resolver.
	const conversations = 6
	conns := make([]*Connection, 0, conversations)
	for i := 0; i < conversations; i++ {
		conn, err := Connect("srv", fix.config())
		if err != nil {
			t.Fatalf("conversation %d: %v", i, err)
		}
		defer func(c *Connection) { _ = c.Close() }(conn) //nolint:errcheck // test cleanup
		conns = append(conns, conn)
	}
	if got := fix.refreshCalls.Load(); got != 0 {
		t.Fatalf("precondition: %d refreshes before expiry", got)
	}

	// The shared token expires. Every conversation calls a tool at once.
	fix.seedStores("original", time.Now().Add(-time.Minute))

	var wg sync.WaitGroup
	errs := make([]error, len(conns))
	for i, conn := range conns {
		wg.Add(1)
		go func(idx int, c *Connection) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			_, errs[idx] = c.CallTool(ctx, "search", map[string]interface{}{})
		}(i, conn)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("conversation %d failed: %v", i, err)
		}
	}
	if got := fix.refreshCalls.Load(); got != 1 {
		t.Errorf("refresh called %d times across %d concurrent conversations, want 1; "+
			"a provider that rotates refresh tokens would log the operator out", got, conversations)
	}
}

// TestForceRefreshAdoptsAnotherCallersToken pins the same protection on the
// rejection path: two conversations refused at once must not both refresh.
func TestForceRefreshAdoptsAnotherCallersToken(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	fix := newRefreshFixture(t, "original")
	fix.seedStores("original", time.Now().Add(time.Hour))

	resolverA := newTokenResolver("srv", nil)
	resolverB := newTokenResolver("srv", nil)
	if resolverA == nil || resolverB == nil {
		t.Fatal("expected resolvers for a server with a stored registration")
	}

	rejected := bearerValue(&OAuthToken{AccessToken: "original", TokenType: "bearer"})

	var wg sync.WaitGroup
	results := make([]string, 2)
	errs := make([]error, 2)
	for i, r := range []*tokenResolver{resolverA, resolverB} {
		wg.Add(1)
		go func(idx int, res *tokenResolver) {
			defer wg.Done()
			results[idx], errs[idx] = res.ForceRefresh(rejected)
		}(i, r)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("resolver %d ForceRefresh: %v", i, err)
		}
	}
	if got := fix.refreshCalls.Load(); got != 1 {
		t.Errorf("refresh called %d times for two simultaneous rejections, want 1", got)
	}
	if results[0] != results[1] {
		t.Errorf("resolvers disagree on the token (%q vs %q); both must converge on one credential", results[0], results[1])
	}
}
