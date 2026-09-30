// Package secretref resolves a types.SecretReference to its secret value at
// the moment of use. It is the one lookup behind every engine surface that
// injects a secret it never hands out: protected operations and MCP secret
// headers. Values are never logged or wrapped into an error.
package secretref

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/appconfig"
	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Reader identifies who a secret is read for. Each source scopes by the
// part that applies to it.
type Reader struct {
	// Principal is the acting session principal's subject. It selects the
	// credential-store partition; empty reads the shared partition.
	Principal string
	// ExtensionID is the calling extension's enterprise-allowlist identity,
	// set by the engine, never by the caller. It selects the extension's own
	// application config section; empty reads the common section only.
	ExtensionID string
}

type readerKey struct{}

// WithReader returns ctx carrying reader.
func WithReader(ctx context.Context, reader Reader) context.Context {
	return context.WithValue(ctx, readerKey{}, reader)
}

// ReaderFromContext returns the reader ctx carries, or the zero Reader (the
// shared partition and the common section).
func ReaderFromContext(ctx context.Context) Reader {
	reader, _ := ctx.Value(readerKey{}).(Reader) //nolint:errcheck // absent means the zero Reader
	return reader
}

// credentialStore reads the principal's own credential-store partition. An
// attributed principal never falls back to the shared partition.
var credentialStore = func(reader Reader, ref string) (string, error) {
	return auth.NewFileStore().GetKeyFor(reader.Principal, ref)
}

// applicationConfig reads a secret from the in-memory application config as
// the reader's principal and extension would see it.
var applicationConfig = func(reader Reader, key string) (string, error) {
	return appconfig.ReadSecret(reader.Principal, reader.ExtensionID, key)
}

// Validate checks a reference without resolving it.
func Validate(ref types.SecretReference) error {
	if ref.SecretRef == "" {
		return fmt.Errorf("secretRef is required")
	}
	switch ref.SecretSource {
	case "", types.SecretSourceCredentialStore, types.SecretSourceApplicationConfig:
		return nil
	default:
		return fmt.Errorf("unknown secretSource %q (want %q or %q)", ref.SecretSource, types.SecretSourceCredentialStore, types.SecretSourceApplicationConfig)
	}
}

// Source returns the effective source name of ref.
func Source(ref types.SecretReference) string {
	if ref.SecretSource == "" {
		return types.SecretSourceCredentialStore
	}
	return ref.SecretSource
}

// Resolve returns the secret ref names, as seen by reader.
func Resolve(reader Reader, ref types.SecretReference) (string, error) {
	if err := Validate(ref); err != nil {
		return "", err
	}
	source := Source(ref)
	var value string
	var err error
	if source == types.SecretSourceApplicationConfig {
		value, err = applicationConfig(reader, ref.SecretRef)
	} else {
		value, err = credentialStore(reader, ref.SecretRef)
	}
	if err == nil && value == "" {
		err = fmt.Errorf("secret is empty")
	}
	fields := map[string]any{"subject": reader.Principal, "trusted_id": reader.ExtensionID, "secret_ref": ref.SecretRef, "source": source}
	if err != nil {
		fields["error"] = err.Error()
		utils.LogWithFields(utils.LevelWarn, "secretref", "secret unavailable", fields)
		return "", fmt.Errorf("secret %q from %s is not available: %w", ref.SecretRef, source, err)
	}
	utils.LogWithFields(utils.LevelDebug, "secretref", "secret resolved", fields)
	return value, nil
}
