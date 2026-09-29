package main

// otlp_token.go — OTLP egress config and the OAuth2 client_credentials token
// cache. Two credential modes mint the bearer token:
//
//   - secret: RELAY_OTLP_CLIENT_ID + RELAY_OTLP_CLIENT_SECRET.
//   - federated: Azure workload identity. The webhook-injected
//     AZURE_FEDERATED_TOKEN_FILE holds a projected service-account token that
//     is sent as a jwt-bearer client_assertion for AZURE_CLIENT_ID. The file
//     rotates, so it is re-read on every token fetch.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// otlpAuthMode names how exports are authorized.
type otlpAuthMode string

const (
	otlpAuthNone      otlpAuthMode = "none"
	otlpAuthSecret    otlpAuthMode = "client_secret"
	otlpAuthFederated otlpAuthMode = "federated_token"
)

// otlpJWTBearerAssertionType is the client_assertion_type for a federated
// credential.
const otlpJWTBearerAssertionType = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

// otlpDefaultAuthorityHost is the Entra authority used when the workload
// identity webhook did not inject AZURE_AUTHORITY_HOST.
const otlpDefaultAuthorityHost = "https://login.microsoftonline.com/"

// otlpConfig is the relay's OTLP shipping configuration, read from env.
type otlpConfig struct {
	Endpoint           string       // RELAY_OTLP_ENDPOINT base URL; /v1/logs and /v1/traces are appended
	AuthMode           otlpAuthMode // which credential mints the bearer token
	TokenURL           string       // token endpoint; empty only in otlpAuthNone
	ClientID           string       // RELAY_OTLP_CLIENT_ID (secret) or AZURE_CLIENT_ID (federated)
	ClientSecret       string       // RELAY_OTLP_CLIENT_SECRET; unset from the process env once read
	FederatedTokenFile string       // AZURE_FEDERATED_TOKEN_FILE
	Scope              string       // RELAY_OTLP_SCOPE
}

// otlpConfigFromEnv reads the RELAY_OTLP_* variables and, for federated mode,
// the Azure workload identity variables. The client secret is removed from
// the process environment as soon as it is read, whether or not shipping
// ends up enabled. Returns ok=false when RELAY_OTLP_ENDPOINT is unset.
//
// Mode selection: AZURE_FEDERATED_TOKEN_FILE set selects federated mode; else
// RELAY_OTLP_TOKEN_URL set selects secret mode; else exports carry no
// Authorization header. A mode missing the values it needs is an error.
func otlpConfigFromEnv() (otlpConfig, bool, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(os.Getenv("RELAY_OTLP_ENDPOINT")), "/")
	tokenURL := strings.TrimSpace(os.Getenv("RELAY_OTLP_TOKEN_URL"))
	secret := os.Getenv("RELAY_OTLP_CLIENT_SECRET")
	os.Unsetenv("RELAY_OTLP_CLIENT_SECRET") //nolint:errcheck // Unsetenv only fails on an invalid key name, and this one is a constant
	if endpoint == "" {
		return otlpConfig{}, false, nil
	}
	cfg := otlpConfig{
		Endpoint: endpoint,
		AuthMode: otlpAuthNone,
		TokenURL: tokenURL,
		Scope:    strings.TrimSpace(os.Getenv("RELAY_OTLP_SCOPE")),
	}

	if file := strings.TrimSpace(os.Getenv("AZURE_FEDERATED_TOKEN_FILE")); file != "" {
		cfg.AuthMode = otlpAuthFederated
		cfg.FederatedTokenFile = file
		cfg.ClientID = strings.TrimSpace(os.Getenv("AZURE_CLIENT_ID"))
		if cfg.ClientID == "" {
			return otlpConfig{}, false, errors.New("AZURE_FEDERATED_TOKEN_FILE is set but AZURE_CLIENT_ID is empty")
		}
		if cfg.Scope == "" {
			return otlpConfig{}, false, errors.New("AZURE_FEDERATED_TOKEN_FILE is set but RELAY_OTLP_SCOPE is empty")
		}
		if cfg.TokenURL == "" {
			tenant := strings.TrimSpace(os.Getenv("AZURE_TENANT_ID"))
			if tenant == "" {
				return otlpConfig{}, false, errors.New("AZURE_FEDERATED_TOKEN_FILE is set but neither RELAY_OTLP_TOKEN_URL nor AZURE_TENANT_ID is")
			}
			authority := strings.TrimSpace(os.Getenv("AZURE_AUTHORITY_HOST"))
			if authority == "" {
				authority = otlpDefaultAuthorityHost
			}
			cfg.TokenURL = strings.TrimRight(authority, "/") + "/" + tenant + "/oauth2/v2.0/token"
		}
		return cfg, true, nil
	}

	if cfg.TokenURL != "" {
		cfg.AuthMode = otlpAuthSecret
		cfg.ClientID = strings.TrimSpace(os.Getenv("RELAY_OTLP_CLIENT_ID"))
		cfg.ClientSecret = secret
		if cfg.ClientID == "" || cfg.ClientSecret == "" {
			return otlpConfig{}, false, errors.New("RELAY_OTLP_TOKEN_URL is set but RELAY_OTLP_CLIENT_ID or RELAY_OTLP_CLIENT_SECRET is empty")
		}
	}
	return cfg, true, nil
}

