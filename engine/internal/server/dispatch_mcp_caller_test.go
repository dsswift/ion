package server

// dispatch_mcp_caller_test.go — mcp_login with a caller-owned redirect and
// mcp_login_complete, driven over the wire.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// newCallerLoginAuthServer serves discovery, dynamic registration, and a token
// endpoint that issues a grant for any code.
func newCallerLoginAuthServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	authSrv := httptest.NewServer(mux)
	t.Cleanup(authSrv.Close)
	encode := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(v); err != nil {
			t.Errorf("encode fixture response: %v", err)
		}
	}
	mux.HandleFunc("/.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, r *http.Request) {
		encode(w, map[string]any{"resource": authSrv.URL + "/mcp", "authorization_servers": []string{authSrv.URL}})
	})
	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		encode(w, map[string]any{
			"issuer":                           authSrv.URL,
			"authorization_endpoint":           authSrv.URL + "/authorize",
			"token_endpoint":                   authSrv.URL + "/token",
			"registration_endpoint":            authSrv.URL + "/register",
			"code_challenge_methods_supported": []string{"S256"},
		})
	})
	mux.HandleFunc("/register", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		encode(w, map[string]any{"client_id": "dcr-client"})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		encode(w, map[string]any{"access_token": "access-1", "refresh_token": "refresh-1", "token_type": "bearer", "expires_in": 3600})
	})
	return authSrv
}

// resultLine returns the result frame for a request id.
func resultLine(lines []string, requestID string) string {
	for _, l := range lines {
		if strings.Contains(l, `"`+requestID+`"`) {
			return l
		}
	}
	return ""
}

func TestDispatchMcpLogin_CallerRedirectThenComplete(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	authSrv := newCallerLoginAuthServer(t)

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]any{"cmd": "mcp_add", "requestId": "req-add", "mcpName": "remote", "mcpUrl": authSrv.URL + "/mcp"})
	readLines(t, conn, 2, 3*time.Second)

	const redirect = "ionremote://oauth/mcp"
	sendJSON(t, conn, map[string]any{"cmd": "mcp_login", "requestId": "req-login", "mcpName": "remote", "mcpRedirectUri": redirect})
	lines := readLines(t, conn, 2, 5*time.Second)
	evt := findMcpEvent(t, lines, types.EventMcpLoginURL)
	if evt == nil {
		t.Fatalf("no engine_mcp_login_url event, lines: %v", lines)
	}
	authURL, err := url.Parse(evt.McpAuthorizationURL)
	if err != nil {
		t.Fatalf("parse authorization url: %v", err)
	}
	if got := authURL.Query().Get("redirect_uri"); got != redirect {
		t.Fatalf("redirect_uri = %q, want %q", got, redirect)
	}
	if !strings.Contains(resultLine(lines, "req-login"), "authorizationUrl") {
		t.Errorf("login result carries no authorizationUrl: %v", lines)
	}

	callback := redirect + "?code=abc&state=" + url.QueryEscape(authURL.Query().Get("state"))
	sendJSON(t, conn, map[string]any{"cmd": "mcp_login_complete", "requestId": "req-complete", "mcpName": "remote", "mcpCallbackUrl": callback})
	lines = readLines(t, conn, 2, 5*time.Second)

	if res := resultLine(lines, "req-complete"); res == "" || strings.Contains(res, `"error"`) {
		t.Fatalf("complete result = %q, want success; lines: %v", res, lines)
	}
	snap := findMcpEvent(t, lines, types.EventMcpServers)
	if snap == nil || len(snap.McpServers) != 1 || !snap.McpServers[0].Authenticated {
		t.Fatalf("snapshot after completion = %+v, want the server authenticated", snap)
	}
}

func TestDispatchMcpLoginComplete_NothingPendingIsAnError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]any{"cmd": "mcp_login_complete", "requestId": "req-complete", "mcpName": "ghost", "mcpCallbackUrl": "ionremote://oauth/mcp?code=c&state=s"})
	lines := readLines(t, conn, 2, 3*time.Second)
	if res := resultLine(lines, "req-complete"); !strings.Contains(res, "no sign-in is pending") {
		t.Errorf("result = %q, want a no-pending error", res)
	}
}

func TestDispatchMcpLoginComplete_CallbackRequiredAtTheWire(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]any{"cmd": "mcp_login_complete", "requestId": "req-complete", "mcpName": "srv"})
	lines := readLines(t, conn, 1, 2*time.Second)
	if res := resultLine(lines, "req-complete"); !strings.Contains(res, "invalid command") {
		t.Errorf("result = %q, want a wire-level rejection", res)
	}
}
