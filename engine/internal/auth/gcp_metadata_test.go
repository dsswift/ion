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

func TestGCPMetadataSource_Acquire_AccessToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.Header.Get("Metadata-Flavor") != "Google" {
			t.Errorf("missing Metadata-Flavor:Google header")
		}
		if !strings.Contains(r.URL.Path, "/default/token") {
			t.Errorf("expected /default/token in path, got %s", r.URL.Path)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(gcpTokenResponse{
			AccessToken: "gcp-access-token-abc",
			ExpiresIn:   3600,
			TokenType:   "Bearer",
		})
	}))
	defer srv.Close()

	src := NewGCPMetadataSource(
		GCPMachineIdentityConfig{},
		WithGCPEndpoint(srv.URL),
		WithGCPHTTPClient(srv.Client()),
	)

	token, expiresAt, err := src.Acquire(context.Background(), "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "gcp-access-token-abc" {
		t.Fatalf("expected gcp-access-token-abc, got %q", token)
	}
	if expiresAt.IsZero() {
		t.Fatal("expected non-zero expiry for access_token")
	}
	if time.Until(expiresAt) < 3500*time.Second {
		t.Fatalf("expiry too soon: %v", expiresAt)
	}
}

func TestGCPMetadataSource_Acquire_AccessTokenWithScopes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scopes := r.URL.Query().Get("scopes")
		if scopes != "https://www.googleapis.com/auth/cloud-platform" {
			t.Errorf("expected scopes param, got %q", scopes)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(gcpTokenResponse{
			AccessToken: "scoped-token",
			ExpiresIn:   3600,
		})
	}))
	defer srv.Close()

	src := NewGCPMetadataSource(
		GCPMachineIdentityConfig{},
		WithGCPEndpoint(srv.URL),
		WithGCPHTTPClient(srv.Client()),
	)

	token, _, err := src.Acquire(context.Background(), "https://www.googleapis.com/auth/cloud-platform", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "scoped-token" {
		t.Fatalf("expected scoped-token, got %q", token)
	}
}

func TestGCPMetadataSource_Acquire_IDToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/default/identity") {
			t.Errorf("expected /default/identity in path, got %s", r.URL.Path)
		}
		aud := r.URL.Query().Get("audience")
		if aud != "https://my-service.run.app" {
			t.Errorf("expected audience=https://my-service.run.app, got %q", aud)
		}
		if r.URL.Query().Get("format") != "full" {
			t.Errorf("expected format=full, got %q", r.URL.Query().Get("format"))
		}

		fmt.Fprint(w, "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJleHAiOjE3ODYzMTY3ODN9.sig")
	}))
	defer srv.Close()

	src := NewGCPMetadataSource(
		GCPMachineIdentityConfig{TokenType: "id_token"},
		WithGCPEndpoint(srv.URL),
		WithGCPHTTPClient(srv.Client()),
	)

	token, expiresAt, err := src.Acquire(context.Background(), "", "https://my-service.run.app")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasPrefix(token, "eyJ") {
		t.Fatalf("expected JWT-shaped token, got %q", token)
	}
	if expiresAt.IsZero() {
		t.Fatal("id_token expiry must come from JWT exp")
	}
}

func TestGCPMetadataSource_Acquire_IDTokenRequiresAudience(t *testing.T) {
	src := NewGCPMetadataSource(
		GCPMachineIdentityConfig{TokenType: "id_token"},
	)

	_, _, err := src.Acquire(context.Background(), "", "")
	if err == nil {
		t.Fatal("expected error for id_token without audience")
	}
	if !strings.Contains(err.Error(), "audience (resource) required") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGCPMetadataSource_Acquire_CustomServiceAccount(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/my-sa@proj.iam.gserviceaccount.com/token") {
			t.Errorf("expected custom SA in path, got %s", r.URL.Path)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(gcpTokenResponse{
			AccessToken: "custom-sa-token",
			ExpiresIn:   3600,
		})
	}))
	defer srv.Close()

	src := NewGCPMetadataSource(
		GCPMachineIdentityConfig{ServiceAccount: "my-sa@proj.iam.gserviceaccount.com"},
		WithGCPEndpoint(srv.URL),
		WithGCPHTTPClient(srv.Client()),
	)

	token, _, err := src.Acquire(context.Background(), "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "custom-sa-token" {
		t.Fatalf("expected custom-sa-token, got %q", token)
	}
}

func TestGCPMetadataSource_Acquire_RetriesTransient(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(gcpTokenResponse{
			AccessToken: "retry-token",
			ExpiresIn:   3600,
		})
	}))
	defer srv.Close()

	src := NewGCPMetadataSource(
		GCPMachineIdentityConfig{},
		WithGCPEndpoint(srv.URL),
		WithGCPHTTPClient(srv.Client()),
	)

	token, _, err := src.Acquire(context.Background(), "", "")
	if err != nil {
		t.Fatalf("expected success after retries, got: %v", err)
	}
	if token != "retry-token" {
		t.Fatalf("expected retry-token, got %q", token)
	}
	if calls.Load() != 3 {
		t.Fatalf("expected 3 calls, got %d", calls.Load())
	}
}

func TestGCPMetadataSource_Acquire_NoRetryOn404(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, "not found")
	}))
	defer srv.Close()

	src := NewGCPMetadataSource(
		GCPMachineIdentityConfig{},
		WithGCPEndpoint(srv.URL),
		WithGCPHTTPClient(srv.Client()),
	)

	_, _, err := src.Acquire(context.Background(), "", "")
	if err == nil {
		t.Fatal("expected error for 404")
	}
	if calls.Load() != 1 {
		t.Fatalf("expected 1 call (no retry for 404), got %d", calls.Load())
	}
}

func TestGCPMetadataSource_Acquire_EmptyAccessToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(gcpTokenResponse{AccessToken: ""})
	}))
	defer srv.Close()

	src := NewGCPMetadataSource(
		GCPMachineIdentityConfig{},
		WithGCPEndpoint(srv.URL),
		WithGCPHTTPClient(srv.Client()),
	)

	_, _, err := src.Acquire(context.Background(), "", "")
	if err == nil {
		t.Fatal("expected error for empty access token")
	}
	if !strings.Contains(err.Error(), "empty access_token") {
		t.Fatalf("unexpected error: %v", err)
	}
}
