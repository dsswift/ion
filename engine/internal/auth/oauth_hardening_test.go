package auth

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

// TestPKCE_RFC9207_IssuerMismatch verifies that a callback carrying an iss
// parameter that does not match ExpectedIssuer is rejected before the code
// exchange. This is the mix-up attack prevention from RFC 9207.
func TestPKCE_RFC9207_IssuerMismatch(t *testing.T) {
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("token endpoint should not be called on iss mismatch")
	}))
	defer tokenSrv.Close()

	flow, err := StartPKCEFlow(PKCEFlowConfig{
		ClientID:       "client-1",
		AuthURL:        "https://login.example.com/authorize",
		TokenURL:       tokenSrv.URL,
		ExpectedIssuer: "https://good.example.com",
	})
	if err != nil {
		t.Fatalf("StartPKCEFlow: %v", err)
	}
	defer flow.Cancel()

	authURL, _ := url.Parse(flow.AuthorizationURL)
	q := authURL.Query()
	redirectURI := q.Get("redirect_uri")
	state := q.Get("state")

	resp, err := http.Get(fmt.Sprintf("%s?code=auth-code-1&state=%s&iss=%s",
		redirectURI, url.QueryEscape(state), url.QueryEscape("https://evil.example.com")))
	if err != nil {
		t.Fatalf("callback request: %v", err)
	}
	resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("callback status = %d, want 400 for iss mismatch", resp.StatusCode)
	}

	select {
	case tok := <-flow.Token:
		t.Fatalf("should not receive token on iss mismatch, got %+v", tok)
	case err := <-flow.Err:
		if err == nil {
			t.Fatal("expected error for iss mismatch")
		}
		t.Logf("correct error: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout")
	}
}

// TestPKCE_RFC9207_IssuerMatch verifies that a callback with iss matching
// ExpectedIssuer proceeds normally through the code exchange.
func TestPKCE_RFC9207_IssuerMatch(t *testing.T) {
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at-iss-ok",
			"token_type":   "Bearer",
			"expires_in":   3600,
		})
	}))
	defer tokenSrv.Close()

	flow, err := StartPKCEFlow(PKCEFlowConfig{
		ClientID:       "client-1",
		AuthURL:        "https://login.example.com/authorize",
		TokenURL:       tokenSrv.URL,
		ExpectedIssuer: "https://good.example.com",
	})
	if err != nil {
		t.Fatalf("StartPKCEFlow: %v", err)
	}
	defer flow.Cancel()

	authURL, _ := url.Parse(flow.AuthorizationURL)
	q := authURL.Query()
	redirectURI := q.Get("redirect_uri")
	state := q.Get("state")

	resp, err := http.Get(fmt.Sprintf("%s?code=auth-code-1&state=%s&iss=%s",
		redirectURI, url.QueryEscape(state), url.QueryEscape("https://good.example.com")))
	if err != nil {
		t.Fatalf("callback request: %v", err)
	}
	resp.Body.Close()

	select {
	case tok := <-flow.Token:
		if tok.AccessToken != "at-iss-ok" {
			t.Errorf("AccessToken = %q, want at-iss-ok", tok.AccessToken)
		}
	case err := <-flow.Err:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout")
	}
}

// TestPKCE_RFC9207_MissingIssAccepted verifies that when ExpectedIssuer is
// set but the callback omits iss entirely, the flow proceeds. RFC 9207 says
// to validate when present; not all servers support it yet.
func TestPKCE_RFC9207_MissingIssAccepted(t *testing.T) {
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at-no-iss",
			"token_type":   "Bearer",
			"expires_in":   3600,
		})
	}))
	defer tokenSrv.Close()

	flow, err := StartPKCEFlow(PKCEFlowConfig{
		ClientID:       "client-1",
		AuthURL:        "https://login.example.com/authorize",
		TokenURL:       tokenSrv.URL,
		ExpectedIssuer: "https://good.example.com",
	})
	if err != nil {
		t.Fatalf("StartPKCEFlow: %v", err)
	}
	defer flow.Cancel()

	authURL, _ := url.Parse(flow.AuthorizationURL)
	q := authURL.Query()
	redirectURI := q.Get("redirect_uri")
	state := q.Get("state")

	resp, err := http.Get(fmt.Sprintf("%s?code=auth-code-1&state=%s", redirectURI, url.QueryEscape(state)))
	if err != nil {
		t.Fatalf("callback request: %v", err)
	}
	resp.Body.Close()

	select {
	case tok := <-flow.Token:
		if tok.AccessToken != "at-no-iss" {
			t.Errorf("AccessToken = %q", tok.AccessToken)
		}
	case err := <-flow.Err:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout")
	}
}

