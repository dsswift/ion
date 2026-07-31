package mcp

// oauth_grant_error_test.go — pins the permanent-vs-transient refresh
// classification.
//
// Motivating incident: an operator's Supabase grant was consumed, and two days
// later every session failed with a generic "refresh token failed with status
// 400: {...refresh_token_already_used...}". The engine was correct, the grant was
// dead, and nothing in the message said that re-authorizing was the fix — so the
// natural reading was "transient, try later", which never resolves.

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// supabaseAlreadyUsedBody is the verbatim body Supabase returned in the real
// incident. Pinning the literal keeps the classifier honest about the shape it
// was built for: the reason lives in `error_code`, not the RFC 6749 `error`.
const supabaseAlreadyUsedBody = `{"code":400,"error_code":"refresh_token_already_used","msg":"Invalid Refresh Token: Already Used"}`

func TestClassifyGrantFailure_Cases(t *testing.T) {
	cases := []struct {
		label             string
		status            int
		body              string
		wantCode          string
		wantUnrecoverable bool
	}{
		{
			label:             "supabase refresh token already used",
			status:            400,
			body:              supabaseAlreadyUsedBody,
			wantCode:          "refresh_token_already_used",
			wantUnrecoverable: true,
		},
		{
			label:             "rfc 6749 invalid_grant",
			status:            400,
			body:              `{"error":"invalid_grant","error_description":"Refresh token expired"}`,
			wantCode:          "invalid_grant",
			wantUnrecoverable: true,
		},
		{
			label:             "client registration gone",
			status:            401,
			body:              `{"error":"invalid_client","error_description":"Client not found"}`,
			wantCode:          "invalid_client",
			wantUnrecoverable: true,
		},
		{
			label:  "server error is transient",
			status: 500,
			body:   `{"error":"server_error"}`,
			// A 5xx says nothing about the grant, so retrying is the right move.
			wantCode:          "server_error",
			wantUnrecoverable: false,
		},
		{
			label:             "bad gateway with an html body is transient",
			status:            502,
			body:              `<html><body>Bad Gateway</body></html>`,
			wantCode:          "",
			wantUnrecoverable: false,
		},
		{
			label:  "rate limited is transient",
			status: 429,
			body:   `{"error":"slow_down"}`,
			// Not in the unrecoverable set, so the next attempt may well work.
			wantCode:          "slow_down",
			wantUnrecoverable: false,
		},
		{
			label:  "opaque 401 is treated as unrecoverable",
			status: 401,
			body:   ``,
			// The endpoint refused the credential and offered no reason; assuming
			// it is retryable would loop forever on a dead grant.
			wantCode:          "",
			wantUnrecoverable: true,
		},
		{
			label:             "opaque 400 is not assumed fatal",
			status:            400,
			body:              `something unparseable`,
			wantCode:          "",
			wantUnrecoverable: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			got := classifyGrantFailure("srv", tc.status, []byte(tc.body))
			if got.Code != tc.wantCode {
				t.Errorf("code = %q, want %q", got.Code, tc.wantCode)
			}
			if got.Unrecoverable != tc.wantUnrecoverable {
				t.Errorf("unrecoverable = %v, want %v", got.Unrecoverable, tc.wantUnrecoverable)
			}
			if errors.Is(got, ErrGrantUnrecoverable) != tc.wantUnrecoverable {
				t.Errorf("errors.Is(ErrGrantUnrecoverable) = %v, want %v",
					errors.Is(got, ErrGrantUnrecoverable), tc.wantUnrecoverable)
			}
		})
	}
}

