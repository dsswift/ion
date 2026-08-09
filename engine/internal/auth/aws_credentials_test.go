package auth

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// --- AWSCredentials.Expired ---

func TestAWSCredentials_Expired(t *testing.T) {
	t.Run("nil credentials are expired", func(t *testing.T) {
		var c *AWSCredentials
		if !c.Expired(0) {
			t.Fatal("nil credentials should be expired")
		}
	})
	t.Run("future expiry not expired", func(t *testing.T) {
		c := &AWSCredentials{ExpiresAt: time.Now().Add(1 * time.Hour)}
		if c.Expired(5 * time.Minute) {
			t.Fatal("credentials expiring in 1h should not be expired with 5m threshold")
		}
	})
	t.Run("within threshold is expired", func(t *testing.T) {
		c := &AWSCredentials{ExpiresAt: time.Now().Add(2 * time.Minute)}
		if !c.Expired(5 * time.Minute) {
			t.Fatal("credentials expiring in 2m should be expired with 5m threshold")
		}
	})
}

// --- CachedAWSProvider ---

type fakeProvider struct {
	mu    sync.Mutex
	calls int
	creds *AWSCredentials
	err   error
}

func (f *fakeProvider) Retrieve(_ context.Context) (*AWSCredentials, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.creds, f.err
}

func (f *fakeProvider) Kind() string { return "fake" }

func (f *fakeProvider) CallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func TestCachedAWSProvider_CachesUntilThreshold(t *testing.T) {
	inner := &fakeProvider{
		creds: &AWSCredentials{
			AccessKeyID:     "AKIA_TEST",
			SecretAccessKey: "secret",
			ExpiresAt:       time.Now().Add(1 * time.Hour),
		},
	}

	cached := NewCachedAWSProvider(inner, 5*time.Minute)

	ctx := context.Background()
	c1, err := cached.Retrieve(ctx)
	if err != nil {
		t.Fatalf("first retrieve: %v", err)
	}
	c2, err := cached.Retrieve(ctx)
	if err != nil {
		t.Fatalf("second retrieve: %v", err)
	}
	if c1.AccessKeyID != c2.AccessKeyID || c1.SecretAccessKey != c2.SecretAccessKey || c1.SessionToken != c2.SessionToken {
		t.Fatal("expected same credential values from cache")
	}
	if inner.CallCount() != 1 {
		t.Fatalf("expected 1 call to inner, got %d", inner.CallCount())
	}
}

func TestCachedAWSProvider_RefreshesExpired(t *testing.T) {
	inner := &fakeProvider{
		creds: &AWSCredentials{
			AccessKeyID:     "AKIA_EXPIRED",
			SecretAccessKey: "secret",
			ExpiresAt:       time.Now().Add(1 * time.Minute),
		},
	}

	cached := NewCachedAWSProvider(inner, 5*time.Minute)

	ctx := context.Background()
	_, err := cached.Retrieve(ctx)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	_, err = cached.Retrieve(ctx)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if inner.CallCount() != 2 {
		t.Fatalf("expected 2 calls (expired), got %d", inner.CallCount())
	}
}

func TestCachedAWSProvider_PropagatesError(t *testing.T) {
	inner := &fakeProvider{err: fmt.Errorf("boom")}
	cached := NewCachedAWSProvider(inner, 5*time.Minute)
	_, err := cached.Retrieve(context.Background())
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("expected error containing 'boom', got: %v", err)
	}
}

// --- IMDS provider with fake server ---

