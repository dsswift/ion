package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAzureIdentitySource_ContainerAppsEndpoint(t *testing.T) {
	expiresOn := fmt.Sprintf("%d", time.Now().Add(time.Hour).Unix())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-IDENTITY-HEADER"); got != "platform-secret" {
			t.Errorf("X-IDENTITY-HEADER = %q", got)
		}
		if got := r.URL.Query().Get("api-version"); got != azureEndpointAPIVer {
			t.Errorf("api-version = %q", got)
		}
		_ = json.NewEncoder(w).Encode(azureTokenResponse{AccessToken: "container-token", ExpiresOn: expiresOn})
	}))
	defer server.Close()
	t.Setenv("IDENTITY_ENDPOINT", server.URL)
	t.Setenv("IDENTITY_HEADER", "platform-secret")

	source := NewAzureIdentitySource(AzureMachineIdentityConfig{}, WithAzureHTTPClient(server.Client()))
	token, _, err := source.Acquire(context.Background(), "", "https://management.azure.com/")
	if err != nil {
		t.Fatal(err)
	}
	if token != "container-token" {
		t.Fatalf("token = %q", token)
	}
}

func TestAzureIdentitySource_ContainerEndpointRequiresHeader(t *testing.T) {
	t.Setenv("IDENTITY_ENDPOINT", "http://localhost/token")
	t.Setenv("IDENTITY_HEADER", "")
	source := NewAzureIdentitySource(AzureMachineIdentityConfig{})
	_, _, err := source.Acquire(context.Background(), "", "https://management.azure.com/")
	if err == nil || !strings.Contains(err.Error(), "IDENTITY_HEADER") {
		t.Fatalf("expected IDENTITY_HEADER error, got %v", err)
	}
}

func TestAzureIdentitySource_Acquire_Success(t *testing.T) {
	expiresOn := fmt.Sprintf("%d", time.Now().Add(time.Hour).Unix())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.Header.Get("Metadata") != "true" {
			t.Errorf("missing Metadata:true header")
		}
		if r.URL.Query().Get("api-version") != azureIMDSAPIVer {
			t.Errorf("wrong api-version: %s", r.URL.Query().Get("api-version"))
		}
		if r.URL.Query().Get("resource") != "https://management.azure.com" {
			t.Errorf("wrong resource: %s", r.URL.Query().Get("resource"))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(azureTokenResponse{
			AccessToken: "azure-token-123",
			ExpiresOn:   expiresOn,
			Resource:    "https://management.azure.com",
			TokenType:   "Bearer",
		})
	}))
	defer srv.Close()

	src := NewAzureIdentitySource(
		AzureMachineIdentityConfig{},
		WithAzureEndpoint(srv.URL),
		WithAzureHTTPClient(srv.Client()),
	)

	token, expiresAt, err := src.Acquire(context.Background(), "", "https://management.azure.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "azure-token-123" {
		t.Fatalf("expected azure-token-123, got %q", token)
	}
	if expiresAt.IsZero() {
		t.Fatal("expected non-zero expiry")
	}
}

func TestAzureIdentitySource_Acquire_ScopeDefault(t *testing.T) {
	expiresOn := fmt.Sprintf("%d", time.Now().Add(time.Hour).Unix())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("resource") != "https://management.azure.com" {
			t.Errorf("wrong resource: %s", r.URL.Query().Get("resource"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(azureTokenResponse{
			AccessToken: "scope-token",
			ExpiresOn:   expiresOn,
		})
	}))
	defer srv.Close()

	src := NewAzureIdentitySource(
		AzureMachineIdentityConfig{},
		WithAzureEndpoint(srv.URL),
		WithAzureHTTPClient(srv.Client()),
	)

	token, _, err := src.Acquire(context.Background(), "https://management.azure.com/.default", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "scope-token" {
		t.Fatalf("expected scope-token, got %q", token)
	}
}

func TestAzureIdentitySource_Acquire_WithClientID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clientID := r.URL.Query().Get("client_id")
		if clientID != "my-client-id" {
			t.Errorf("expected client_id=my-client-id, got %q", clientID)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(azureTokenResponse{
			AccessToken: "token-with-client-id",
			ExpiresOn:   fmt.Sprintf("%d", time.Now().Add(time.Hour).Unix()),
		})
	}))
	defer srv.Close()

	src := NewAzureIdentitySource(
		AzureMachineIdentityConfig{ClientID: "my-client-id"},
		WithAzureEndpoint(srv.URL),
		WithAzureHTTPClient(srv.Client()),
	)

	token, _, err := src.Acquire(context.Background(), "", "https://vault.azure.net")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "token-with-client-id" {
		t.Fatalf("expected token-with-client-id, got %q", token)
	}
}

