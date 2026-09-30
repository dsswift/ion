// Package secretref resolves a types.SecretReference to its secret value at
// the moment of use. It is the one lookup behind every engine surface that
// injects a secret it never hands out: protected operations and MCP secret
// headers. Values are never logged or wrapped into an error.
package secretref

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/appconfig"
	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// credentialStore reads subject's own credential-store partition. An
// attributed subject never falls back to the shared partition.
var credentialStore = func(subject, ref string) (string, error) {
	return auth.NewFileStore().GetKeyFor(subject, ref)
}

// applicationConfig reads a declared secret key from the in-memory
// application config, scoped to subject.
var applicationConfig = appconfig.ReadSecret

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

// Resolve returns the secret ref names, as seen by subject.
func Resolve(subject string, ref types.SecretReference) (string, error) {
	if err := Validate(ref); err != nil {
		return "", err
	}
	source := Source(ref)
	var value string
	var err error
	if source == types.SecretSourceApplicationConfig {
		value, err = applicationConfig(subject, ref.SecretRef)
	} else {
		value, err = credentialStore(subject, ref.SecretRef)
	}
	if err == nil && value == "" {
		err = fmt.Errorf("secret is empty")
	}
	fields := map[string]any{"subject": subject, "secret_ref": ref.SecretRef, "source": source}
	if err != nil {
		fields["error"] = err.Error()
		utils.LogWithFields(utils.LevelWarn, "secretref", "secret unavailable", fields)
		return "", fmt.Errorf("secret %q from %s is not available: %w", ref.SecretRef, source, err)
	}
	utils.LogWithFields(utils.LevelDebug, "secretref", "secret resolved", fields)
	return value, nil
}
