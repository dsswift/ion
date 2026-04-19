package types

// --- Profile Config (from engine/src/config/types.ts) ---

// EngineProfileConfig defines an extension profile stored in settings.
type EngineProfileConfig struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	ExtensionDir string         `json:"extensionDir"`
	Model        string         `json:"model,omitempty"`
	Options      map[string]any `json:"options,omitempty"`
}

// --- Enterprise Config (MDM/system-level, sealed from below) ---

// HookDef defines an event hook binding.
type HookDef struct {
	Event   string `json:"event"`
	Handler string `json:"handler"`
}

// EnterpriseConfig represents MDM/system-level sealed configuration.
type EnterpriseConfig struct {
	AllowedModels    []string               `json:"allowedModels,omitempty"`
	BlockedModels    []string               `json:"blockedModels,omitempty"`
	AllowedProviders []string               `json:"allowedProviders,omitempty"`
	RequiredHooks    []HookDef              `json:"requiredHooks,omitempty"`
	McpAllowlist     []string               `json:"mcpAllowlist,omitempty"`
	McpDenylist      []string               `json:"mcpDenylist,omitempty"`
	ToolRestrictions *ToolRestrictions      `json:"toolRestrictions,omitempty"`
	Permissions      *PermissionPolicy      `json:"permissions,omitempty"`
	Telemetry        *TelemetryConfig       `json:"telemetry,omitempty"`
	Network          *NetworkConfig         `json:"network,omitempty"`
	Sandbox          *SandboxEnterpriseConfig `json:"sandbox,omitempty"`
	CustomFields     map[string]any         `json:"customFields,omitempty"`
}

// ToolRestrictions defines tool allow/deny lists.
type ToolRestrictions struct {
	Allow []string `json:"allow,omitempty"`
	Deny  []string `json:"deny,omitempty"`
}

// SandboxEnterpriseConfig controls sandbox enforcement at the enterprise level.
type SandboxEnterpriseConfig struct {
	Required                    bool               `json:"required"`
	AllowDisable                bool               `json:"allowDisable"`
	AdditionalDenyPaths         []string           `json:"additionalDenyPaths,omitempty"`
	AdditionalDangerousPatterns []DangerousPattern `json:"additionalDangerousPatterns,omitempty"`
}

// DangerousPattern is a pattern that should be blocked with an explanation.
type DangerousPattern struct {
	Pattern string `json:"pattern"`
	Reason  string `json:"reason"`
}

// --- Full Engine Runtime Config ---

// EngineRuntimeConfig is the fully merged engine configuration.
type EngineRuntimeConfig struct {
	Backend      string                        `json:"backend"`
	DefaultModel string                        `json:"defaultModel"`
	Providers    map[string]ProviderConfig     `json:"providers,omitempty"`
	Limits       LimitsConfig                  `json:"limits"`
	McpServers   map[string]McpServerConfig    `json:"mcpServers,omitempty"`
	Profiles     []EngineProfileConfig         `json:"profiles,omitempty"`
	Permissions  *PermissionPolicy             `json:"permissions,omitempty"`
	Auth         *AuthConfig                   `json:"auth,omitempty"`
	Network      *NetworkConfig                `json:"network,omitempty"`
	Telemetry    *TelemetryConfig              `json:"telemetry,omitempty"`
	Compaction   *CompactionConfig             `json:"compaction,omitempty"`
	Security     *SecurityConfig               `json:"security,omitempty"`
	Enterprise   *EnterpriseConfig             `json:"enterprise,omitempty"`
	FeatureFlags *FeatureFlagsConfig           `json:"featureFlags,omitempty"`
}

// FeatureFlagsConfig defines feature flag source configuration.
type FeatureFlagsConfig struct {
	Source   string                 `json:"source"`             // "static", "file", "http"
	Path     string                 `json:"path,omitempty"`     // for file source
	URL      string                 `json:"url,omitempty"`      // for http source
	Interval int64                  `json:"interval,omitempty"` // poll interval ms for http
	Static   map[string]interface{} `json:"static,omitempty"`   // for static source
}

// ProviderConfig holds credentials and endpoint for a provider.
type ProviderConfig struct {
	APIKey  string `json:"apiKey,omitempty"`
	BaseURL string `json:"baseURL,omitempty"`
}

// LimitsConfig defines resource limits for a run.
// Pointer fields distinguish "not set" (nil) from "explicitly zero".
type LimitsConfig struct {
	MaxTurns      *int     `json:"maxTurns,omitempty"`
	MaxBudgetUsd  *float64 `json:"maxBudgetUsd,omitempty"`
	IdleTimeoutMs *int64   `json:"idleTimeoutMs,omitempty"`
}

// McpServerConfig defines an MCP server connection.
type McpServerConfig struct {
	Type    string            `json:"type"`
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	URL     string            `json:"url,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	OAuth   *McpOAuthConfig   `json:"oauth,omitempty"`
}

// McpOAuthConfig holds OAuth 2.0 settings for an MCP server.
type McpOAuthConfig struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret,omitempty"`
	AuthURL      string `json:"auth_url"`
	TokenURL     string `json:"token_url"`
	Scope        string `json:"scope,omitempty"`
	RedirectURI  string `json:"redirect_uri,omitempty"`
	UsePKCE      bool   `json:"use_pkce,omitempty"`
}

// CompactionConfig controls context window compaction behavior.
type CompactionConfig struct {
	Strategy  string  `json:"strategy"`
	KeepTurns int     `json:"keepTurns"`
	Threshold float64 `json:"threshold"`
}

// --- Security Config ---

// SecurityConfig controls opt-in security features. All fields default to
// disabled. Harness engineers enable what they need.
type SecurityConfig struct {
	RedactSecrets bool `json:"redactSecrets"`
}

