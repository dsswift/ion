package mcp

// login_caller_test.go — caller-completed MCP login: the caller owns the
// redirect, the engine holds the pending login and finishes the exchange when
// handed the callback URL.

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

const callerRedirect = "ionremote://oauth/mcp"

// callerCallback builds the URL a provider would redirect to for the pending
// authorization, with the given extra query parameters.
func callerCallback(t *testing.T, authorizationURL string, params url.Values) string {
	t.Helper()
	parsed, err := url.Parse(authorizationURL)
	if err != nil {
		t.Fatalf("parse authorization url: %v", err)
	}
	q := url.Values{}
	q.Set("state", parsed.Query().Get("state"))
	for k, v := range params {
		q[k] = v
	}
	return callerRedirect + "?" + q.Encode()
}

func (f *authServerFixture) registrations() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]string(nil), f.registeredRedirects...)
}

func TestBeginCallerLogin_UsesCallerRedirect(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	fix := newAuthServerFixture(t)

	authURL, err := BeginCallerLogin("srv", fix.config(), "", callerRedirect)
	if err != nil {
		t.Fatalf("BeginCallerLogin: %v", err)
	}
	q, err := url.Parse(authURL)
	if err != nil {
		t.Fatalf("parse authorization url: %v", err)
	}
	if got := q.Query().Get("redirect_uri"); got != callerRedirect {
		t.Errorf("redirect_uri = %q, want the caller's %q", got, callerRedirect)
	}
	if got := q.Query().Get("code_challenge_method"); got != "S256" {
		t.Errorf("code_challenge_method = %q, want S256", got)
	}
	regs := fix.registrations()
	if len(regs) != 1 || len(regs[0]) != 1 || regs[0][0] != callerRedirect {
		t.Errorf("registered redirect_uris = %v, want [[%s]]", regs, callerRedirect)
	}
	pendingCallerLoginsMu.Lock()
	_, pending := pendingCallerLogins["srv"]
	pendingCallerLoginsMu.Unlock()
	if !pending {
		t.Error("begin must hold a pending login for the server")
	}
}

func TestCompleteCallerLogin_StoresToken(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	fix := newAuthServerFixture(t)

	authURL, err := BeginCallerLogin("srv", fix.config(), "", callerRedirect)
	if err != nil {
		t.Fatalf("BeginCallerLogin: %v", err)
	}
	if err := CompleteCallerLogin("srv", callerCallback(t, authURL, url.Values{"code": {"code-1"}})); err != nil {
		t.Fatalf("CompleteCallerLogin: %v", err)
	}

	tok := getOAuthStore().GetToken("srv")
	if tok == nil || tok.AccessToken != "access-xyz" || tok.RefreshToken != "refresh-xyz" {
		t.Fatalf("stored token = %+v, want the exchanged grant", tok)
	}
	form := fix.capturedTokenForm()
	if form.Get("code") != "code-1" || form.Get("redirect_uri") != callerRedirect || form.Get("code_verifier") == "" {
		t.Errorf("token exchange form = %v, want code, caller redirect, and verifier", form)
	}
	if stored := getClientStore().Get("srv"); stored == nil || stored.RedirectURI != callerRedirect {
		t.Errorf("stored registration = %+v, want the one bound to the caller redirect", stored)
	}
	// Single use: the same callback cannot be replayed.
	if err := CompleteCallerLogin("srv", callerCallback(t, authURL, url.Values{"code": {"code-1"}})); err == nil {
		t.Error("a second completion must fail; the pending login is consumed")
	}
}

func TestCompleteCallerLogin_Rejections(t *testing.T) {
	cases := []struct {
		name     string
		callback func(t *testing.T, authURL string) string
		advance  time.Duration
		want     string
	}{
		{
			name: "state mismatch",
			callback: func(t *testing.T, _ string) string {
				return callerRedirect + "?code=c&state=forged"
			},
			want: "state mismatch",
		},
		{
			name: "provider error",
			callback: func(t *testing.T, authURL string) string {
				return callerCallback(t, authURL, url.Values{"error": {"access_denied"}, "error_description": {"user said no"}})
			},
			want: "access_denied",
		},
		{
			name: "expired",
			callback: func(t *testing.T, authURL string) string {
				return callerCallback(t, authURL, url.Values{"code": {"c"}})
			},
			advance: CallerLoginTTL + time.Second,
			want:    "expired",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			resetStoresForTest()
			fix := newAuthServerFixture(t)
			start := time.Now()
			callerLoginNow = func() time.Time { return start }
			t.Cleanup(func() { callerLoginNow = time.Now })

			authURL, err := BeginCallerLogin("srv", fix.config(), "", callerRedirect)
			if err != nil {
				t.Fatalf("BeginCallerLogin: %v", err)
			}
			callerLoginNow = func() time.Time { return start.Add(tc.advance) }

			err = CompleteCallerLogin("srv", tc.callback(t, authURL))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want one containing %q", err, tc.want)
			}
			if getOAuthStore().GetToken("srv") != nil {
				t.Error("a rejected completion must store no token")
			}
			if fix.capturedTokenForm() != nil {
				t.Error("a rejected completion must not reach the token endpoint")
			}
		})
	}
}

func TestCompleteCallerLogin_ExchangeFailure(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	fix := newAuthServerFixture(t)
	fix.tokenCode = 400
	fix.tokenResp = map[string]any{"error": "invalid_grant"}

	authURL, err := BeginCallerLogin("srv", fix.config(), "", callerRedirect)
	if err != nil {
		t.Fatalf("BeginCallerLogin: %v", err)
	}
	err = CompleteCallerLogin("srv", callerCallback(t, authURL, url.Values{"code": {"c"}}))
	if err == nil || !strings.Contains(err.Error(), "invalid_grant") {
		t.Fatalf("error = %v, want the exchange failure", err)
	}
	if getOAuthStore().GetToken("srv") != nil {
		t.Error("a failed exchange must store no token")
	}
}

func TestCompleteCallerLogin_NothingPending(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	err := CompleteCallerLogin("ghost", callerRedirect+"?code=c&state=s")
	if err == nil || !strings.Contains(err.Error(), "no sign-in is pending") {
		t.Fatalf("error = %v, want a no-pending error", err)
	}
}

// TestCallerAndLoopbackLogins_ReregisterPerRedirect pins that a stored
// registration is reused only for the redirect it was registered with.
func TestCallerAndLoopbackLogins_ReregisterPerRedirect(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()
	fix := newAuthServerFixture(t)

	loopback, err := BeginLogin("srv", fix.config(), "")
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	loopback.Cancel()

	if _, err := BeginCallerLogin("srv", fix.config(), "", callerRedirect); err != nil {
		t.Fatalf("BeginCallerLogin: %v", err)
	}
	if _, err := BeginCallerLogin("srv", fix.config(), "", callerRedirect); err != nil {
		t.Fatalf("second BeginCallerLogin: %v", err)
	}

	again, err := BeginLogin("srv", fix.config(), "")
	if err != nil {
		t.Fatalf("second BeginLogin: %v", err)
	}
	defer again.Cancel()
	if got := mustRedirectURI(t, again.AuthorizationURL); !strings.HasPrefix(got, "http://127.0.0.1:") {
		t.Errorf("loopback login after a caller login used redirect %q", got)
	}

	regs := fix.registrations()
	if len(regs) != 3 {
		t.Fatalf("registrations = %v, want loopback, caller (reused once), loopback", regs)
	}
	if regs[1][0] != callerRedirect || !strings.HasPrefix(regs[2][0], "http://127.0.0.1:") {
		t.Errorf("registrations = %v", regs)
	}
}