func TestIMDSProvider_Success(t *testing.T) {
	expiry := time.Now().Add(6 * time.Hour).UTC().Truncate(time.Second)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/latest/api/token":
			ttl := r.Header.Get("X-aws-ec2-metadata-token-ttl-seconds")
			if ttl == "" {
				t.Error("missing TTL header on token request")
			}
			w.Write([]byte("test-imds-token"))

		case r.URL.Path == "/latest/meta-data/iam/security-credentials/":
			tok := r.Header.Get("X-aws-ec2-metadata-token")
			if tok != "test-imds-token" {
				t.Errorf("wrong token: %s", tok)
			}
			w.Write([]byte("test-role"))

		case strings.HasPrefix(r.URL.Path, "/latest/meta-data/iam/security-credentials/test-role"):
			resp := imdsCredResponse{
				Code:            "Success",
				AccessKeyID:     "AKIA_IMDS",
				SecretAccessKey: "secret_imds",
				Token:           "token_imds",
				Expiration:      expiry,
			}
			json.NewEncoder(w).Encode(resp) //nolint:errcheck // test

		default:
			http.Error(w, "not found", 404)
		}
	}))
	defer ts.Close()

	p := NewIMDSProvider(ts.URL)
	creds, err := p.Retrieve(context.Background())
	if err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	if creds.AccessKeyID != "AKIA_IMDS" {
		t.Errorf("access key = %q, want AKIA_IMDS", creds.AccessKeyID)
	}
	if creds.SecretAccessKey != "secret_imds" {
		t.Errorf("secret = %q", creds.SecretAccessKey)
	}
	if creds.SessionToken != "token_imds" {
		t.Errorf("token = %q", creds.SessionToken)
	}
	if !creds.ExpiresAt.Equal(expiry) {
		t.Errorf("expiry = %v, want %v", creds.ExpiresAt, expiry)
	}
}

func TestIMDSProvider_TokenFailure(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer ts.Close()

	p := NewIMDSProvider(ts.URL)
	_, err := p.Retrieve(context.Background())
	if err == nil {
		t.Fatal("expected error on 403 token response")
	}
	if !strings.Contains(err.Error(), "403") {
		t.Errorf("error should mention 403: %v", err)
	}
}

func TestIMDSProvider_NoRole(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			w.Write([]byte("token"))
			return
		}
		w.Write([]byte(""))
	}))
	defer ts.Close()

	p := NewIMDSProvider(ts.URL)
	_, err := p.Retrieve(context.Background())
	if err == nil || !strings.Contains(err.Error(), "no IAM role") {
		t.Fatalf("expected 'no IAM role' error, got: %v", err)
	}
}

// --- ECS provider ---

func TestECSProvider_Success(t *testing.T) {
	expiry := time.Now().Add(12 * time.Hour).UTC().Truncate(time.Second)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/creds" {
			http.Error(w, "not found", 404)
			return
		}
		resp := ecsCredResponse{
			AccessKeyID:     "AKIA_ECS",
			SecretAccessKey: "secret_ecs",
			Token:           "token_ecs",
			Expiration:      expiry,
		}
		json.NewEncoder(w).Encode(resp) //nolint:errcheck // test
	}))
	defer ts.Close()

	p := NewECSProvider("/creds", ts.URL)
	creds, err := p.Retrieve(context.Background())
	if err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	if creds.AccessKeyID != "AKIA_ECS" {
		t.Errorf("access key = %q", creds.AccessKeyID)
	}
	if !creds.ExpiresAt.Equal(expiry) {
		t.Errorf("expiry = %v, want %v", creds.ExpiresAt, expiry)
	}
}

func TestECSProvider_ServerError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "internal", http.StatusInternalServerError)
	}))
	defer ts.Close()

	p := NewECSProvider("/creds", ts.URL)
	_, err := p.Retrieve(context.Background())
	if err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("expected 500 error, got: %v", err)
	}
}

// --- EKS provider ---

func TestEKSProvider_Success(t *testing.T) {
	expiry := time.Now().Add(12 * time.Hour).UTC().Truncate(time.Second)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader != "eks-test-token" {
			t.Errorf("auth header = %q, want 'eks-test-token'", authHeader)
		}
		resp := ecsCredResponse{
			AccessKeyID:     "AKIA_EKS",
			SecretAccessKey: "secret_eks",
			Token:           "token_eks",
			Expiration:      expiry,
		}
		json.NewEncoder(w).Encode(resp) //nolint:errcheck // test
	}))
	defer ts.Close()

	tokenFile := filepath.Join(t.TempDir(), "token")
	os.WriteFile(tokenFile, []byte("eks-test-token"), 0600)

	p, err := NewEKSProvider(ts.URL, tokenFile)
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	creds, err := p.Retrieve(context.Background())
	if err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	if creds.AccessKeyID != "AKIA_EKS" {
		t.Errorf("access key = %q", creds.AccessKeyID)
	}
}

func TestEKSProvider_MissingTokenFile(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
	}))
	defer ts.Close()

	p, err := NewEKSProvider(ts.URL, "/nonexistent/token")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	_, err = p.Retrieve(context.Background())
	if err == nil || !strings.Contains(err.Error(), "read auth token") {
		t.Fatalf("expected token file error, got: %v", err)
	}
}

