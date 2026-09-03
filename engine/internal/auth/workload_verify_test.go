package auth

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestVerifyConfiguredWorkload_NoIdentity(t *testing.T) {
	SetTokenProvider(nil)
	SetAWSCredentialsProvider(nil)
	SetContextIdentityProvider(nil)
	defer SetContextIdentityProvider(nil)
	verification, err := VerifyConfiguredWorkload(context.Background(), nil)
	if err != nil || verification != nil {
		t.Fatalf("VerifyConfiguredWorkload(nil) = %#v, %v", verification, err)
	}
	verification, err = VerifyConfiguredWorkload(context.Background(), &types.AuthConfig{})
	if err != nil || verification != nil {
		t.Fatalf("VerifyConfiguredWorkload(empty) = %#v, %v", verification, err)
	}
}

func TestVerifyConfiguredWorkload_BearerWarmsCacheAndPublishesIdentity(t *testing.T) {
	const secretEnv = "ION_WORKLOAD_VERIFY_SECRET"
	t.Setenv(secretEnv, "secret")
	var acquisitions atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		acquisitions.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"opaque-token","expires_in":3600}`))
	}))
	defer tokenServer.Close()
	cfg := &types.AuthConfig{IdentityProvider: "workload", OAuth: map[string]types.OAuthConfig{"workload": {
		ClientID: "client", TokenURL: tokenServer.URL, Scopes: []string{"scope"},
		MachineIdentity: &types.MachineIdentityConfig{Source: "client_secret", ClientSecretEnv: secretEnv},
	}}}
	var changes atomic.Int32
	unsubscribe := SubscribeContextIdentityChanges(func(change ContextIdentityChange) {
		if change.Reason == "workload_ready" && change.Identity != nil {
			changes.Add(1)
		}
	})
	defer unsubscribe()

	verification, err := VerifyConfiguredWorkload(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if verification.Identity == nil || verification.Identity.Kind != "workload" || verification.Identity.Provider != "workload" || verification.Identity.Source != "client_secret" {
		t.Fatalf("identity = %#v", verification.Identity)
	}
	if verification.Identity.Claims != nil || verification.Identity.Subject != "" {
		t.Fatalf("bearer verification must not infer claims: %#v", verification.Identity)
	}
	provider, ok := CurrentTokenProvider().(*MachineIdentityManager)
	if !ok {
		t.Fatalf("provider = %T, want *MachineIdentityManager", CurrentTokenProvider())
	}
	if _, err := provider.GetToken(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	if got := acquisitions.Load(); got != 1 {
		t.Fatalf("acquisitions = %d, want 1", got)
	}
	if got := changes.Load(); got != 1 {
		t.Fatalf("workload_ready changes = %d, want 1", got)
	}
	identity := provider.ContextIdentity()
	identity.Provider = "changed"
	if got := provider.ContextIdentity().Provider; got != "workload" {
		t.Fatalf("ContextIdentity was not defensive: %q", got)
	}
}

func TestVerifyConfiguredWorkload_AWSSTSProof(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "AKID")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "SECRET")
	t.Setenv("AWS_SESSION_TOKEN", "SESSION")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if r.Method != http.MethodPost || string(body) != "Action=GetCallerIdentity&Version=2011-06-15" {
			t.Fatalf("request %s body=%q", r.Method, body)
		}
		if !strings.Contains(r.Header.Get("Authorization"), "/us-east-1/sts/aws4_request") {
			t.Fatalf("authorization = %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("X-Amz-Security-Token") != "SESSION" {
			t.Fatalf("session token header missing")
		}
		_, _ = w.Write([]byte(`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account><Arn>arn:aws:iam::123456789012:role/test</Arn><UserId>user-id</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>`))
	}))
	defer server.Close()
	previousClient := workloadHTTPClient
	workloadHTTPClient = func() *http.Client { return server.Client() }
	defer func() { workloadHTTPClient = previousClient }()
	cfg := &types.AuthConfig{IdentityProvider: "aws", OAuth: map[string]types.OAuthConfig{"aws": {
		MachineIdentity: &types.MachineIdentityConfig{Source: "aws", AWS: &types.AWSMachineIdentityConfig{Kind: "env", Region: "us-east-1", STSEndpoint: server.URL}},
	}}}
	verification, err := VerifyConfiguredWorkload(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if verification.Identity.Subject != "arn:aws:iam::123456789012:role/test" || verification.Identity.Claims["account"] != "123456789012" || verification.Identity.Claims["userId"] != "user-id" {
		t.Fatalf("identity = %#v", verification.Identity)
	}
}

func TestVerifyConfiguredWorkload_AWSFailureCases(t *testing.T) {
	for _, response := range []struct {
		name, body string
		status     int
	}{
		{"non_200", "denied", http.StatusForbidden},
		{"malformed_xml", "<broken", http.StatusOK},
		{"empty_arn", `<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`, http.StatusOK},
	} {
		t.Run(response.name, func(t *testing.T) {
			t.Setenv("AWS_ACCESS_KEY_ID", "AKID")
			t.Setenv("AWS_SECRET_ACCESS_KEY", "SECRET")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(response.status)
				_, _ = w.Write([]byte(response.body))
			}))
			defer server.Close()
			previousClient := workloadHTTPClient
			workloadHTTPClient = func() *http.Client { return server.Client() }
			defer func() { workloadHTTPClient = previousClient }()
			cfg := &types.AuthConfig{IdentityProvider: "aws", OAuth: map[string]types.OAuthConfig{"aws": {MachineIdentity: &types.MachineIdentityConfig{Source: "aws", AWS: &types.AWSMachineIdentityConfig{Kind: "env", Region: "us-east-1", STSEndpoint: server.URL}}}}}
			if _, err := VerifyConfiguredWorkload(context.Background(), cfg); err == nil {
				t.Fatal("expected STS verification error")
			}
		})
	}
	cfg := &types.AuthConfig{IdentityProvider: "aws", OAuth: map[string]types.OAuthConfig{"aws": {MachineIdentity: &types.MachineIdentityConfig{Source: "aws", AWS: &types.AWSMachineIdentityConfig{Kind: "env"}}}}}
	t.Setenv("AWS_ACCESS_KEY_ID", "AKID")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "SECRET")
	t.Setenv("AWS_REGION", "")
	t.Setenv("AWS_DEFAULT_REGION", "")
	if _, err := VerifyConfiguredWorkload(context.Background(), cfg); err == nil {
		t.Fatal("expected missing region error")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := VerifyConfiguredWorkload(ctx, cfg); err == nil {
		t.Fatal("expected cancelled verification error")
	}
}

func TestVerifyConfiguredWorkload_BearerExpiry(t *testing.T) {
	if workloadVerificationTimeout != 30*time.Second {
		t.Fatalf("startup timeout = %s", workloadVerificationTimeout)
	}
}
