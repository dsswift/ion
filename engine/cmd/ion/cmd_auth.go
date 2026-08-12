package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/config"
)

type authVerifyReport struct {
	OK        bool             `json:"ok"`
	Provider  string           `json:"provider,omitempty"`
	Source    string           `json:"source,omitempty"`
	TokenType string           `json:"tokenType,omitempty"`
	ExpiresAt string           `json:"expiresAt,omitempty"`
	Claims    map[string]any   `json:"claims,omitempty"`
	Probe     *authProbeReport `json:"probe,omitempty"`
	Error     string           `json:"error,omitempty"`
}

type authProbeReport struct {
	URL    string `json:"url"`
	Status int    `json:"status"`
}

func cmdAuth(positional []string, flags map[string]string) {
	if len(positional) == 0 || positional[0] != "verify" {
		fmt.Fprintln(os.Stderr, "Usage: ion auth verify [--scope SCOPE] [--audience AUDIENCE] [--aws-service SERVICE --aws-region REGION] [--url URL]")
		os.Exit(2)
	}
	report, exitCode := runAuthVerify(flags)
	encoded, err := json.Marshal(report)
	if err != nil {
		fmt.Fprintf(os.Stderr, "auth verify report encode failed: %v\n", err)
		os.Exit(2)
	}
	fmt.Println(string(encoded))
	if exitCode != 0 {
		os.Exit(exitCode)
	}
}

func runAuthVerify(flags map[string]string) (authVerifyReport, int) {
	cfg := config.LoadConfig("")
	if cfg.Auth == nil || cfg.Auth.IdentityProvider == "" {
		return authVerifyReport{Error: "auth.identityProvider is not configured"}, 2
	}
	providerName := cfg.Auth.IdentityProvider
	operator, err := auth.ConfigureIdentityProviders(cfg.Auth)
	if err != nil {
		return authVerifyReport{Provider: providerName, Error: err.Error()}, 2
	}
	sourceKind := "operator"
	if oauthCfg := cfg.Auth.OAuth[providerName]; oauthCfg.MachineIdentity != nil {
		sourceKind = oauthCfg.MachineIdentity.Source
	}
	report := authVerifyReport{Provider: providerName, Source: sourceKind}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var token string
	if flags["aws-service"] != "" {
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, verifyTargetURL(flags), nil)
		if requestErr != nil {
			report.Error = requestErr.Error()
			return report, 2
		}
		authenticator := auth.SigV4Authenticator{
			Provider: auth.CurrentAWSCredentialsProvider(), Service: flags["aws-service"], Region: flags["aws-region"],
		}
		if err := authenticator.Authenticate(ctx, request, nil); err != nil {
			report.Error = err.Error()
			return report, 3
		}
		report.OK = true
		report.TokenType = "aws_sigv4"
		if flags["url"] != "" {
			status, probeErr := doAuthProbe(request)
			if probeErr != nil {
				report.Error = probeErr.Error()
				return report, 4
			}
			report.Probe = &authProbeReport{URL: flags["url"], Status: status}
		}
		return report, 0
	}

	provider := auth.CurrentTokenProvider()
	if provider == nil && operator != nil {
		provider = operator
	}
	if provider == nil {
		report.Error = "configured identity does not provide OAuth bearer tokens"
		return report, 3
	}
	token, err = provider.GetTokenWithAudience(ctx, flags["scope"], flags["audience"])
	if err != nil {
		report.Error = err.Error()
		return report, 3
	}
	report.OK = true
	report.TokenType = "bearer"
	claims, expiry := redactedJWTClaims(token)
	report.Claims, report.ExpiresAt = claims, expiry
	if report.ExpiresAt == "" {
		if machine, ok := provider.(*auth.MachineIdentityManager); ok {
			report.ExpiresAt = machine.LastExpiry(flags["scope"], flags["audience"])
		}
	}
	if flags["url"] != "" {
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, flags["url"], nil)
		if requestErr != nil {
			report.Error = requestErr.Error()
			return report, 4
		}
		request.Header.Set("Authorization", "Bearer "+token)
		status, probeErr := doAuthProbe(request)
		if probeErr != nil {
			report.Error = probeErr.Error()
			return report, 4
		}
		report.Probe = &authProbeReport{URL: flags["url"], Status: status}
	}
	return report, 0
}

func verifyTargetURL(flags map[string]string) string {
	if flags["url"] != "" {
		return flags["url"]
	}
	return "https://example.invalid/"
}

func doAuthProbe(request *http.Request) (int, error) {
	client := &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close() //nolint:errcheck // Read-only verification response.
	return response.StatusCode, nil
}

func redactedJWTClaims(token string) (map[string]any, string) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ""
	}
	var all map[string]any
	if err := json.Unmarshal(payload, &all); err != nil {
		return nil, ""
	}
	claims := make(map[string]any)
	for _, key := range []string{"aud", "iss", "exp"} {
		if value, ok := all[key]; ok {
			claims[key] = value
		}
	}
	expiry := ""
	if raw, ok := all["exp"].(float64); ok && raw > 0 {
		expiry = time.Unix(int64(raw), 0).UTC().Format(time.RFC3339)
	}
	return claims, expiry
}