// --- validateFullURI ---

func TestValidateFullURI(t *testing.T) {
	tests := []struct {
		uri     string
		wantErr bool
	}{
		{"http://127.0.0.1:8080/creds", false},
		{"http://169.254.170.2/creds", false},
		{"http://169.254.170.23/creds", false},
		{"http://[::1]:8080/creds", false},
		{"http://10.0.0.1/creds", true},
		{"http://192.168.1.1/creds", true},
		{"not a url ://???", true},
	}
	for _, tt := range tests {
		t.Run(tt.uri, func(t *testing.T) {
			err := validateFullURI(tt.uri)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateFullURI(%q) error = %v, wantErr %v", tt.uri, err, tt.wantErr)
			}
		})
	}
}

// --- IRSA provider ---

func TestIRSAProvider_Success(t *testing.T) {
	expiry := time.Now().Add(1 * time.Hour).UTC().Truncate(time.Second)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		ct := r.Header.Get("Content-Type")
		if ct != "application/x-www-form-urlencoded" {
			t.Errorf("content-type = %q", ct)
		}
		r.ParseForm() //nolint:errcheck // test
		if r.Form.Get("Action") != "AssumeRoleWithWebIdentity" {
			t.Errorf("action = %q", r.Form.Get("Action"))
		}
		if r.Form.Get("RoleArn") != "arn:aws:iam::123456789012:role/test" {
			t.Errorf("role = %q", r.Form.Get("RoleArn"))
		}
		if r.Form.Get("WebIdentityToken") != "jwt-token-content" {
			t.Errorf("token = %q", r.Form.Get("WebIdentityToken"))
		}

		xmlResp := stsAssumeRoleResponse{}
		xmlResp.Result.Credentials.AccessKeyID = "AKIA_IRSA"
		xmlResp.Result.Credentials.SecretAccessKey = "secret_irsa"
		xmlResp.Result.Credentials.SessionToken = "token_irsa"
		xmlResp.Result.Credentials.Expiration = expiry.Format(time.RFC3339)

		w.Header().Set("Content-Type", "text/xml")
		xml.NewEncoder(w).Encode(xmlResp) //nolint:errcheck // test
	}))
	defer ts.Close()

	tokenFile := filepath.Join(t.TempDir(), "web-identity-token")
	os.WriteFile(tokenFile, []byte("jwt-token-content"), 0600)

	cfg := types.AWSMachineIdentityConfig{
		Kind:        "irsa",
		RoleARN:     "arn:aws:iam::123456789012:role/test",
		Region:      "us-east-1",
		STSEndpoint: ts.URL,
	}
	p := NewIRSAProvider(cfg, tokenFile)

	creds, err := p.Retrieve(context.Background())
	if err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	if creds.AccessKeyID != "AKIA_IRSA" {
		t.Errorf("access key = %q", creds.AccessKeyID)
	}
	if creds.SecretAccessKey != "secret_irsa" {
		t.Errorf("secret = %q", creds.SecretAccessKey)
	}
	if creds.SessionToken != "token_irsa" {
		t.Errorf("token = %q", creds.SessionToken)
	}
	if !creds.ExpiresAt.Equal(expiry) {
		t.Errorf("expiry = %v, want %v", creds.ExpiresAt, expiry)
	}
}

func TestIRSAProvider_STSError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(403)
		w.Write([]byte(`<ErrorResponse><Error><Code>AccessDenied</Code><Message>not allowed</Message></Error></ErrorResponse>`))
	}))
	defer ts.Close()

	tokenFile := filepath.Join(t.TempDir(), "token")
	os.WriteFile(tokenFile, []byte("token"), 0600)

	cfg := types.AWSMachineIdentityConfig{
		Kind:        "irsa",
		RoleARN:     "arn:aws:iam::123456789012:role/test",
		STSEndpoint: ts.URL,
	}
	p := NewIRSAProvider(cfg, tokenFile)
	_, err := p.Retrieve(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "AccessDenied") {
		t.Errorf("error should contain AccessDenied: %v", err)
	}
	if strings.Contains(err.Error(), "token") {
		t.Errorf("error should not leak token: %v", err)
	}
}