func TestAzureIdentitySource_Acquire_NoResourceOrScope(t *testing.T) {
	src := NewAzureIdentitySource(AzureMachineIdentityConfig{})
	_, _, err := src.Acquire(context.Background(), "", "")
	if err == nil {
		t.Fatal("expected error for empty resource and scope")
	}
	if !strings.Contains(err.Error(), "resource/audience") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestAzureIdentitySource_Acquire_RetriesTransient(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n <= 2 {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, "transient error")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(azureTokenResponse{
			AccessToken: "retry-success-token",
			ExpiresOn:   fmt.Sprintf("%d", time.Now().Add(time.Hour).Unix()),
		})
	}))
	defer srv.Close()

	src := NewAzureIdentitySource(
		AzureMachineIdentityConfig{},
		WithAzureEndpoint(srv.URL),
		WithAzureHTTPClient(srv.Client()),
	)

	token, _, err := src.Acquire(context.Background(), "", "https://management.azure.com")
	if err != nil {
		t.Fatalf("expected success after retries, got: %v", err)
	}
	if token != "retry-success-token" {
		t.Fatalf("expected retry-success-token, got %q", token)
	}
	if calls.Load() != 3 {
		t.Fatalf("expected 3 calls (2 failures + 1 success), got %d", calls.Load())
	}
}

func TestAzureIdentitySource_Acquire_NoRetryOn4xx(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(azureErrorResponse{
			Error:            "invalid_resource",
			ErrorDescription: "The resource is not valid",
		})
	}))
	defer srv.Close()

	src := NewAzureIdentitySource(
		AzureMachineIdentityConfig{},
		WithAzureEndpoint(srv.URL),
		WithAzureHTTPClient(srv.Client()),
	)

	_, _, err := src.Acquire(context.Background(), "", "bad-resource")
	if err == nil {
		t.Fatal("expected error for 400 response")
	}
	if calls.Load() != 1 {
		t.Fatalf("expected 1 call (no retry for 400), got %d", calls.Load())
	}
	if !strings.Contains(err.Error(), "invalid_resource") {
		t.Fatalf("expected error to contain error code, got: %v", err)
	}
}

func TestAzureIdentitySource_Acquire_RetriesExhausted(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	src := NewAzureIdentitySource(
		AzureMachineIdentityConfig{},
		WithAzureEndpoint(srv.URL),
		WithAzureHTTPClient(srv.Client()),
	)

	_, _, err := src.Acquire(context.Background(), "", "https://management.azure.com")
	if err == nil {
		t.Fatal("expected error after retries exhausted")
	}
	if !strings.Contains(err.Error(), "retries exhausted") {
		t.Fatalf("expected retries exhausted error, got: %v", err)
	}
	expectedCalls := int32(azureMaxRetries + 1)
	if calls.Load() != expectedCalls {
		t.Fatalf("expected %d calls, got %d", expectedCalls, calls.Load())
	}
}

func TestAzureIdentitySource_Acquire_ContextCancelled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	src := NewAzureIdentitySource(
		AzureMachineIdentityConfig{},
		WithAzureEndpoint(srv.URL),
		WithAzureHTTPClient(srv.Client()),
	)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, _, err := src.Acquire(ctx, "", "https://management.azure.com")
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
}

func TestAzureIdentitySource_ExpiresInFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(azureTokenResponse{AccessToken: "token", ExpiresIn: "3600"})
	}))
	defer server.Close()
	source := NewAzureIdentitySource(AzureMachineIdentityConfig{}, WithAzureEndpoint(server.URL), WithAzureHTTPClient(server.Client()))
	_, expiry, err := source.Acquire(context.Background(), "", "https://management.azure.com/")
	if err != nil {
		t.Fatal(err)
	}
	if expiry.Before(time.Now().Add(59 * time.Minute)) {
		t.Fatalf("expires_in fallback produced %v", expiry)
	}
}