// --- Permission Types (from engine/src/permissions/types.ts) ---

// PermissionPolicy defines the permission evaluation strategy.
type PermissionPolicy struct {
	Mode              string           `json:"mode"`
	Rules             []PermissionRule `json:"rules,omitempty"`
	DangerousPatterns []string         `json:"dangerousPatterns,omitempty"`
	ReadOnlyPaths     []string         `json:"readOnlyPaths,omitempty"`
}

// PermissionRule is a single rule in the permission policy.
type PermissionRule struct {
	Tool            string   `json:"tool"`
	Decision        string   `json:"decision"`
	CommandPatterns []string `json:"commandPatterns,omitempty"`
	PathPatterns    []string `json:"pathPatterns,omitempty"`
}

// PermissionCheck is the input to a permission evaluation.
type PermissionCheck struct {
	Tool  string         `json:"tool"`
	Input map[string]any `json:"input"`
	Cwd   string         `json:"cwd"`
}

// PermissionResult is the output of a permission evaluation.
type PermissionResult struct {
	Decision string          `json:"decision"`
	Rule     *PermissionRule `json:"rule,omitempty"`
	Reason   string          `json:"reason,omitempty"`
}

// AuditEntry records a permission decision for auditing.
type AuditEntry struct {
	Timestamp int64          `json:"timestamp"`
	Tool      string         `json:"tool"`
	Input     map[string]any `json:"input"`
	Decision  string         `json:"decision"`
	Reason    string         `json:"reason,omitempty"`
	Rule      string         `json:"rule,omitempty"`
	SessionID string         `json:"sessionId,omitempty"`
}

// --- Auth Types (from engine/src/auth/types.ts) ---

// Credential represents a resolved authentication credential.
type Credential struct {
	Type         string `json:"type"`
	Value        string `json:"value"`
	ExpiresAt    *int64 `json:"expiresAt,omitempty"`
	RefreshToken string `json:"refreshToken,omitempty"`
	ProviderID   string `json:"providerId"`
	Source       string `json:"source"`
}

// OAuthConfig configures OAuth authentication for a provider.
type OAuthConfig struct {
	ClientID         string   `json:"clientId"`
	AuthorizationURL string   `json:"authorizationUrl"`
	TokenURL         string   `json:"tokenUrl"`
	Scopes           []string `json:"scopes"`
	UsePkce          bool     `json:"usePkce,omitempty"`
	RedirectURI      string   `json:"redirectUri,omitempty"`
}

// SecureStoreConfig configures the credential storage backend.
type SecureStoreConfig struct {
	Backend     string `json:"backend"`
	ServiceName string `json:"serviceName,omitempty"`
	FilePath    string `json:"filePath,omitempty"`
}

// AuthConfig holds authentication settings.
type AuthConfig struct {
	OAuth              map[string]OAuthConfig `json:"oauth,omitempty"`
	SecureStore        *SecureStoreConfig     `json:"secureStore,omitempty"`
	CacheTtlMs         int64                  `json:"cacheTtlMs,omitempty"`
	RefreshThresholdMs int64                  `json:"refreshThresholdMs,omitempty"`
}

// --- Network Types (from engine/src/network.ts) ---

// ProxyConfig defines HTTP/HTTPS proxy settings.
type ProxyConfig struct {
	HttpProxy  string `json:"httpProxy,omitempty"`
	HttpsProxy string `json:"httpsProxy,omitempty"`
	NoProxy    string `json:"noProxy,omitempty"`
}

// NetworkConfig controls proxy, CA certificates, and TLS settings.
type NetworkConfig struct {
	Proxy              *ProxyConfig `json:"proxy,omitempty"`
	CustomCaCerts      []string     `json:"customCaCerts,omitempty"`
	RejectUnauthorized *bool        `json:"rejectUnauthorized,omitempty"`
}

// --- Telemetry Types (from engine/src/telemetry/types.ts) ---

// TelemetryConfig controls telemetry collection and export.
type TelemetryConfig struct {
	Enabled        bool              `json:"enabled"`
	Targets        []string          `json:"targets,omitempty"`
	HttpEndpoint   string            `json:"httpEndpoint,omitempty"`
	HttpHeaders    map[string]string `json:"httpHeaders,omitempty"`
	FilePath       string            `json:"filePath,omitempty"`
	PrivacyLevel   string            `json:"privacyLevel,omitempty"`
	BatchSize      int               `json:"batchSize,omitempty"`
	FlushIntervalMs int64            `json:"flushIntervalMs,omitempty"`
	Otel           *OtelConfig       `json:"otel,omitempty"`
}

// TelemetryEvent is a structured telemetry span or point event.
type TelemetryEvent struct {
	Name         string                 `json:"name"`
	TraceID      string                 `json:"traceId"`
	SpanID       string                 `json:"spanId"`
	ParentSpanID string                 `json:"parentSpanId,omitempty"`
	SessionID    string                 `json:"sessionId,omitempty"`
	Timestamp    int64                  `json:"timestamp"`
	DurationMs   *int64                 `json:"durationMs,omitempty"`
	Attributes   map[string]any         `json:"attributes"`
	Status       string                 `json:"status"`
	ErrorMessage string                 `json:"errorMessage,omitempty"`
}

// OtelConfig configures OpenTelemetry export.
type OtelConfig struct {
	Enabled            bool              `json:"enabled"`
	Endpoint           string            `json:"endpoint,omitempty"`
	Protocol           string            `json:"protocol,omitempty"`
	Headers            map[string]string `json:"headers,omitempty"`
	ServiceName        string            `json:"serviceName,omitempty"`
	ResourceAttributes map[string]string `json:"resourceAttributes,omitempty"`
}