// TestGrantError_UnrecoverableMessageNamesRemediation pins that the permanent
// case carries the command, and the transient case does not — telling an operator
// to re-login over a 500 would send them to do unnecessary work.
func TestGrantError_UnrecoverableMessageNamesRemediation(t *testing.T) {
	dead := classifyGrantFailure("mobbin", 400, []byte(supabaseAlreadyUsedBody))
	msg := dead.Error()
	if !strings.Contains(msg, "ion mcp login mobbin") {
		t.Errorf("unrecoverable message must name the remediation, got %q", msg)
	}
	if !strings.Contains(msg, "refresh_token_already_used") {
		t.Errorf("message must carry the provider's code, got %q", msg)
	}
	if !strings.Contains(msg, "Already Used") {
		t.Errorf("message must carry the provider's description, got %q", msg)
	}

	transient := classifyGrantFailure("mobbin", 503, []byte(`{"error":"server_error"}`))
	if strings.Contains(transient.Error(), "ion mcp login") {
		t.Errorf("a transient failure must not advise re-authorizing, got %q", transient.Error())
	}
}

// TestClassifyGrantFailure_PreservesUnparseableBody pins that classification
// never loses information: an unrecognized body still reaches the operator.
func TestClassifyGrantFailure_PreservesUnparseableBody(t *testing.T) {
	got := classifyGrantFailure("srv", 400, []byte("upstream connect error"))
	if !strings.Contains(got.Error(), "upstream connect error") {
		t.Errorf("error must retain an unparseable body, got %q", got.Error())
	}
}

// grantFixture serves a token endpoint that fails with a chosen status/body, plus
// an MCP endpoint that rejects everything (a server whose auth is broken).
func grantFixture(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if _, err := w.Write([]byte(body)); err != nil {
			t.Errorf("write token error body: %v", err)
		}
	})
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		if _, err := w.Write([]byte(`{"error":"unauthorized"}`)); err != nil {
			t.Errorf("write 401: %v", err)
		}
	})
	return server
}

func seedExpiredGrant(server *httptest.Server) {
	getOAuthStore().SetToken("srv", &OAuthToken{
		AccessToken: "stale", RefreshToken: "rt-spent", TokenType: "bearer",
		ExpiresAt: time.Now().Add(-time.Hour),
	})
	getClientStore().Set("srv", &ClientRegistration{
		ClientID: "c1", AuthURL: server.URL + "/authorize", TokenURL: server.URL + "/token",
	})
}

// TestRefreshToken_ReturnsUnrecoverableGrantError pins the store-level contract:
// a spent grant returns a typed error callers can branch on.
func TestRefreshToken_ReturnsUnrecoverableGrantError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	server := grantFixture(t, http.StatusBadRequest, supabaseAlreadyUsedBody)
	seedExpiredGrant(server)

	_, err := getOAuthStore().RefreshToken("srv", &OAuthConfig{
		ClientID: "c1", TokenURL: server.URL + "/token",
	})
	if err == nil {
		t.Fatal("expected an error for a spent refresh token")
	}
	if !errors.Is(err, ErrGrantUnrecoverable) {
		t.Errorf("error must satisfy errors.Is(ErrGrantUnrecoverable), got %v", err)
	}
	var grantErr *GrantError
	if !errors.As(err, &grantErr) {
		t.Fatalf("error must be a *GrantError, got %T", err)
	}
	if grantErr.Code != "refresh_token_already_used" {
		t.Errorf("code = %q", grantErr.Code)
	}
}

// TestConnectError_CitesDeadGrant is the operator-facing regression: the connect
// failure must say the authorization died, not merely that the server "requires
// authorization" — which reads as though it was never set up.
func TestConnectError_CitesDeadGrant(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	server := grantFixture(t, http.StatusBadRequest, supabaseAlreadyUsedBody)
	seedExpiredGrant(server)

	_, err := Connect("srv", types.McpServerConfig{Type: "http", URL: server.URL + "/mcp"})
	if err == nil {
		t.Fatal("expected Connect to fail")
	}
	msg := err.Error()
	if !strings.Contains(msg, "can no longer be renewed") {
		t.Errorf("connect error must say the authorization died, got %q", msg)
	}
	if !strings.Contains(msg, "refresh_token_already_used") {
		t.Errorf("connect error must cite the provider's reason, got %q", msg)
	}
	if !strings.Contains(msg, "ion mcp login srv") {
		t.Errorf("connect error must name the remediation, got %q", msg)
	}
}

