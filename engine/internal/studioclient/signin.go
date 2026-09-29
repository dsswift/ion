package studioclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// SignIn is a reader's own OpenID Connect sign-in to one server, made with
// the server's published client (its /auth/config): the refresh token that
// mints the bearer a Studio connection presents. It belongs to the reader,
// not to this machine's engine, whose sign-in may be to another tenant.
type SignIn struct {
	Issuer        string `json:"issuer"`
	ClientID      string `json:"clientId"`
	Scope         string `json:"scope"`
	TokenEndpoint string `json:"tokenEndpoint"`
	RefreshToken  string `json:"refreshToken"`
}

// DevicePrompt tells the person where to sign in.
type DevicePrompt func(message string)

type oidcDiscovery struct {
	DeviceAuthorizationEndpoint string `json:"device_authorization_endpoint"`
	TokenEndpoint               string `json:"token_endpoint"`
}

type tokenResponse struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
	Interval         int    `json:"interval"`
}

// minPollInterval is the least wait between device sign-in polls, the
// grant's default when the issuer names none.
var minPollInterval = 5 * time.Second

// httpClient bounds every sign-in request.
var httpClient = &http.Client{Timeout: 30 * time.Second}

// SignInWithDeviceCode runs the OAuth device authorization grant against the
// server's issuer and client: the person opens a page, types a code, and
// signs in there, and the refresh token comes back here. offline_access asks
// for the refresh token the fleet keeps.
func SignInWithDeviceCode(ctx context.Context, oidc AuthOIDC, prompt DevicePrompt) (SignIn, error) {
	scope := ComposeOIDCScope(oidc.Audience, oidc.Scope)
	s := SignIn{Issuer: oidc.Issuer, ClientID: oidc.ClientID, Scope: scope}
	disc, err := discover(ctx, oidc.Issuer)
	if err != nil {
		return s, err
	}
	if disc.DeviceAuthorizationEndpoint == "" {
		return s, fmt.Errorf("%s publishes no device sign-in", oidc.Issuer)
	}
	s.TokenEndpoint = disc.TokenEndpoint
	var code struct {
		DeviceCode string `json:"device_code"`
		Message    string `json:"message"`
		Interval   int    `json:"interval"`
		ExpiresIn  int    `json:"expires_in"`
		Error      string `json:"error"`
		ErrorDesc  string `json:"error_description"`
	}
	if err := postForm(ctx, disc.DeviceAuthorizationEndpoint, url.Values{"client_id": {oidc.ClientID}, "scope": {scope + " offline_access"}}, &code); err != nil {
		return s, err
	}
	if code.DeviceCode == "" {
		return s, fmt.Errorf("device sign-in refused: %s %s", code.Error, code.ErrorDesc)
	}
	prompt(code.Message)
	utils.LogWithFields(utils.LevelInfo, logTag, "device sign-in started", map[string]any{"issuer": oidc.Issuer, "client_id": oidc.ClientID, "expires_in": code.ExpiresIn})
	interval := max(time.Duration(code.Interval)*time.Second, minPollInterval)
	deadline := time.Now().Add(time.Duration(max(code.ExpiresIn, 60)) * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return s, ctx.Err()
		case <-time.After(interval):
		}
		var tok tokenResponse
		if err := postForm(ctx, s.TokenEndpoint, url.Values{
			"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "client_id": {oidc.ClientID}, "device_code": {code.DeviceCode},
		}, &tok); err != nil {
			return s, err
		}
		switch tok.Error {
		case "":
			if tok.RefreshToken == "" {
				return s, errors.New("the sign-in returned no refresh token")
			}
			s.RefreshToken = tok.RefreshToken
			utils.LogWithFields(utils.LevelInfo, logTag, "device sign-in completed", map[string]any{"issuer": oidc.Issuer, "client_id": oidc.ClientID})
			return s, nil
		case "authorization_pending":
		case "slow_down":
			interval += minPollInterval
		default:
			utils.LogWithFields(utils.LevelWarn, logTag, "device sign-in failed", map[string]any{"issuer": oidc.Issuer, "error": tok.Error})
			return s, fmt.Errorf("sign-in failed: %s: %s", tok.Error, firstLine(tok.ErrorDescription))
		}
	}
	return s, errors.New("the sign-in code expired before it was used")
}

// Refresh mints an access token from the sign-in, and returns the sign-in
// with the refresh token the issuer rotated to, which the caller must keep.
func (s SignIn) Refresh(ctx context.Context) (string, SignIn, error) {
	var tok tokenResponse
	if err := postForm(ctx, s.TokenEndpoint, url.Values{
		"grant_type": {"refresh_token"}, "client_id": {s.ClientID}, "refresh_token": {s.RefreshToken}, "scope": {s.Scope + " offline_access"},
	}, &tok); err != nil {
		return "", s, err
	}
	if tok.AccessToken == "" {
		return "", s, fmt.Errorf("the sign-in no longer works (%s: %s); sign in again", tok.Error, firstLine(tok.ErrorDescription))
	}
	if tok.RefreshToken != "" {
		s.RefreshToken = tok.RefreshToken
	}
	return tok.AccessToken, s, nil
}

func discover(ctx context.Context, issuer string) (oidcDiscovery, error) {
	var d oidcDiscovery
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(issuer, "/")+"/.well-known/openid-configuration", nil)
	if err != nil {
		return d, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return d, fmt.Errorf("read %s's sign-in settings: %w", issuer, err)
	}
	defer resp.Body.Close() //nolint:errcheck // response body close after full read
	if resp.StatusCode != http.StatusOK {
		return d, fmt.Errorf("read %s's sign-in settings: HTTP %d", issuer, resp.StatusCode)
	}
	return d, json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&d)
}

// postForm posts a form and decodes the JSON answer, whatever its status:
// OAuth errors arrive as a JSON body with a 400.
func postForm(ctx context.Context, endpoint string, form url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("POST %s: %w", endpoint, err)
	}
	defer resp.Body.Close() //nolint:errcheck // response body close after full read
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out); err != nil {
		return fmt.Errorf("POST %s: HTTP %d, unreadable answer: %w", endpoint, resp.StatusCode, err)
	}
	return nil
}

func firstLine(s string) string {
	return strings.TrimSpace(strings.SplitN(s, "\n", 2)[0])
}
