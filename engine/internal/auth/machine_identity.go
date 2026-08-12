package auth

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// MachineIdentityManager implements TokenProvider for a non-interactive
// workload identity. It has no human identity and never persists access tokens.
type MachineIdentityManager struct {
	provider        string
	sourceKind      string
	defaultScope    string
	defaultAudience string
	source          TokenSource
	cache           *machineTokenCache
	aws             AWSCredentialsProvider
}

// NewMachineIdentityManager validates and builds the configured machine source.
// Secret environment variables are consumed and removed before returning, so
// later extension/tool subprocesses cannot inherit them.
func NewMachineIdentityManager(provider string, cfg types.OAuthConfig, refreshThresholdMs int64) (*MachineIdentityManager, error) {
	if cfg.MachineIdentity == nil {
		return nil, fmt.Errorf("machine identity config is missing")
	}
	mi := cfg.MachineIdentity
	if err := validateMachineIdentityShape(mi); err != nil {
		return nil, err
	}
	threshold := defaultRefreshThreshold
	if refreshThresholdMs > 0 {
		threshold = time.Duration(refreshThresholdMs) * time.Millisecond
	}
	m := &MachineIdentityManager{
		provider:        provider,
		sourceKind:      mi.Source,
		defaultScope:    strings.Join(cfg.Scopes, " "),
		defaultAudience: cfg.Audience,
		cache:           newMachineTokenCache(threshold),
	}

	var err error
	switch mi.Source {
	case "client_secret":
		var secret string
		if mi.ClientSecretEnv != "" && mi.ClientSecretFile != "" {
			return nil, fmt.Errorf("client_secret requires exactly one of clientSecretEnv or clientSecretFile")
		}
		if mi.ClientSecretEnv != "" && !validSecretEnvName(mi.ClientSecretEnv) {
			return nil, fmt.Errorf("clientSecretEnv must be an environment variable name, not an assignment")
		}
		switch {
		case mi.ClientSecretEnv != "":
			secret = os.Getenv(mi.ClientSecretEnv)
			if secret == "" {
				return nil, fmt.Errorf("client secret environment variable %q is empty", mi.ClientSecretEnv)
			}
			if unsetErr := os.Unsetenv(mi.ClientSecretEnv); unsetErr != nil {
				return nil, fmt.Errorf("remove client secret environment variable %q: %w", mi.ClientSecretEnv, unsetErr)
			}
		case mi.ClientSecretFile != "":
			var raw []byte
			raw, err = os.ReadFile(mi.ClientSecretFile)
			if err == nil {
				secret = strings.TrimSpace(string(raw))
			}
		default:
			return nil, fmt.Errorf("client_secret requires clientSecretEnv or clientSecretFile")
		}
		if err != nil {
			return nil, fmt.Errorf("read client secret file: %w", err)
		}
		m.source, err = newClientCredentialsSource(cfg, clientCredentialsSecret{value: secret})
	case "certificate":
		m.source, err = newCertificateSource(cfg, mi.CertificatePath, mi.CertificateKeyPath)
	case "federated_assertion":
		m.source, err = newFederatedAssertionSource(cfg, mi.FederatedTokenFile)
	case "azure_managed_identity":
		azureCfg := AzureMachineIdentityConfig{}
		if mi.Azure != nil {
			azureCfg.ClientID = mi.Azure.ClientID
		}
		m.source = NewAzureIdentitySource(azureCfg)
	case "gcp_managed_identity":
		gcpCfg := GCPMachineIdentityConfig{}
		if mi.GCP != nil {
			gcpCfg.ServiceAccount = mi.GCP.ServiceAccount
			gcpCfg.TokenType = mi.GCP.TokenType
		}
		m.source = NewGCPMetadataSource(gcpCfg)
	case "credential_process":
		if mi.CredentialProcess == nil {
			return nil, fmt.Errorf("credential_process requires credentialProcess config")
		}
		m.source, err = NewCredentialProcessSource(CredentialProcessConfig{
			Command: mi.CredentialProcess.Command, TimeoutMs: mi.CredentialProcess.TimeoutMs,
		})
	case "aws":
		if mi.AWS == nil {
			return nil, fmt.Errorf("aws source requires aws config")
		}
		m.aws, err = NewAWSCredentialsProvider(mi.AWS, threshold)
	default:
		return nil, fmt.Errorf("unsupported machine identity source %q", mi.Source)
	}
	if err != nil {
		return nil, fmt.Errorf("machine identity %q: %w", provider, err)
	}
	return m, nil
}

func validateMachineIdentityShape(config *types.MachineIdentityConfig) error {
	populated := map[string]bool{
		"client_secret":          config.ClientSecretEnv != "" || config.ClientSecretFile != "",
		"certificate":            config.CertificatePath != "" || config.CertificateKeyPath != "",
		"federated_assertion":    config.FederatedTokenFile != "",
		"azure_managed_identity": config.Azure != nil,
		"gcp_managed_identity":   config.GCP != nil,
		"aws":                    config.AWS != nil,
		"credential_process":     config.CredentialProcess != nil,
	}
	for source, present := range populated {
		if present && source != config.Source {
			return fmt.Errorf("machine identity source %q also contains %s configuration", config.Source, source)
		}
	}
	return nil
}

func validSecretEnvName(name string) bool {
	if name == "" {
		return false
	}
	for index, char := range name {
		if (char >= 'A' && char <= 'Z') || char == '_' || (index > 0 && char >= '0' && char <= '9') {
			continue
		}
		return false
	}
	return true
}

func (m *MachineIdentityManager) GetToken(ctx context.Context, scope string) (string, error) {
	return m.GetTokenWithAudience(ctx, scope, "")
}

func (m *MachineIdentityManager) GetTokenWithAudience(ctx context.Context, scope, audience string) (string, error) {
	if m.source == nil {
		return "", fmt.Errorf("machine identity source %q provides AWS credentials, not OAuth bearer tokens", m.sourceKind)
	}
	if scope == "" {
		scope = m.defaultScope
	}
	if audience == "" {
		audience = m.defaultAudience
	}
	return m.cache.getOrAcquire(ctx, m.provider, m.sourceKind, scope, audience, func(ctx context.Context) (string, time.Time, error) {
		return m.source.Acquire(ctx, scope, audience)
	})
}

// AWSProvider returns the configured AWS credential provider, or nil for bearer sources.
func (m *MachineIdentityManager) AWSProvider() AWSCredentialsProvider { return m.aws }

func (m *MachineIdentityManager) LastExpiry(scope, audience string) string {
	if scope == "" {
		scope = m.defaultScope
	}
	if audience == "" {
		audience = m.defaultAudience
	}
	expiry := m.cache.expiry(scope, audience)
	if expiry.IsZero() {
		return ""
	}
	return expiry.UTC().Format(time.RFC3339)
}

func (m *MachineIdentityManager) Provider() string   { return m.provider }
func (m *MachineIdentityManager) SourceKind() string { return m.sourceKind }