// TestGrantExpiredReason_ReportedToConsumers pins the accessor clients read to
// distinguish "never authorized" from "authorization died".
func TestGrantExpiredReason_ReportedToConsumers(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	if reason := GrantExpiredReason("srv"); reason != "" {
		t.Errorf("a server that never failed must report no reason, got %q", reason)
	}

	server := grantFixture(t, http.StatusBadRequest, supabaseAlreadyUsedBody)
	seedExpiredGrant(server)
	if _, err := getOAuthStore().RefreshToken("srv", &OAuthConfig{ClientID: "c1", TokenURL: server.URL + "/token"}); err == nil {
		t.Fatal("precondition: refresh should fail")
	}

	if reason := GrantExpiredReason("srv"); reason != "refresh_token_already_used" {
		t.Errorf("reason = %q, want the provider's code", reason)
	}
}

// TestTransientFailureIsNotRecordedAsDead pins that a 500 does not mark the grant
// dead. Misclassifying a blip would tell the operator to re-authorize a
// perfectly good credential.
func TestTransientFailureIsNotRecordedAsDead(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	server := grantFixture(t, http.StatusInternalServerError, `{"error":"server_error"}`)
	seedExpiredGrant(server)

	_, err := getOAuthStore().RefreshToken("srv", &OAuthConfig{ClientID: "c1", TokenURL: server.URL + "/token"})
	if err == nil {
		t.Fatal("expected an error")
	}
	if errors.Is(err, ErrGrantUnrecoverable) {
		t.Error("a 5xx must not be classified as an unrecoverable grant")
	}
	if reason := GrantExpiredReason("srv"); reason != "" {
		t.Errorf("a transient failure must not be recorded as a dead grant, got %q", reason)
	}
}

// TestSuccessfulRefreshClearsRecordedFailure pins that a recovered grant stops
// reporting as dead — otherwise a stale reason outlives the problem and the
// operator is told to re-login for no cause.
func TestSuccessfulRefreshClearsRecordedFailure(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	var fail = true
	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	defer server.Close()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if fail {
			w.WriteHeader(http.StatusBadRequest)
			if _, err := w.Write([]byte(supabaseAlreadyUsedBody)); err != nil {
				t.Errorf("write: %v", err)
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"access_token": "recovered", "refresh_token": "rt-new",
			"token_type": "bearer", "expires_in": 3600,
		}); err != nil {
			t.Errorf("encode: %v", err)
		}
	})

	cfg := &OAuthConfig{ClientID: "c1", TokenURL: server.URL + "/token"}
	getOAuthStore().SetToken("srv", &OAuthToken{
		AccessToken: "stale", RefreshToken: "rt", TokenType: "bearer",
		ExpiresAt: time.Now().Add(-time.Hour),
	})

	if _, err := getOAuthStore().RefreshToken("srv", cfg); err == nil {
		t.Fatal("precondition: first refresh should fail")
	}
	if GrantExpiredReason("srv") == "" {
		t.Fatal("precondition: failure should be recorded")
	}

	// The operator re-authorizes (or the provider recovers).
	fail = false
	if _, err := getOAuthStore().RefreshToken("srv", cfg); err != nil {
		t.Fatalf("second refresh: %v", err)
	}
	if reason := GrantExpiredReason("srv"); reason != "" {
		t.Errorf("a successful refresh must clear the recorded failure, got %q", reason)
	}
}

// TestLogoutClearsRecordedFailure pins the same for an explicit logout: a
// freshly-logged-out server is not a broken one.
func TestLogoutClearsRecordedFailure(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	server := grantFixture(t, http.StatusBadRequest, supabaseAlreadyUsedBody)
	seedExpiredGrant(server)
	if _, err := getOAuthStore().RefreshToken("srv", &OAuthConfig{ClientID: "c1", TokenURL: server.URL + "/token"}); err == nil {
		t.Fatal("precondition: refresh should fail")
	}
	if GrantExpiredReason("srv") == "" {
		t.Fatal("precondition: failure should be recorded")
	}

	Logout("srv")

	if reason := GrantExpiredReason("srv"); reason != "" {
		t.Errorf("logout must clear the recorded failure, got %q", reason)
	}
}
