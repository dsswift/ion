package acpagent

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

var urlClient = ClientCapabilities{Elicitation: &ElicitationCapabilities{URL: json.RawMessage(`{}`)}}

func TestInitializeOffersSignInOnlyWithAnIdentityProvider(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{SignIn: &SignIn{Provider: "Entra"}})
	res := c.initialize(ClientCapabilities{})
	if len(res.AuthMethods) != 1 || res.AuthMethods[0].ID != AuthMethodOidc || res.AgentCapabilities.Auth == nil || res.AgentCapabilities.Auth.Logout == nil {
		t.Fatalf("sign-in not advertised: %+v %+v", res.AuthMethods, res.AgentCapabilities.Auth)
	}

	g := newFakeEngine(t)
	defer g.close()
	_, d := startAgent(t, g, Options{})
	plain := d.initialize(ClientCapabilities{})
	if len(plain.AuthMethods) != 0 || plain.AgentCapabilities.Auth != nil {
		t.Fatalf("sign-in advertised without a provider: %+v", plain)
	}
}

// authenticate shows the login URL as a url elicitation scoped to the
// authenticate request, then answers once the engine reports a sign-in.
func TestAuthenticateShowsTheURLAndWaitsForTheSignIn(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	f.loginURL = "https://login.example.com/authorize?x=1"
	_, c := startAgent(t, f, Options{SignIn: &SignIn{Provider: "Entra"}})
	var mu sync.Mutex
	var asked ElicitationURLRequest
	var completed []string
	c.onReq = func(method string, params json.RawMessage) any {
		mu.Lock()
		defer mu.Unlock()
		switch method {
		case ReqElicitationCreate:
			if err := json.Unmarshal(params, &asked); err != nil {
				t.Errorf("elicitation params: %v", err)
			}
			f.emit("", map[string]any{"type": types.EventOidcIdentity, "oidcSignedIn": true, "oidcUsername": "user@example.com"})
			return ElicitationCreateResponse{Action: "accept"}
		case NotifElicitationComplet:
			var n ElicitationCompleteNotification
			if err := json.Unmarshal(params, &n); err == nil {
				completed = append(completed, n.ElicitationID)
			}
		}
		return map[string]any{}
	}
	c.initialize(urlClient)
	if msg := c.call(MethodAuthenticate, AuthenticateRequest{MethodID: AuthMethodOidc}, nil); msg != "" {
		t.Fatalf("authenticate: %s", msg)
	}
	if begin := f.waitCmd("oidc_begin_login"); begin["oidcFlow"] != OidcFlowBrowser {
		t.Fatalf("login flow = %v", begin["oidcFlow"])
	}
	mu.Lock()
	defer mu.Unlock()
	if asked.Mode != "url" || asked.URL != f.loginURL || asked.ElicitationID == "" || string(asked.RequestID) != "2" {
		t.Fatalf("elicitation = %+v (request id %s)", asked, asked.RequestID)
	}
	if len(completed) != 1 || completed[0] != asked.ElicitationID {
		t.Fatalf("elicitation/complete = %v", completed)
	}
}

func TestAuthenticateFailsWhenTheUserDeclines(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	f.loginURL = "https://login.example.com/authorize"
	_, c := startAgent(t, f, Options{SignIn: &SignIn{Provider: "Entra"}})
	c.onReq = func(method string, _ json.RawMessage) any {
		if method == ReqElicitationCreate {
			return ElicitationCreateResponse{Action: "decline"}
		}
		return map[string]any{}
	}
	c.initialize(urlClient)
	if code, _ := c.callErr(MethodAuthenticate, AuthenticateRequest{MethodID: AuthMethodOidc}); code == codeAuthRequired {
		t.Fatalf("a declined sign-in must not read as authentication required")
	}
}

// A client that cannot show a URL gets it opened on this machine.
func TestAuthenticateOpensTheURLForAClientWithoutURLs(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	f.loginURL = "https://login.example.com/authorize"
	opened := make(chan string, 1)
	_, c := startAgent(t, f, Options{SignIn: &SignIn{Provider: "Entra", OpenURL: func(url string) error {
		opened <- url
		f.emit("", map[string]any{"type": types.EventOidcIdentity, "oidcSignedIn": true})
		return nil
	}}})
	c.initialize(ClientCapabilities{})
	if msg := c.call(MethodAuthenticate, AuthenticateRequest{MethodID: AuthMethodOidc}, nil); msg != "" {
		t.Fatalf("authenticate: %s", msg)
	}
	if got := <-opened; got != f.loginURL {
		t.Fatalf("opened %q", got)
	}
}

// An engine refusal for want of a sign-in is ACP's authentication-required
// error, so the client offers sign-in; any other failure is not.
func TestSessionStartRefusalCodes(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	f.failStart = types.PolicyFailureAuthenticationFailed
	_, c := startAgent(t, f, Options{SignIn: &SignIn{Provider: "Entra"}})
	c.initialize(ClientCapabilities{})
	if code, _ := c.callErr(MethodSessionNew, NewSessionRequest{Cwd: "/w"}); code != codeAuthRequired {
		t.Fatalf("auth refusal code = %d, want %d", code, codeAuthRequired)
	}
	f.mu.Lock()
	f.failStart = "some_other_policy"
	f.mu.Unlock()
	if code, _ := c.callErr(MethodSessionNew, NewSessionRequest{Cwd: "/w"}); code != codeInternalError {
		t.Fatalf("other refusal code = %d, want %d", code, codeInternalError)
	}
}

func TestLogoutSignsTheEngineOut(t *testing.T) {
	f := newFakeEngine(t)
	defer f.close()
	_, c := startAgent(t, f, Options{SignIn: &SignIn{Provider: "Entra"}})
	c.initialize(ClientCapabilities{})
	if msg := c.call(MethodLogout, map[string]any{}, nil); msg != "" {
		t.Fatalf("logout: %s", msg)
	}
	f.waitCmd("oidc_logout")
}

func TestInternalErrorKeepsAuthRequiredForSignIn(t *testing.T) {
	if got := internalError(errors.New("boom")).Code; got != codeInternalError {
		t.Fatalf("plain error code = %d", got)
	}
	if got := internalError(errAuthRequired).Code; got != codeAuthRequired {
		t.Fatalf("auth error code = %d", got)
	}
}
