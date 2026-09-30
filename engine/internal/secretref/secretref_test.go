package secretref

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/appconfig"
	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestResolveCredentialStoreReadsOwnPartitionOnly(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	store := auth.NewFileStore()
	if err := store.SetKeyFor("", "metrics-api-key", "shared-value"); err != nil {
		t.Fatalf("seed shared: %v", err)
	}
	if err := store.SetKeyFor("user-a", "metrics-api-key", "user-a-value"); err != nil {
		t.Fatalf("seed user-a: %v", err)
	}
	ref := types.SecretReference{SecretRef: "metrics-api-key"}
	for subject, want := range map[string]string{"": "shared-value", "user-a": "user-a-value"} {
		if got, err := Resolve(Reader{Principal: subject}, ref); err != nil || got != want {
			t.Fatalf("subject %q: got %q, %v", subject, got, err)
		}
	}
	if _, err := Resolve(Reader{Principal: "user-b"}, ref); err == nil {
		t.Fatal("a principal with no entry must not read the shared one")
	}
}

func TestResolveApplicationConfigSource(t *testing.T) {
	prev := applicationConfig
	t.Cleanup(func() { applicationConfig = prev })
	applicationConfig = func(reader Reader, key string) (string, error) {
		if reader.Principal == "user-a" && reader.ExtensionID == "orion" && key == "gatewayKey" {
			return "gk-value", nil
		}
		return "", appconfig.NotReadyError{State: appconfig.StateDeferred}
	}
	ref := types.SecretReference{SecretRef: "gatewayKey", SecretSource: types.SecretSourceApplicationConfig}
	if got, err := Resolve(Reader{Principal: "user-a", ExtensionID: "orion"}, ref); err != nil || got != "gk-value" {
		t.Fatalf("got %q, %v", got, err)
	}
	_, err := Resolve(Reader{Principal: "user-b", ExtensionID: "orion"}, ref)
	var notReady appconfig.NotReadyError
	if !errors.As(err, &notReady) {
		t.Fatalf("the source's condition must stay inspectable: %v", err)
	}
}

func TestValidateRejectsUnknownSource(t *testing.T) {
	for _, ref := range []types.SecretReference{{}, {SecretRef: "k", SecretSource: "vault"}} {
		if err := Validate(ref); err == nil {
			t.Fatalf("%+v must be invalid", ref)
		}
	}
	if _, err := Resolve(Reader{}, types.SecretReference{SecretRef: "k", SecretSource: "vault"}); err == nil || !strings.Contains(err.Error(), "unknown secretSource") {
		t.Fatalf("resolve of unknown source: %v", err)
	}
}

func TestReaderRidesContext(t *testing.T) {
	if got := ReaderFromContext(context.Background()); got != (Reader{}) {
		t.Fatalf("absent reader: %+v", got)
	}
	want := Reader{Principal: "user-a", ExtensionID: "orion"}
	if got := ReaderFromContext(WithReader(context.Background(), want)); got != want {
		t.Fatalf("reader = %+v", got)
	}
}
