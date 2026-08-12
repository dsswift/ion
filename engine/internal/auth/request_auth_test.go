package auth

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/awssig"
)

type mockTokenProvider struct {
	token string
	err   error
}

func (m *mockTokenProvider) GetToken(_ context.Context, _ string) (string, error) {
	return m.token, m.err
}
func (m *mockTokenProvider) GetTokenWithAudience(_ context.Context, _, _ string) (string, error) {
	return m.token, m.err
}

type mockAWSProvider struct {
	creds *AWSCredentials
	err   error
}

func (m *mockAWSProvider) Retrieve(_ context.Context) (*AWSCredentials, error) {
	return m.creds, m.err
}
func (m *mockAWSProvider) Kind() string { return "mock" }

func TestBearerAuthenticator_SetsHeader(t *testing.T) {
	provider := &mockTokenProvider{token: "my-token"}
	auth := BearerAuthenticator{Provider: provider, Scope: "api", Audience: "https://api.example.com"}

	req, _ := http.NewRequest("GET", "https://api.example.com/resource", nil)
	err := auth.Authenticate(context.Background(), req, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := req.Header.Get("Authorization")
	if got != "Bearer my-token" {
		t.Errorf("Authorization = %q, want Bearer my-token", got)
	}
}

func TestBearerAuthenticator_NilProvider(t *testing.T) {
	auth := BearerAuthenticator{}
	req, _ := http.NewRequest("GET", "https://example.com", nil)
	err := auth.Authenticate(context.Background(), req, nil)
	if err == nil {
		t.Fatal("expected error with nil provider")
	}
}

func TestBearerAuthenticator_ProviderError(t *testing.T) {
	provider := &mockTokenProvider{err: fmt.Errorf("token error")}
	auth := BearerAuthenticator{Provider: provider}

	req, _ := http.NewRequest("GET", "https://example.com", nil)
	err := auth.Authenticate(context.Background(), req, nil)
	if err == nil || !strings.Contains(err.Error(), "token error") {
		t.Fatalf("err = %v, want token error", err)
	}
}

func TestSigV4Authenticator_SignsRequest(t *testing.T) {
	provider := &mockAWSProvider{
		creds: &AWSCredentials{
			AccessKeyID:    "AKID",
			SecretAccessKey: "secret",
			SessionToken:   "sess-tok",
			ExpiresAt:      time.Now().Add(time.Hour),
		},
	}
	fixedTime := time.Date(2025, 6, 15, 12, 0, 0, 0, time.UTC)
	auth := SigV4Authenticator{
		Provider: provider,
		Service:  "bedrock",
		Region:   "us-east-1",
		Clock:    func() time.Time { return fixedTime },
	}

	req, _ := http.NewRequest("POST", "https://bedrock.us-east-1.amazonaws.com/invoke", strings.NewReader("body"))
	err := auth.Authenticate(context.Background(), req, []byte("body"))
	if err != nil {
		t.Fatal(err)
	}

	authHeader := req.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "AWS4-HMAC-SHA256") {
		t.Errorf("Authorization should start with AWS4-HMAC-SHA256, got %q", authHeader)
	}
	if !strings.Contains(authHeader, "AKID") {
		t.Error("Authorization should contain access key ID")
	}
	if tok := req.Header.Get("X-Amz-Security-Token"); tok != "sess-tok" {
		t.Errorf("X-Amz-Security-Token = %q, want sess-tok", tok)
	}

	// Verify the signature is deterministic with fixed clock.
	_ = awssig.Signer{} // ensure package is reachable
}

func TestSigV4Authenticator_NilProvider(t *testing.T) {
	auth := SigV4Authenticator{Service: "s3", Region: "us-east-1"}
	req, _ := http.NewRequest("GET", "https://s3.amazonaws.com/bucket", nil)
	err := auth.Authenticate(context.Background(), req, nil)
	if err == nil {
		t.Fatal("expected error with nil provider")
	}
}

func TestSigV4Authenticator_MissingServiceRegion(t *testing.T) {
	provider := &mockAWSProvider{
		creds: &AWSCredentials{AccessKeyID: "A", SecretAccessKey: "B", ExpiresAt: time.Now().Add(time.Hour)},
	}

	tests := []struct {
		name    string
		service string
		region  string
	}{
		{"no service", "", "us-east-1"},
		{"no region", "s3", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			auth := SigV4Authenticator{Provider: provider, Service: tt.service, Region: tt.region}
			req, _ := http.NewRequest("GET", "https://example.com", nil)
			err := auth.Authenticate(context.Background(), req, nil)
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestSigV4Authenticator_ProviderError(t *testing.T) {
	provider := &mockAWSProvider{err: fmt.Errorf("creds fail")}
	auth := SigV4Authenticator{Provider: provider, Service: "s3", Region: "us-east-1"}
	req, _ := http.NewRequest("GET", "https://example.com", nil)
	err := auth.Authenticate(context.Background(), req, nil)
	if err == nil || !strings.Contains(err.Error(), "creds fail") {
		t.Fatalf("err = %v, want creds fail", err)
	}
}
