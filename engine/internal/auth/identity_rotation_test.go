package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestIdentityManagerConcurrentScopesSerializeRefreshRotation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var calls atomic.Int32
	var firstRefresh string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		call := calls.Add(1)
		refresh := r.FormValue("refresh_token")
		if call == 1 {
			firstRefresh = refresh
		} else if refresh != "rt-2" {
			t.Errorf("second concurrent refresh used %q, want rotated rt-2", refresh)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at", "refresh_token": "rt-2", "expires_in": 3600,
		})
	}))
	defer server.Close()

	manager := NewIdentityManager("rotating", types.OAuthConfig{ClientID: "client", TokenURL: server.URL}, 0)
	seedGrant(t, manager, &TokenResponse{
		AccessToken: "stale", RefreshToken: "rt-1", ExpiresAt: time.Now().Add(-time.Minute),
	})

	start := make(chan struct{})
	var wg sync.WaitGroup
	for _, scope := range []string{"scope-a", "scope-b"} {
		wg.Add(1)
		go func(scope string) {
			defer wg.Done()
			<-start
			if _, err := manager.GetToken(context.Background(), scope); err != nil {
				t.Errorf("GetToken(%s): %v", scope, err)
			}
		}(scope)
	}
	close(start)
	wg.Wait()
	if firstRefresh != "rt-1" || calls.Load() != 2 {
		t.Fatalf("refresh sequence first=%q calls=%d", firstRefresh, calls.Load())
	}
}

func TestIdentityManagerConcurrentForceRefreshesSerializeRefreshRotation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		call := calls.Add(1)
		if want := "rt-" + strconv.Itoa(int(call)); r.FormValue("refresh_token") != want {
			t.Errorf("refresh %d used %q, want %q", call, r.FormValue("refresh_token"), want)
		}
		if err := json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at", "refresh_token": "rt-" + strconv.Itoa(int(call+1)), "expires_in": 3600,
		}); err != nil {
			t.Errorf("encode response: %v", err)
		}
	}))
	defer server.Close()

	manager := NewIdentityManager("rotating", types.OAuthConfig{ClientID: "client", TokenURL: server.URL}, 0)
	seedGrant(t, manager, &TokenResponse{
		AccessToken: "fresh", RefreshToken: "rt-1", ExpiresAt: time.Now().Add(time.Hour),
	})

	start := make(chan struct{})
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, _, err := manager.ForceRefreshTokenWithAudienceExpiry(context.Background(), "", ""); err != nil {
				t.Errorf("ForceRefreshTokenWithAudienceExpiry: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()

	if calls.Load() != 2 {
		t.Fatalf("refresh calls = %d, want 2", calls.Load())
	}
	stored, err := manager.loadStored()
	if err != nil {
		t.Fatalf("load stored grant: %v", err)
	}
	if stored.RefreshToken != "rt-3" {
		t.Errorf("stored refresh token = %q, want rt-3", stored.RefreshToken)
	}
}