func TestAzureIdentitySource_Acquire_EmptyAccessToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(azureTokenResponse{
			AccessToken: "",
			ExpiresOn:   fmt.Sprintf("%d", time.Now().Add(time.Hour).Unix()),
		})
	}))
	defer srv.Close()

	src := NewAzureIdentitySource(
		AzureMachineIdentityConfig{},
		WithAzureEndpoint(srv.URL),
		WithAzureHTTPClient(srv.Client()),
	)

	_, _, err := src.Acquire(context.Background(), "", "https://management.azure.com")
	if err == nil {
		t.Fatal("expected error for empty access token")
	}
	if !strings.Contains(err.Error(), "empty access_token") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestParseUnixTimestamp(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		isZero bool
	}{
		{"valid", "1700000000", false},
		{"empty", "", true},
		{"negative", "-1", true},
		{"garbage", "not-a-number", true},
		{"zero", "0", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := parseUnixTimestamp(tt.input)
			if tt.isZero && !result.IsZero() {
				t.Fatalf("expected zero time for %q, got %v", tt.input, result)
			}
			if !tt.isZero && result.IsZero() {
				t.Fatalf("expected non-zero time for %q", tt.input)
			}
		})
	}
}

func TestIsRetryableHTTPError(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		retryable bool
	}{
		{"500", &httpError{statusCode: 500, message: "internal"}, true},
		{"503", &httpError{statusCode: 503, message: "unavailable"}, true},
		{"429", &httpError{statusCode: 429, message: "throttled"}, true},
		{"408", &httpError{statusCode: 408, message: "timeout"}, true},
		{"400", &httpError{statusCode: 400, message: "bad request"}, false},
		{"401", &httpError{statusCode: 401, message: "unauthorized"}, false},
		{"403", &httpError{statusCode: 403, message: "forbidden"}, false},
		{"404", &httpError{statusCode: 404, message: "not found"}, false},
		{"plain error", fmt.Errorf("connection refused"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isRetryableHTTPError(tt.err)
			if got != tt.retryable {
				t.Fatalf("isRetryableHTTPError(%v) = %v, want %v", tt.err, got, tt.retryable)
			}
		})
	}
}

func TestRedactError(t *testing.T) {
	if redactError(nil) != "" {
		t.Fatal("expected empty string for nil error")
	}
	short := fmt.Errorf("short error")
	if redactError(short) != "short error" {
		t.Fatalf("unexpected: %s", redactError(short))
	}
	long := fmt.Errorf("%s", strings.Repeat("x", 300))
	result := redactError(long)
	if len(result) > 220 {
		t.Fatalf("expected truncation, got len %d", len(result))
	}
	if !strings.Contains(result, "[redacted]") {
		t.Fatal("expected [redacted] suffix")
	}
}

func TestParseRetryAfter(t *testing.T) {
	if d := parseRetryAfter("5"); d != 5*time.Second {
		t.Fatalf("expected 5s, got %v", d)
	}
	if d := parseRetryAfter(""); d != 0 {
		t.Fatalf("expected 0, got %v", d)
	}
	if d := parseRetryAfter("not-a-number"); d != 0 {
		t.Fatalf("expected 0, got %v", d)
	}
}

func TestAzureResource(t *testing.T) {
	r, err := azureResource("", "https://management.azure.com")
	if err != nil || r != "https://management.azure.com" {
		t.Fatalf("audience path: got %q, %v", r, err)
	}

	r, err = azureResource("https://management.azure.com/.default", "")
	if err != nil || r != "https://management.azure.com" {
		t.Fatalf("scope path: got %q, %v", r, err)
	}

	_, err = azureResource("plain-scope", "")
	if err == nil {
		t.Fatal("expected error for scope without /.default")
	}

	_, err = azureResource("", "")
	if err == nil {
		t.Fatal("expected error for empty scope and audience")
	}
}