// TestPKCE_RFC8707_ResourceInAuthURL verifies that the resource parameter
// appears in the authorization URL when PKCEFlowConfig.Resource is set.
func TestPKCE_RFC8707_ResourceInAuthURL(t *testing.T) {
	flow, err := StartPKCEFlow(PKCEFlowConfig{
		ClientID: "client-1",
		AuthURL:  "https://login.example.com/authorize",
		TokenURL: "https://login.example.com/token",
		Resource: "https://api.example.com",
	})
	if err != nil {
		t.Fatalf("StartPKCEFlow: %v", err)
	}
	defer flow.Cancel()

	authURL, _ := url.Parse(flow.AuthorizationURL)
	got := authURL.Query().Get("resource")
	if got != "https://api.example.com" {
		t.Errorf("resource in auth URL = %q, want https://api.example.com", got)
	}
}

// TestPKCE_RFC8707_ResourceInCodeExchange verifies that the resource parameter
// is sent to the token endpoint during the code exchange.
func TestPKCE_RFC8707_ResourceInCodeExchange(t *testing.T) {
	var gotResource string
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		gotResource = r.FormValue("resource")
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at-resource",
			"token_type":   "Bearer",
			"expires_in":   3600,
		})
	}))
	defer tokenSrv.Close()

	flow, err := StartPKCEFlow(PKCEFlowConfig{
		ClientID: "client-1",
		AuthURL:  "https://login.example.com/authorize",
		TokenURL: tokenSrv.URL,
		Resource: "https://api.example.com",
	})
	if err != nil {
		t.Fatalf("StartPKCEFlow: %v", err)
	}
	defer flow.Cancel()

	authURL, _ := url.Parse(flow.AuthorizationURL)
	q := authURL.Query()
	redirectURI := q.Get("redirect_uri")
	state := q.Get("state")

	resp, err := http.Get(fmt.Sprintf("%s?code=auth-code-1&state=%s", redirectURI, url.QueryEscape(state)))
	if err != nil {
		t.Fatalf("callback request: %v", err)
	}
	resp.Body.Close()

	select {
	case tok := <-flow.Token:
		if tok.AccessToken != "at-resource" {
			t.Errorf("AccessToken = %q", tok.AccessToken)
		}
	case err := <-flow.Err:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout")
	}

	if gotResource != "https://api.example.com" {
		t.Errorf("resource in token exchange = %q, want https://api.example.com", gotResource)
	}
}

// TestPKCE_NoResourceOmitsParam verifies that when Resource is empty, the
// resource parameter does not appear in the auth URL or token exchange.
func TestPKCE_NoResourceOmitsParam(t *testing.T) {
	var tokenFormValues url.Values
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		tokenFormValues = r.Form
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at-nores",
			"token_type":   "Bearer",
			"expires_in":   3600,
		})
	}))
	defer tokenSrv.Close()

	flow, err := StartPKCEFlow(PKCEFlowConfig{
		ClientID: "client-1",
		AuthURL:  "https://login.example.com/authorize",
		TokenURL: tokenSrv.URL,
	})
	if err != nil {
		t.Fatalf("StartPKCEFlow: %v", err)
	}
	defer flow.Cancel()

	authURL, _ := url.Parse(flow.AuthorizationURL)
	if authURL.Query().Get("resource") != "" {
		t.Error("resource should be absent from auth URL when empty")
	}

	q := authURL.Query()
	redirectURI := q.Get("redirect_uri")
	state := q.Get("state")
	resp, err := http.Get(fmt.Sprintf("%s?code=auth-code-1&state=%s", redirectURI, url.QueryEscape(state)))
	if err != nil {
		t.Fatalf("callback request: %v", err)
	}
	resp.Body.Close()

	select {
	case <-flow.Token:
	case err := <-flow.Err:
		t.Fatalf("unexpected error: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout")
	}

	if tokenFormValues.Get("resource") != "" {
		t.Error("resource should be absent from token exchange when empty")
	}
}