// --- client_credentials token cache ---

type otlpTokenSource struct {
	cfg    otlpConfig
	client *http.Client
	now    func() time.Time
	local  *slog.Logger // local-only logger for token failures; may be nil

	mu     sync.Mutex
	token  string
	expiry time.Time
}

type otlpTokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
}

// Token returns a cached bearer token, fetching a new one when none is
// cached or the cached one is within otlpTokenRefreshSkew of expiry. Every
// fetch failure is logged to the local log with the auth mode.
func (ts *otlpTokenSource) Token(ctx context.Context) (string, error) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if ts.token != "" && ts.now().Before(ts.expiry.Add(-otlpTokenRefreshSkew)) {
		return ts.token, nil
	}
	tok, expiresIn, err := ts.fetch(ctx)
	if err != nil {
		if ts.local != nil {
			ts.local.Warn("otlp: token request failed", "tag", "relay.otlp",
				"auth_mode", string(ts.cfg.AuthMode), "token_url", ts.cfg.TokenURL, "err", err)
		}
		return "", err
	}
	ts.token = tok
	ts.expiry = ts.now().Add(time.Duration(expiresIn) * time.Second)
	return ts.token, nil
}

// credentialForm returns the grant form for the configured mode. Federated
// mode reads the assertion file on every call, since the kubelet rotates it.
func (ts *otlpTokenSource) credentialForm() (url.Values, error) {
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("client_id", ts.cfg.ClientID)
	switch ts.cfg.AuthMode {
	case otlpAuthFederated:
		raw, err := os.ReadFile(ts.cfg.FederatedTokenFile)
		if err != nil {
			return nil, fmt.Errorf("otlp token: read federated token file: %w", err)
		}
		assertion := strings.TrimSpace(string(raw))
		if assertion == "" {
			return nil, fmt.Errorf("otlp token: federated token file %s is empty", ts.cfg.FederatedTokenFile)
		}
		form.Set("client_assertion_type", otlpJWTBearerAssertionType)
		form.Set("client_assertion", assertion)
	case otlpAuthSecret:
		form.Set("client_secret", ts.cfg.ClientSecret)
	default:
		return nil, fmt.Errorf("otlp token: no credential for auth mode %q", ts.cfg.AuthMode)
	}
	if ts.cfg.Scope != "" {
		form.Set("scope", ts.cfg.Scope)
	}
	return form, nil
}

func (ts *otlpTokenSource) fetch(ctx context.Context) (string, int64, error) {
	form, err := ts.credentialForm()
	if err != nil {
		return "", 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ts.cfg.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", 0, fmt.Errorf("otlp token: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := ts.client.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("otlp token: POST: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck // response body close after read
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", 0, fmt.Errorf("otlp token: read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("otlp token: status %d: %s", resp.StatusCode, truncateForLog(body))
	}
	var tr otlpTokenResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return "", 0, fmt.Errorf("otlp token: decode response: %w", err)
	}
	if tr.AccessToken == "" {
		return "", 0, errors.New("otlp token: response carried no access_token")
	}
	return tr.AccessToken, tr.ExpiresIn, nil
}

// Invalidate drops the cached token so the next Token call fetches anew.
func (ts *otlpTokenSource) Invalidate() {
	ts.mu.Lock()
	ts.token = ""
	ts.mu.Unlock()
}