func TestIRSAProvider_MissingTokenFile(t *testing.T) {
	cfg := types.AWSMachineIdentityConfig{
		Kind:        "irsa",
		RoleARN:     "arn:aws:iam::123456789012:role/test",
		STSEndpoint: "http://localhost:1",
	}
	p := NewIRSAProvider(cfg, "/nonexistent/token")
	_, err := p.Retrieve(context.Background())
	if err == nil || !strings.Contains(err.Error(), "read web identity token") {
		t.Fatalf("expected token file error, got: %v", err)
	}
}

// --- IRSA regional endpoint ---

func TestRegionalSTSEndpoint(t *testing.T) {
	tests := []struct {
		region string
		want   string
	}{
		{"", "https://sts.amazonaws.com"},
		{"us-east-1", "https://sts.us-east-1.amazonaws.com"},
		{"eu-west-1", "https://sts.eu-west-1.amazonaws.com"},
	}
	for _, tt := range tests {
		got := regionalSTSEndpoint(tt.region)
		if got != tt.want {
			t.Errorf("regionalSTSEndpoint(%q) = %q, want %q", tt.region, got, tt.want)
		}
	}
}

// --- Environment provider ---

func TestEnvProvider_CapturesAndScrubs(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIA_ENV")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret_env")
	t.Setenv("AWS_SESSION_TOKEN", "token_env")

	p, err := NewEnvProvider()
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if os.Getenv("AWS_ACCESS_KEY_ID") != "" {
		t.Error("AWS_ACCESS_KEY_ID not scrubbed")
	}
	if os.Getenv("AWS_SECRET_ACCESS_KEY") != "" {
		t.Error("AWS_SECRET_ACCESS_KEY not scrubbed")
	}
	if os.Getenv("AWS_SESSION_TOKEN") != "" {
		t.Error("AWS_SESSION_TOKEN not scrubbed")
	}

	creds, err := p.Retrieve(context.Background())
	if err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	if creds.AccessKeyID != "AKIA_ENV" {
		t.Errorf("access key = %q", creds.AccessKeyID)
	}
	if creds.SecretAccessKey != "secret_env" {
		t.Errorf("secret = %q", creds.SecretAccessKey)
	}
	if creds.SessionToken != "token_env" {
		t.Errorf("token = %q", creds.SessionToken)
	}
}

func TestEnvProvider_MissingVars(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")

	_, err := NewEnvProvider()
	if err == nil || !strings.Contains(err.Error(), "must both be set") {
		t.Fatalf("expected 'must both be set' error, got: %v", err)
	}
}

func TestEnvProvider_SessionTokenExpiry(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIA")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	t.Setenv("AWS_SESSION_TOKEN", "tok")

	p, err := NewEnvProvider()
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	creds, _ := p.Retrieve(context.Background())
	if !creds.ExpiresAt.IsZero() {
		t.Errorf("session-token environment credentials have no provider-reported expiry; got %v", creds.ExpiresAt)
	}
}

func TestEnvProvider_LongLivedWithoutSessionToken(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIA")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	t.Setenv("AWS_SESSION_TOKEN", "")

	p, err := NewEnvProvider()
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	creds, _ := p.Retrieve(context.Background())
	if !creds.ExpiresAt.IsZero() {
		t.Errorf("long-lived environment credentials have no provider-reported expiry; got %v", creds.ExpiresAt)
	}
}

// --- Factory ---

func TestNewAWSCredentialsProvider_NilConfig(t *testing.T) {
	_, err := NewAWSCredentialsProvider(nil, 0)
	if err == nil || !strings.Contains(err.Error(), "config is nil") {
		t.Fatalf("expected nil config error, got: %v", err)
	}
}

func TestNewAWSCredentialsProvider_UnknownKind(t *testing.T) {
	cfg := &types.AWSMachineIdentityConfig{Kind: "bogus"}
	_, err := NewAWSCredentialsProvider(cfg, 0)
	if err == nil || !strings.Contains(err.Error(), "unknown credential kind") {
		t.Fatalf("expected unknown kind error, got: %v", err)
	}
}

func TestNewAWSCredentialsProvider_IMDS(t *testing.T) {
	cfg := &types.AWSMachineIdentityConfig{Kind: "imds"}
	p, err := NewAWSCredentialsProvider(cfg, 0)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if p.Kind() != "imds" {
		t.Errorf("kind = %q", p.Kind())
	}
}

