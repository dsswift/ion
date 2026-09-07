package telemetry

import (
	"context"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// fakeExpiringProvider stands in for the engine's identity so the credential
// path can be exercised without a real Entra grant.
type fakeExpiringProvider struct {
	token      string
	err        error
	gotScope   string
	gotAudienc string
}

func (f *fakeExpiringProvider) GetToken(ctx context.Context, scope string) (string, error) {
	return f.GetTokenWithAudience(ctx, scope, "")
}
func (f *fakeExpiringProvider) GetTokenWithAudience(ctx context.Context, scope, audience string) (string, error) {
	t, _, err := f.GetTokenWithAudienceExpiry(ctx, scope, audience)
	return t, err
}
func (f *fakeExpiringProvider) GetTokenWithAudienceExpiry(_ context.Context, scope, audience string) (string, time.Time, error) {
	f.gotScope, f.gotAudienc = scope, audience
	if f.err != nil {
		return "", time.Time{}, f.err
	}
	return f.token, time.Now().Add(time.Hour), nil
}

func withProvider(t *testing.T, p auth.TokenProvider) {
	t.Helper()
	prev := currentTokenProvider
	currentTokenProvider = func() auth.TokenProvider { return p }
	t.Cleanup(func() { currentTokenProvider = prev })
}

// TestCredentialPrecedence pins the resolution order. The env var wins
// because it is the operator's most direct statement (and the container
// secret-mount path); a configured namespace beats a configured connection
// string because the secretless path should not lose to a secret that
// happens to also be present.
func TestCredentialPrecedence(t *testing.T) {
	cfg := types.TelemetryConfig{
		EventHubNamespace:        "ns.servicebus.windows.net",
		EventHubConnectionString: "Endpoint=sb://configured;",
	}

	t.Run("env wins over everything", func(t *testing.T) {
		t.Setenv(EventHubConnectionStringEnv, "Endpoint=sb://from-env;")
		mode, value := resolveEventHubCredentialMode(cfg)
		if mode != credentialModeEnvConnectionString {
			t.Fatalf("mode = %q, want %q", mode, credentialModeEnvConnectionString)
		}
		if value != "Endpoint=sb://from-env;" {
			t.Errorf("value = %q, want the env value", value)
		}
	})

	t.Run("namespace beats a configured connection string", func(t *testing.T) {
		mode, value := resolveEventHubCredentialMode(cfg)
		if mode != credentialModeToken {
			t.Fatalf("mode = %q, want %q — the secretless path must win", mode, credentialModeToken)
		}
		if value != "ns.servicebus.windows.net" {
			t.Errorf("value = %q, want the namespace", value)
		}
	})

	t.Run("connection string when it is all there is", func(t *testing.T) {
		mode, _ := resolveEventHubCredentialMode(types.TelemetryConfig{
			EventHubConnectionString: "Endpoint=sb://only;",
		})
		if mode != credentialModeConfigConnectionString {
			t.Fatalf("mode = %q, want %q", mode, credentialModeConfigConnectionString)
		}
	})

	t.Run("nothing configured is none", func(t *testing.T) {
		mode, _ := resolveEventHubCredentialMode(types.TelemetryConfig{})
		if mode != credentialModeNone {
			t.Fatalf("mode = %q, want %q", mode, credentialModeNone)
		}
	})
}

// TestNoCredentialFailsLoudly pins that a target configured with nowhere to
// send is an error naming the fix, not a silent no-op. The operator asked
// for this target; having no way to reach one is a misconfiguration.
func TestNoCredentialFailsLoudly(t *testing.T) {
	_, err := buildEventHubSender(credentialModeNone, "", types.TelemetryConfig{})
	if err == nil {
		t.Fatal("expected an error when no credential is configured")
	}
	for _, want := range []string{"eventHubNamespace", "eventHubConnectionString", EventHubConnectionStringEnv} {
		if !contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q, so it does not tell the operator how to fix it", err, want)
		}
	}
}

// TestTokenCredentialUsesConfiguredScope pins that the engine mints for the
// scope the operator granted, not whatever the SDK asks for. Substituting
// the caller's scope would mint tokens for a resource the operator never
// approved.
func TestTokenCredentialUsesConfiguredScope(t *testing.T) {
	fake := &fakeExpiringProvider{token: "tok-1"}
	withProvider(t, fake)

	cred := &engineTokenCredential{scope: "https://eventhubs.azure.net/.default", audience: "aud-1"}
	got, err := cred.GetToken(context.Background(), tokenRequestScopes("https://something.else/.default"))
	if err != nil {
		t.Fatalf("GetToken: %v", err)
	}
	if got.Token != "tok-1" {
		t.Errorf("token = %q, want tok-1", got.Token)
	}
	if fake.gotScope != "https://eventhubs.azure.net/.default" {
		t.Errorf("minted for scope %q, want the configured Event Hubs scope", fake.gotScope)
	}
	if fake.gotAudienc != "aud-1" {
		t.Errorf("minted for audience %q, want aud-1", fake.gotAudienc)
	}
	if got.ExpiresOn.IsZero() {
		t.Error("ExpiresOn is zero; the SDK would treat the token as already expired and re-mint every send")
	}
}

// TestTokenCredentialNoProvider pins the failure when the engine has no
// identity configured: an error naming the config key, not a nil deref.
func TestTokenCredentialNoProvider(t *testing.T) {
	withProvider(t, nil)
	cred := &engineTokenCredential{scope: DefaultEventHubTokenScope}
	if _, err := cred.GetToken(context.Background(), tokenRequestScopes(DefaultEventHubTokenScope)); err == nil {
		t.Fatal("expected an error with no identity provider configured")
	} else if !contains(err.Error(), "auth.identityProvider") {
		t.Errorf("error %q does not name the config key to set", err)
	}
}

// TestDefaultTokenScope pins that the Event Hubs resource scope is used
// unless overridden. Event Hubs rejects a token audienced elsewhere, so
// defaulting to an operator's own API scope would fail at send time.
func TestDefaultTokenScope(t *testing.T) {
	if got := eventHubTokenScope(types.TelemetryConfig{}); got != DefaultEventHubTokenScope {
		t.Errorf("default scope = %q, want %q", got, DefaultEventHubTokenScope)
	}
	if got := eventHubTokenScope(types.TelemetryConfig{EventHubTokenScope: "custom"}); got != "custom" {
		t.Errorf("configured scope = %q, want custom", got)
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
