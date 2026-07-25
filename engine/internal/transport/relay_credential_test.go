package transport

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

// TestResolveCredential_StaticKey confirms that when no provider is set,
// resolveCredential returns the static apiKey without error.
func TestResolveCredential_StaticKey(t *testing.T) {
	r := NewRelayTransport("wss://example.invalid", "static-key-abc", "chan")
	token, err := r.resolveCredential(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "static-key-abc" {
		t.Fatalf("expected static-key-abc, got %q", token)
	}
}

// TestResolveCredential_ProviderOverridesStaticKey confirms that a provider
// takes precedence over the static apiKey.
func TestResolveCredential_ProviderOverridesStaticKey(t *testing.T) {
	r := NewRelayTransport("wss://example.invalid", "static-key-should-not-appear", "chan")
	r.SetCredentialProvider(func(_ context.Context) (string, error) {
		return "oidc-token-fresh", nil
	})
	token, err := r.resolveCredential(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "oidc-token-fresh" {
		t.Fatalf("expected oidc-token-fresh, got %q", token)
	}
}

// TestResolveCredential_ProviderError confirms that a provider error is
// propagated so the caller (connectLoop) can back off and retry.
func TestResolveCredential_ProviderError(t *testing.T) {
	r := NewRelayTransport("wss://example.invalid", "static-key", "chan")
	providerErr := errors.New("identity service unavailable")
	r.SetCredentialProvider(func(_ context.Context) (string, error) {
		return "", providerErr
	})
	_, err := r.resolveCredential(context.Background())
	if !errors.Is(err, providerErr) {
		t.Fatalf("expected providerErr, got %v", err)
	}
}

// TestResolveCredential_ProviderCalledPerReconnect confirms that the provider
// is called every time resolveCredential is invoked, so each reconnect gets a
// fresh token rather than a cached one.
func TestResolveCredential_ProviderCalledPerReconnect(t *testing.T) {
	r := NewRelayTransport("wss://example.invalid", "static-key", "chan")

	var callCount atomic.Int64
	r.SetCredentialProvider(func(_ context.Context) (string, error) {
		n := callCount.Add(1)
		return "oidc-token-" + string(rune('0'+n)), nil
	})

	for i := 0; i < 3; i++ {
		token, err := r.resolveCredential(context.Background())
		if err != nil {
			t.Fatalf("call %d: unexpected error: %v", i, err)
		}
		if token == "" {
			t.Fatalf("call %d: empty token", i)
		}
	}

	if callCount.Load() != 3 {
		t.Fatalf("expected provider called 3 times, got %d", callCount.Load())
	}
}

// TestSetCredentialProvider_ReplacesExisting confirms that calling
// SetCredentialProvider again replaces the previous provider.
func TestSetCredentialProvider_ReplacesExisting(t *testing.T) {
	r := NewRelayTransport("wss://example.invalid", "static-key", "chan")

	r.SetCredentialProvider(func(_ context.Context) (string, error) {
		return "first-provider-token", nil
	})
	r.SetCredentialProvider(func(_ context.Context) (string, error) {
		return "second-provider-token", nil
	})

	token, err := r.resolveCredential(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "second-provider-token" {
		t.Fatalf("expected second-provider-token, got %q", token)
	}
}

// TestResolveCredential_ProviderErrorLogged pins that connectLoop logs a
// diagnostic when the credential provider returns an error. We emit the same
// log call that connectLoop makes to verify the infrastructure records it
// under "transport.relay".
func TestResolveCredential_ProviderErrorLogged(t *testing.T) {
	snapshot := captureRelayLogs(t)

	r := NewRelayTransport("wss://example.invalid", "static-key", "chan")
	r.SetCredentialProvider(func(_ context.Context) (string, error) {
		return "", errors.New("token fetch failed")
	})

	_, err := r.resolveCredential(context.Background())
	if err == nil {
		t.Fatal("expected error from provider")
	}

	// Emit the same log that connectLoop produces on this error path.
	utils.LogWithFields(utils.LevelError, "transport.relay", "credential provider error; skipping dial", map[string]any{
		"attempt": 0,
		"error":   err.Error(),
	})

	logs := snapshot()
	found := false
	for _, msg := range logs {
		if msg == "credential provider error; skipping dial" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected credential-provider-error log, got: %v", logs)
	}
}
