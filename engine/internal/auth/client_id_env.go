package auth

import (
	"fmt"
	"os"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// withResolvedClientID returns cfg with ClientID read from the environment
// variable ClientIDEnv names, and ClientIDEnv cleared so resolving again is a
// no-op. A config without ClientIDEnv is returned unchanged. The variable is
// left set: a client ID is not a secret.
func withResolvedClientID(provider string, cfg types.OAuthConfig) (types.OAuthConfig, error) {
	if cfg.ClientIDEnv == "" {
		return cfg, nil
	}
	if cfg.ClientID != "" {
		return cfg, fmt.Errorf("auth.oauth.%s: clientId and clientIdEnv are mutually exclusive", provider)
	}
	if !validSecretEnvName(cfg.ClientIDEnv) {
		return cfg, fmt.Errorf("auth.oauth.%s: clientIdEnv must be an environment variable name, not an assignment", provider)
	}
	value := os.Getenv(cfg.ClientIDEnv)
	if value == "" {
		utils.LogWithFields(utils.LevelError, "auth.identity", "client id environment variable is empty", map[string]any{
			"provider": provider, "env": cfg.ClientIDEnv,
		})
		return cfg, fmt.Errorf("auth.oauth.%s: client id environment variable %q is empty", provider, cfg.ClientIDEnv)
	}
	utils.LogWithFields(utils.LevelInfo, "auth.identity", "client id read from environment", map[string]any{
		"provider": provider, "env": cfg.ClientIDEnv, "client_id": value,
	})
	cfg.ClientID = value
	cfg.ClientIDEnv = ""
	return cfg, nil
}
