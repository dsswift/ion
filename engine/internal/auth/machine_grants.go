package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const clientAssertionType = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

type clientCredentialsSecret struct{ value string }

type clientCredentialsSource struct {
	cfg       types.OAuthConfig
	secret    string
	assertion func(context.Context) (string, error)
	client    *http.Client
}

func newClientCredentialsSource(cfg types.OAuthConfig, secret clientCredentialsSecret) (TokenSource, error) {
	if cfg.ClientID == "" {
		return nil, fmt.Errorf("clientId is required")
	}
	if err := ensureMachineTokenURL(&cfg); err != nil {
		return nil, err
	}
	if secret.value == "" {
		return nil, fmt.Errorf("client secret is empty")
	}
	return &clientCredentialsSource{cfg: cfg, secret: secret.value, client: &http.Client{Timeout: 30 * time.Second}}, nil
}

func newFederatedAssertionSource(cfg types.OAuthConfig, tokenFile string) (TokenSource, error) {
	if tokenFile == "" {
		return nil, fmt.Errorf("federatedTokenFile is required")
	}
	if cfg.ClientID == "" {
		return nil, fmt.Errorf("clientId is required")
	}
	if err := ensureMachineTokenURL(&cfg); err != nil {
		return nil, err
	}
	return &clientCredentialsSource{
		cfg: cfg,
		assertion: func(context.Context) (string, error) {
			raw, err := os.ReadFile(tokenFile)
			if err != nil {
				return "", fmt.Errorf("read federated assertion file: %w", err)
			}
			assertion := strings.TrimSpace(string(raw))
			if assertion == "" {
				return "", fmt.Errorf("federated assertion file is empty")
			}
			return assertion, nil
		},
		client: &http.Client{Timeout: 30 * time.Second},
	}, nil
}

func ensureMachineTokenURL(cfg *types.OAuthConfig) error {
	if cfg.TokenURL != "" {
		return nil
	}
	if cfg.IssuerURL == "" {
		return fmt.Errorf("tokenUrl or issuerUrl is required")
	}
	doc, err := DiscoverOIDC(cfg.IssuerURL)
	if err != nil {
		return err
	}
	cfg.TokenURL = doc.TokenEndpoint
	return nil
}

func (s *clientCredentialsSource) Acquire(ctx context.Context, scope, audience string) (string, time.Time, error) {
	form := url.Values{
		"grant_type": {"client_credentials"},
		"client_id":  {s.cfg.ClientID},
	}
	if scope != "" {
		form.Set("scope", scope)
	}
	if audience != "" {
		form.Set(audienceParamName(s.cfg.AudienceParameter), audience)
	}
	if s.assertion != nil {
		assertion, err := s.assertion(ctx)
		if err != nil {
			return "", time.Time{}, err
		}
		form.Set("client_assertion_type", clientAssertionType)
		form.Set("client_assertion", assertion)
	} else {
		form.Set("client_secret", s.secret)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("build client credentials request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := s.client.Do(req)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("client credentials request: %w", err)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "auth.machine", "client credentials response close failed", map[string]any{"error": closeErr.Error()})
		}
	}()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("read client credentials response: %w", err)
	}
	var wire wireTokenResponse
	if err := json.Unmarshal(body, &wire); err != nil {
		return "", time.Time{}, fmt.Errorf("parse client credentials response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || wire.Error != "" {
		return "", time.Time{}, fmt.Errorf("client credentials endpoint returned status %d (%s): %s", resp.StatusCode, safeOAuthField(wire.Error), safeOAuthField(wire.ErrorDesc))
	}
	if wire.AccessToken == "" || wire.ExpiresIn <= 0 {
		return "", time.Time{}, fmt.Errorf("client credentials response has no access_token or valid expires_in")
	}
	return wire.AccessToken, time.Now().Add(time.Duration(wire.ExpiresIn) * time.Second), nil
}

func safeOAuthField(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 256 {
		return value[:256] + "...[truncated]"
	}
	return value
}