func TestNewAWSCredentialsProvider_ECS_MissingEnv(t *testing.T) {
	t.Setenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "")
	cfg := &types.AWSMachineIdentityConfig{Kind: "ecs"}
	_, err := NewAWSCredentialsProvider(cfg, 0)
	if err == nil || !strings.Contains(err.Error(), "RELATIVE_URI not set") {
		t.Fatalf("expected missing env error, got: %v", err)
	}
}

func TestNewAWSCredentialsProvider_EKS_MissingEnv(t *testing.T) {
	t.Setenv("AWS_CONTAINER_CREDENTIALS_FULL_URI", "")
	cfg := &types.AWSMachineIdentityConfig{Kind: "eks"}
	_, err := NewAWSCredentialsProvider(cfg, 0)
	if err == nil || !strings.Contains(err.Error(), "FULL_URI not set") {
		t.Fatalf("expected missing env error, got: %v", err)
	}
}

func TestNewAWSCredentialsProvider_IRSA_MissingTokenFile(t *testing.T) {
	t.Setenv("AWS_WEB_IDENTITY_TOKEN_FILE", "")
	cfg := &types.AWSMachineIdentityConfig{Kind: "irsa", RoleARN: "arn:aws:iam::123456789012:role/test"}
	_, err := NewAWSCredentialsProvider(cfg, 0)
	if err == nil || !strings.Contains(err.Error(), "TOKEN_FILE not set") {
		t.Fatalf("expected missing env error, got: %v", err)
	}
}

func TestNewAWSCredentialsProvider_IRSA_FallsBackToEnvRoleARN(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "token")
	os.WriteFile(tokenFile, []byte("jwt"), 0600)

	t.Setenv("AWS_WEB_IDENTITY_TOKEN_FILE", tokenFile)
	t.Setenv("AWS_ROLE_ARN", "arn:aws:iam::111111111111:role/env-role")

	cfg := &types.AWSMachineIdentityConfig{Kind: "irsa"}
	p, err := NewAWSCredentialsProvider(cfg, 0)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if p.Kind() != "irsa" {
		t.Errorf("kind = %q", p.Kind())
	}
}

func TestNewAWSCredentialsProvider_Env(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIA_FACTORY")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret_factory")

	cfg := &types.AWSMachineIdentityConfig{Kind: "env"}
	p, err := NewAWSCredentialsProvider(cfg, 0)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if p.Kind() != "env" {
		t.Errorf("kind = %q", p.Kind())
	}
}

func TestNewAWSCredentialsProvider_WrapsWithCache(t *testing.T) {
	cfg := &types.AWSMachineIdentityConfig{Kind: "imds"}
	p, err := NewAWSCredentialsProvider(cfg, 3*time.Minute)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	cached, ok := p.(*CachedAWSProvider)
	if !ok {
		t.Fatal("factory should return *CachedAWSProvider")
	}
	if cached.refreshThreshold != 3*time.Minute {
		t.Errorf("threshold = %v, want 3m", cached.refreshThreshold)
	}
}

// --- Context cancellation ---

func TestIMDSProvider_ContextCancellation(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(5 * time.Second)
	}))
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	p := NewIMDSProvider(ts.URL)
	_, err := p.Retrieve(ctx)
	if err == nil {
		t.Fatal("expected context deadline error")
	}
}

// --- sanitizeSTSError ---

func TestSanitizeSTSError_XMLParse(t *testing.T) {
	body := []byte(`<ErrorResponse><Error><Code>ExpiredToken</Code><Message>token is expired</Message></Error></ErrorResponse>`)
	got := sanitizeSTSError(body)
	if !strings.Contains(got, "ExpiredToken") {
		t.Errorf("expected ExpiredToken in %q", got)
	}
	if !strings.Contains(got, "token is expired") {
		t.Errorf("expected message in %q", got)
	}
}

func TestSanitizeSTSError_Truncation(t *testing.T) {
	body := make([]byte, 500)
	for i := range body {
		body[i] = 'x'
	}
	got := sanitizeSTSError(body)
	if len(got) > 256 {
		t.Errorf("expected truncation to 256, got %d", len(got))
	}
}
