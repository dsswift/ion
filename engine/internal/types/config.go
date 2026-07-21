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

// NewConversationDefaultsPolicy specifies default working directory and engine
// profile for new conversations. Communicated via enterprise config so
// administrators can set organisation-wide defaults that clients honour when the
// user has not made their own choice (Locked=false) or cannot override
// (Locked=true).
//
// BaseDirectory and EngineProfileId mirror the per-user defaultBaseDirectory
// and defaultEngineProfileId preferences so the wire shape is consistent.
// Empty EngineProfileId means "plain conversation" (no extension loaded).
type NewConversationDefaultsPolicy struct {
	BaseDirectory   string `json:"baseDirectory,omitempty"`
	EngineProfileId string `json:"engineProfileId,omitempty"`
	// Locked, when true, prevents the user from overriding these defaults
	// in the client's settings UI. Clients enforce this; the engine itself is
	// stateless with respect to user preferences.
	Locked bool `json:"locked,omitempty"`
}

// EnterpriseConfig represents MDM/system-level sealed configuration.
type EnterpriseConfig struct {
	AllowedModels    []string  `json:"allowedModels,omitempty"`
	BlockedModels    []string  `json:"blockedModels,omitempty"`
	AllowedProviders []string  `json:"allowedProviders,omitempty"`
	RequiredHooks    []HookDef `json:"requiredHooks,omitempty"`
	McpAllowlist     []string  `json:"mcpAllowlist,omitempty"`
	McpDenylist      []string  `json:"mcpDenylist,omitempty"`
	// PluginAllowlist, when non-empty, restricts plugins to only matching sources.
	// Glob patterns supported (e.g. "JuliusBrussee/*"). Sealed ceiling: overrides
	// any per-user allowlist. Empty means no restriction (all sources permitted).
	PluginAllowlist []string `json:"pluginAllowlist,omitempty"`
	// PluginDenylist blocks matching plugin sources. Additive with the user-layer
	// denylist — enterprise can only expand what's blocked, never narrow it.
	PluginDenylist []string `json:"pluginDenylist,omitempty"`
	// PluginForceInstalled lists plugin sources the engine must install on boot.
	// Merged with the user-layer forceInstalled list. Enterprise-declared plugins
	// bypass user allowlist checks — the enterprise controls what it mandates.
	PluginForceInstalled []string                 `json:"pluginForceInstalled,omitempty"`
	ToolRestrictions     *ToolRestrictions        `json:"toolRestrictions,omitempty"`
	Permissions          *PermissionPolicy        `json:"permissions,omitempty"`
	Telemetry            *TelemetryConfig         `json:"telemetry,omitempty"`
	Network              *NetworkConfig           `json:"network,omitempty"`
	Sandbox              *SandboxEnterpriseConfig `json:"sandbox,omitempty"`
	// NewConversationDefaults sets organisation-wide defaults for new-conversation
	// working directory and engine profile. When nil, clients use the per-user
	// defaultBaseDirectory and defaultEngineProfileId preferences. Overlay
	// (drop-in) merges follow the additive pattern: a non-nil overlay pointer
	// replaces the base pointer entirely.
	NewConversationDefaults *NewConversationDefaultsPolicy `json:"newConversationDefaults,omitempty"`
	// Logging controls enterprise-sealed operational log egress. When set and
	// EgressTargets is non-empty, the egress targets (and associated endpoint /
	// headers / otel config) are forced onto the merged config and cannot be
	// disabled by the user. Non-egress fields (Format, MaxSizeMB, OutputMode,
	// LogDir) in this block are NOT enforced by EnforceEnterprise — those remain
	// user-configurable. Mirrors the Telemetry enforcement pattern.
	Logging      *LoggingConfig `json:"logging,omitempty"`
	CustomFields map[string]any `json:"customFields,omitempty"`
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

// PluginsConfig holds the user-layer plugin policy. Merged with enterprise
// PluginAllowlist / PluginDenylist / PluginForceInstalled at EnforceEnterprise
// time following the same sealed-ceiling pattern as McpServers vs. McpAllowlist.
type PluginsConfig struct {
	// ForceInstalled lists plugin sources (owner/repo) the engine installs
	// automatically on boot if not already present in the registry. Additive
	// with the enterprise PluginForceInstalled list — both are reconciled.
	ForceInstalled []string `json:"forceInstalled,omitempty"`
	// Allowlist, when non-empty, permits only matching plugin sources. Glob
	// patterns are supported (e.g. "JuliusBrussee/*"). The enterprise
	// PluginAllowlist seals this — when the enterprise list is set it
	// replaces this value entirely.
	Allowlist []string `json:"allowlist,omitempty"`
	// Denylist blocks matching plugin sources. The enterprise PluginDenylist
	// is additive — enterprise can only expand what's blocked, not narrow it.
	Denylist []string `json:"denylist,omitempty"`
}

// --- Full Engine Runtime Config ---

// EngineRuntimeConfig is the fully merged engine configuration.
type EngineRuntimeConfig struct {
	// Backend selects the top-level run backend. Canonical values:
	// "api" | "claude-code" | "hybrid". "cli" is a permanently accepted
	// legacy input alias for "claude-code" and is normalized to it at load.
	Backend      string                     `json:"backend"`
	DefaultModel string                     `json:"defaultModel"`
	Providers    map[string]ProviderConfig  `json:"providers,omitempty"`
	Limits       LimitsConfig               `json:"limits"`
	McpServers   map[string]McpServerConfig `json:"mcpServers,omitempty"`
	// Plugins holds the user-layer plugin policy (force-installs, allow/deny
	// lists). Enterprise policy layers on top via PluginAllowlist /
	// PluginDenylist / PluginForceInstalled on EnterpriseConfig.
	Plugins      *PluginsConfig        `json:"plugins,omitempty"`
	Profiles     []EngineProfileConfig `json:"profiles,omitempty"`
	Permissions  *PermissionPolicy     `json:"permissions,omitempty"`
	Auth         *AuthConfig           `json:"auth,omitempty"`
	Network      *NetworkConfig        `json:"network,omitempty"`
	Telemetry    *TelemetryConfig      `json:"telemetry,omitempty"`
	Compaction   *CompactionConfig     `json:"compaction,omitempty"`
	Security     *SecurityConfig       `json:"security,omitempty"`
	Enterprise   *EnterpriseConfig     `json:"enterprise,omitempty"`
	FeatureFlags *FeatureFlagsConfig   `json:"featureFlags,omitempty"`
	Relay        *RelayConfig          `json:"relay,omitempty"`
	Timeouts     *TimeoutsConfig       `json:"timeouts,omitempty"`
	WebSearch    *WebSearchConfig      `json:"webSearch,omitempty"`
	// Shell controls how the Bash tool selects the shell used to execute
	// commands. Pointer so engine.json can fully omit the block and inherit
	// the default (non-login bash -c). When Shell.UseLoginShell is true, the
	// Bash tool runs each command through the user's login shell so rc files
	// (PATH, aliases, functions, exported env) are sourced. See
	// types.ShellConfig.
	Shell *ShellConfig `json:"shell,omitempty"`
	// Workspace holds engine-wide filesystem-watch and session-lifecycle
	// limits (orphaned-session reap grace window, per-watcher directory cap).
	// Pointer so engine.json can omit the block and inherit the compiled
	// defaults. See types.WorkspaceConfig.
	Workspace *WorkspaceConfig `json:"workspace,omitempty"`
	// EarlyStopContinue configures the Claude-Code-style "keep working"
	// continuation nudge. Pointer so engine.json can fully omit the block
	// and inherit the built-in defaults. See types.EarlyStopDefaults().
	EarlyStopContinue *EarlyStopContinueConfig `json:"earlyStopContinue,omitempty"`
	// Webhooks configures the inbound HTTP webhook listener that
	// extensions register routes against. Pointer so engine.json can
	// omit the block; the listener is OFF by default and auto-enables
	// when any extension declares a webhook route (decision 4).
	Webhooks *WebhooksConfig `json:"webhooks,omitempty"`
	// Scheduling configures the scheduler that fires extension-
	// registered daily/weekly/interval jobs. Pointer so engine.json can
	// omit the block; the scheduler is OFF by default and auto-starts
	// when any extension declares a job.
	Scheduling *SchedulingConfig `json:"scheduling,omitempty"`
	LogLevel   string            `json:"logLevel,omitempty"` // "trace", "debug", "info", "warn", "error"
	// Logging controls structured log output format, destination, and
	// rotation. Pointer so engine.json can omit the block and inherit the
	// compiled defaults. See types.LoggingConfig.
	Logging *LoggingConfig `json:"logging,omitempty"`

	// MaxDispatchDepth caps how many nested dispatch levels are allowed.
	// The orchestrator runs at depth 0; a specialist it dispatches runs at
	// depth 1; a sub-specialist at depth 2; etc. Dispatches at depth >=
	// MaxDispatchDepth are rejected with ErrDispatchDepthExceeded.
	//
	// Zero or negative means "use the built-in default (3)", which allows
	// depths 0, 1, and 2. There is no sentinel to disable the cap entirely
	// (unlike MaxTurns <=0 = unlimited) because unbounded recursion is a
	// resource hazard with no legitimate use case.
	MaxDispatchDepth int `json:"maxDispatchDepth,omitempty"`

	// AllowSelfDispatch disables the self-dispatch rail when true. The rail
	// (default: OFF, i.e. self-dispatch blocked) prevents a dispatched agent
	// from dispatching an agent of its OWN name -- recursive self-cloning that
	// burns the dispatch-depth budget with no legitimate use case, the same
	// resource-hazard category as unbounded recursion. The orchestrator
	// (depth 0) has no agent identity and is never subject to the rail. This
	// escape hatch exists only for the rare consumer that genuinely wants an
	// agent to be able to re-dispatch its own name; leave it false otherwise.
	AllowSelfDispatch bool `json:"allowSelfDispatch,omitempty"`

	// MemoryLimitMB is an optional soft ceiling (in MiB) for the engine daemon's
	// Go heap, applied at serve startup via runtime/debug.SetMemoryLimit. It is a
	// SOFT limit: as the heap approaches it the garbage collector becomes far more
	// aggressive, trading CPU to hold resident memory below the level where the OS
	// memory-pressure killer (macOS jetsam / Linux OOM) would SIGKILL the whole
	// process — taking every hosted session down at once. It is NOT a hard cap and
	// does not cause allocation failures.
	//
	// Precedence at startup (see cmd/ion/memlimit.go):
	//   1. The GOMEMLIMIT environment variable, if set — honored natively by the Go
	//      runtime; the engine never overrides an operator's explicit env choice.
	//   2. This field, when > 0.
	//   3. A conservative fraction of host physical RAM (engine-derived default).
	//
	// Zero/absent ⇒ the engine derives the default. This is per-daemon config read
	// once from engine.json at serve startup, alongside Limits/Timeouts/Webhooks.
	MemoryLimitMB int `json:"memoryLimitMb,omitempty"`

	// DispatchContext is the engine.json-level context policy applied to every
	// dispatched agent (level 2 of the four-level cascade). When nil, built-in
	// defaults apply (all context layers on). Extensions override per-session via
	// ctx.setDispatchContextDefaults() (level 3) or per-dispatch via
	// DispatchAgentOpts.ContextPolicy (level 4).
	DispatchContext *DispatchContextConfig `json:"dispatchContext,omitempty"`
}

// DispatchContextConfig is the engine.json-level context policy for dispatched
// agents (level 2 of the four-level context cascade). All fields are pointer
// bools: nil = use built-in default (all on). See docs/context-loading.md.
type DispatchContextConfig struct {
	// IncludeGlobalContext controls whether home roots (~/.ion, ~/.claude under
	// compat) are included in every dispatch. Nil = default on.
	IncludeGlobalContext *bool `json:"includeGlobalContext,omitempty"`
	// IncludeProjectContext controls whether the child's cwd + ancestor walk is
	// performed. Nil = default on.
	IncludeProjectContext *bool `json:"includeProjectContext,omitempty"`
	// ClaudeCompat overrides the engine's ClaudeCompat setting for dispatch walks.
	// Nil = inherit from the engine's session-level ClaudeCompat flag.
	ClaudeCompat *bool `json:"claudeCompat,omitempty"`
}

// LoggingConfig controls structured log output format, destination, and rotation.
// All fields are optional; zero values inherit engine defaults.
type LoggingConfig struct {
	// Format selects output encoding. "json" (default) emits NDJSON per
	// the canonical log schema. "text" emits a human-readable format for
	// local debugging; NOT supported in production (prefer ION_LOG_TEXT=1 env).
	Format string `json:"format,omitempty"` // "json" | "text"

	// OutputMode controls where log lines go.
	// "file" (default): write to LogDir/engine.jsonl only.
	// "stdout": write to stdout only.
	// "both": write to file AND stdout.
	OutputMode string `json:"outputMode,omitempty"` // "file" | "stdout" | "both"

	// MaxSizeMB is the per-file size cap before rename-rotate rotation.
	// Zero means use the compiled default (20 MB).
	MaxSizeMB int `json:"maxSizeMB,omitempty"`

	// MaxFiles is the number of rotated archive files retained alongside the
	// live log file. When the live file reaches MaxSizeMB, it is renamed to
	// engine.jsonl.1 (shifting older generations to .2, .3, … up to MaxFiles),
	// and a fresh log file is opened. Files beyond MaxFiles are deleted.
	// Zero means use the compiled default (3).
	MaxFiles int `json:"maxFiles,omitempty"`

	// LogDir overrides the directory for log files.
	// Empty means use ~/.ion.
	LogDir string `json:"logDir,omitempty"`

	// DisableRotation disables size-based rotation entirely.
	DisableRotation bool `json:"disableRotation,omitempty"`

	// EgressTargets lists downstream shipping targets for operational log lines
	// in addition to the local JSONL file. Supported values:
	//   "http"  — POST batches of NDJSON log records to EgressEndpoint.
	//   "otel"  — Export as OTLP log records to EgressOtel.Endpoint+"/v1/logs".
	// Empty (the default) means no egress; logs write to the local file only.
	// Omit-when-unset so default installs are completely unchanged.
	EgressTargets []string `json:"egressTargets,omitempty"`

	// EgressEndpoint is the HTTP POST URL for the "http" egress target.
	// Required when "http" is in EgressTargets; ignored otherwise.
	EgressEndpoint string `json:"egressEndpoint,omitempty"`

	// EgressHeaders are additional HTTP request headers for the "http" egress
	// target (e.g. Authorization). Ignored when "http" is not in EgressTargets.
	EgressHeaders map[string]string `json:"egressHeaders,omitempty"`

	// EgressBatchSize controls how many log records accumulate before an
	// automatic flush to egress targets. Zero (the default) means the periodic
	// ticker is the only flush trigger.
	EgressBatchSize int `json:"egressBatchSize,omitempty"`

	// EgressChunkSize is the maximum number of records per POST when draining
	// the on-disk spool. Chunking prevents oversized request bodies from being
	// rejected by intermediate proxies (Cloudflare, nginx, etc.) that enforce
	// payload size limits. Zero means use the compiled default (500 records).
	EgressChunkSize int `json:"egressChunkSize,omitempty"`

	// EgressFlushIntervalMs controls how often the egress forwarder flushes
	// buffered records. Zero defaults to 5000 ms.
	EgressFlushIntervalMs int64 `json:"egressFlushIntervalMs,omitempty"`

	// EgressOtel configures the OTLP HTTP logs endpoint for the "otel" egress
	// target. Required when "otel" is in EgressTargets; ignored otherwise.
	// Reuses OtelConfig (endpoint, headers, serviceName) from the telemetry
	// block so operators use a consistent shape across both subsystems.
	EgressOtel *OtelConfig `json:"egressOtel,omitempty"`

	// EgressSpoolMaxBytes caps the on-disk spool file (~/.ion/.engine-egress-spool.jsonl)
	// used to buffer batches when the egress sink is unreachable. When the spool
	// exceeds this size, the oldest lines are dropped and an ERROR is logged.
	// Zero means use the compiled default (50 MB).
	EgressSpoolMaxBytes int64 `json:"egressSpoolMaxBytes,omitempty"`

	// EgressManagedByClient suppresses the engine's OWN egress forwarder while
	// leaving every other egress field (EgressTargets, EgressEndpoint,
	// EgressOtel, ...) intact for a managing client to read.
	//
	// The single-collection-point model (docs/enterprise/central-log-collection.md):
	// a managed workstation runs the desktop, which is the sole authenticated
	// shipper — it ships its own desktop.jsonl directly AND tails engine.jsonl
	// into its own forwarder (carrying the client's OIDC token). If the engine
	// ALSO ran its own forwarder off the same EgressTargets flag, every engine
	// log line would ship twice: once unauthenticated by the engine (→ 401 →
	// spool) and once authenticated by the desktop tailer. Setting this true is
	// how the desktop tells the engine "I am shipping on your behalf; do not run
	// your own forwarder."
	//
	// Zero value (false) is the headless/CI/Docker default: no managing client
	// exists, so the engine ships its own logs via EgressTargets as before. Only
	// a client that genuinely tails and ships engine.jsonl sets this true.
	//
	// Superseded by EgressShipSources for new deployments: the boolean can
	// only express "desktop ships everything" vs "engine ships its own".
	// When EgressShipSources is non-empty it takes precedence and this flag
	// is ignored. Retained for existing engine.json files (removing or
	// repurposing it would break deployed configs).
	EgressManagedByClient bool `json:"egressManagedByClient,omitempty"`

	// EgressShipSources is the shipping-responsibility matrix entry for THIS
	// surface: which log sources its forwarder ships. Recognized sources:
	//   "engine"    — the engine's own operational records (in-process).
	//   "desktop"   — ~/.ion/desktop.jsonl (tailed).
	//   "ios"       — ~/.ion/ios-diagnostic-logs.jsonl (tailed).
	//   "telemetry" — ~/.ion/telemetry.jsonl (tailed).
	// The enterprise deployer decides the split: the engine may ship only
	// its own logs, everything (headless collection point), or nothing
	// (a client ships on its behalf — the empty-but-set state is expressed
	// by assigning the sources to the other surface's config).
	//
	// Unset (nil) preserves legacy behavior: the engine ships ["engine"]
	// unless EgressManagedByClient is true (then nothing). The desktop's
	// counterpart lives in its own settings and defaults to everything —
	// see desktop/src/main/log-egress.ts.
	EgressShipSources []string `json:"egressShipSources,omitempty"`

	// EgressClientShipSources is the managing client's share of the
	// shipping-responsibility matrix: which log sources the client's own
	// forwarder ships (same source names as EgressShipSources). The engine
	// never acts on this field -- it lives here because engine.json is the
	// single sealed document an enterprise controls, and the client reads
	// its assignment from the same logging block it already consumes.
	// Unset preserves the client's legacy behavior (claim-and-ship-all
	// when the desktop runs). The client authenticates its shipments by
	// pulling ephemeral access tokens from the engine (oidc_token).
	EgressClientShipSources []string `json:"egressClientShipSources,omitempty"`

	// EgressTokenScope, when set, makes the egress forwarder authenticate
	// each flush with the signed-in operator's OIDC bearer token minted for
	// this scope (e.g. "api://<app-id>/Telemetry.Write"), refreshed
	// silently by the engine's identity manager. Merged over EgressHeaders
	// (the fresh token wins over a static Authorization). Empty keeps the
	// static-headers-only behavior.
	EgressTokenScope string `json:"egressTokenScope,omitempty"`

	// EgressTokenAudience is the explicit audience/resource for the egress
	// token, for identity providers that bind grants to one (Auth0,
	// RFC 8707) instead of encoding the resource in the scope string.
	// Empty uses the identity provider's configured default audience.
	EgressTokenAudience string `json:"egressTokenAudience,omitempty"`
}

// GetWorkspace returns the Workspace config block, or nil for a nil receiver
// or unset block. Nil-safe: WorkspaceConfig's accessors all tolerate a nil
// receiver and return the compiled default, so callers can chain
// cfg.GetWorkspace().SessionReapGrace() without a nil check.
func (c *EngineRuntimeConfig) GetWorkspace() *WorkspaceConfig {
	if c == nil {
		return nil
	}
	return c.Workspace
}

// RelayConfig configures the WebSocket relay connection for mobile remote access.
type RelayConfig struct {
	URL       string `json:"url"`       // WebSocket relay URL (e.g. wss://relay.example.com)
	APIKey    string `json:"apiKey"`    // Bearer token for relay auth
	ChannelID string `json:"channelId"` // 32-char hex channel identifier
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
	APIKey     string `json:"apiKey,omitempty"`
	BaseURL    string `json:"baseURL,omitempty"`
	AuthHeader string `json:"authHeader,omitempty"`
	// Backend selects which run backend serves this provider's models when
	// the top-level backend is "hybrid". Empty means "use the default rule"
	// (anthropic → claude-code, every other provider → api). Allowed values
	// are provider-specific and validated at config load:
	//   anthropic → "api" | "claude-code"
	//   openai    → "api" | "codex"
	//   xai       → "api" | "grok"
	//   cursor    → "cursor"
	//   all others→ "api"
	// An invalid value is reset to "" (default rule) with an ERROR log.
	Backend string `json:"backend,omitempty"`
}

// LimitsConfig defines resource limits for a run.
// Pointer fields distinguish "not set" (nil) from "explicitly zero".
type LimitsConfig struct {
	MaxTurns                    *int     `json:"maxTurns,omitempty"`
	MaxBudgetUsd                *float64 `json:"maxBudgetUsd,omitempty"`
	SuppressSystemMessages      *bool    `json:"suppressSystemMessages,omitempty"`
	DisablePlanModeReminder     *bool    `json:"disablePlanModeReminder,omitempty"`
	PlanModeAllowedBashCommands []string `json:"planModeAllowedBashCommands,omitempty"`
	DisableTurnLimitWarning     *bool    `json:"disableTurnLimitWarning,omitempty"`
	DisableMaxTokenContinue     *bool    `json:"disableMaxTokenContinue,omitempty"`
	// MaxTokenThinkingOnlyBreaker is the number of consecutive max_tokens turns
	// that produce zero non-thinking output (pure thinking blocks) before the
	// engine terminates the run with an error. Zero uses the built-in default (3).
	// Set -1 to disable the breaker entirely (not recommended).
	//
	// This defends against the thinking-budget-exceeds-MaxTokens pathology: when
	// the resolved thinking budget is >= the run's MaxTokens, every turn produces
	// only thinking output, the stop reason is always max_tokens, and the engine
	// would otherwise inject "Continue from where you left off." forever, burning
	// tokens with zero forward progress. See runloop.go's max_tokens case.
	MaxTokenThinkingOnlyBreaker int `json:"maxTokenThinkingOnlyBreaker,omitempty"`
	// PlanModeAutoExitOnEndTurn controls the engine's "deterministic
	// plan-mode exit" safety net. When a plan-mode run terminates with
	// stop reason end_turn / stop and the assistant did not invoke
	// ExitPlanMode or AskUserQuestion, the engine synthesizes the
	// ExitPlanMode call so consumers reliably see the plan-approval
	// card instead of leaving the conversation parked in plan mode.
	//
	// Nil (the default) means "use the built-in default (true)". &true
	// is equivalent (auto-exit enabled). &false disables the synthesis
	// entirely; the run completes as a normal end_turn with the
	// conversation parked in plan mode.
	//
	// Per-run RunOptions.PlanModeAutoExit overrides this. The
	// before_plan_mode_auto_exit extension hook overrides both.
	//
	// Default rationale: the contract "produce a plan, then surface it
	// via ExitPlanMode" is part of plan mode's published behaviour. The
	// stuck-in-plan-mode failure mode this field defends against is
	// strictly worse than the (extremely cheap, idempotent) synthesis
	// path, so the engine ships with the safety net enabled.
	PlanModeAutoExitOnEndTurn *bool `json:"planModeAutoExitOnEndTurn,omitempty"`
	// DisableSkillSystemPrompt controls whether the engine appends the
	// skill-listing + proactive-invocation section to the run's system
	// prompt (see tools.BuildSkillSystemPromptSection). That section carries
	// an opinionated directive ("you MUST invoke the Skill tool BEFORE
	// generating any other response ... a blocking requirement"); a consumer
	// that wants a different skill-discovery policy — softer phrasing, no
	// injection at all, or a fully custom block — needs a way to suppress or
	// replace it.
	//
	// Nil (the default) means "inject" (built-in behaviour: the section is
	// appended whenever skills are registered). &false is equivalent. &true
	// disables the engine's injection entirely; the run's system prompt
	// carries no skill section from the engine.
	//
	// This is the coarse (engine.json) opinion gate. The system_inject hook
	// (kind "skill_listing") is the fine-grained seam: a harness can observe,
	// replace, or suppress the exact section text per run even when injection
	// is enabled. Per-run RunOptions.DisableSkillSystemPrompt overrides this
	// field; the hook overrides both.
	DisableSkillSystemPrompt *bool `json:"disableSkillSystemPrompt,omitempty"`
}

// McpServerConfig defines an MCP server connection.
type McpServerConfig struct {
	Type           string            `json:"type"`
	Command        string            `json:"command,omitempty"`
	Args           []string          `json:"args,omitempty"`
	URL            string            `json:"url,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	Headers        map[string]string `json:"headers,omitempty"`
	OAuth          *McpOAuthConfig   `json:"oauth,omitempty"`
	TimeoutSeconds int               `json:"timeoutSeconds,omitempty"`
	// ForwardUserToken makes the engine stamp the signed-in operator's
	// OIDC bearer token on every outbound request to this server
	// (Authorization header, refreshed per request on HTTP/SSE, at dial
	// time on WebSocket). Opt-in per server -- not every downstream MCP
	// server should receive the operator's identity.
	ForwardUserToken bool `json:"forwardUserToken,omitempty"`
	// UserTokenScope is the downstream resource scope the forwarded token
	// is minted for (e.g. "api://<app-id>/Erm.Access"). Empty uses the
	// operator grant's base scope. Only meaningful with ForwardUserToken.
	UserTokenScope string `json:"userTokenScope,omitempty"`
	// UserTokenAudience is the explicit audience/resource for the forwarded
	// token, for identity providers that bind grants to one (Auth0,
	// RFC 8707) instead of encoding the resource in the scope string.
	// Empty uses the identity provider's configured default audience.
	// Only meaningful with ForwardUserToken.
	UserTokenAudience string `json:"userTokenAudience,omitempty"`
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
	Strategy  string  `json:"strategy,omitempty"`
	KeepTurns int     `json:"keepTurns,omitempty"`
	Threshold float64 `json:"threshold,omitempty"`

	TargetPercent     float64 `json:"targetPercent,omitempty"`
	MicroCompactKeep  int     `json:"microCompactKeep,omitempty"`
	EstimationPadding float64 `json:"estimationPadding,omitempty"`
	Enabled           *bool   `json:"enabled,omitempty"`

	SummaryEnabled   *bool  `json:"summaryEnabled,omitempty"`
	SummaryModel     string `json:"summaryModel,omitempty"`
	SummaryMaxTokens int    `json:"summaryMaxTokens,omitempty"`

	MemoryEnabled         *bool  `json:"memoryEnabled,omitempty"`
	MemoryModel           string `json:"memoryModel,omitempty"`
	MemoryUpdateThreshold int    `json:"memoryUpdateThreshold,omitempty"`
	MemoryUpdateMinTurns  int    `json:"memoryUpdateMinTurns,omitempty"`
	MemoryMaxTokens       int    `json:"memoryMaxTokens,omitempty"`

	// MaxToolResultChars caps the character count of any single tool result
	// added to the conversation. Results exceeding this limit are persisted
	// to disk and replaced with a preview (first 2K chars) plus a file path
	// the model can Read. Zero means use the built-in default (50 000).
	// Set via engine.json: { "compaction": { "maxToolResultChars": 80000 } }
	MaxToolResultChars int `json:"maxToolResultChars,omitempty"`
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

	// TierRules maps a classifier tier label (e.g., "SAFE", "LOW", "MEDIUM",
	// "HIGH", "CRITICAL", or any label your harness defines) to a decision
	// ("allow" / "deny" / "ask"). Consulted before per-rule matching when the
	// permission_classify hook returns a non-empty tier for the tool call.
	// If a tier has no rule here, evaluation falls through to the existing
	// rules + mode logic.
	TierRules map[string]string `json:"tierRules,omitempty"`
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
	// DeviceAuthorizationURL is the OAuth device-authorization endpoint,
	// enabling headless (no-browser) sign-in via the device-code flow.
	DeviceAuthorizationURL string `json:"deviceAuthorizationUrl,omitempty"`
	// IssuerURL enables OIDC discovery (the industry-standard config
	// method): endpoints resolve from
	// <issuerUrl>/.well-known/openid-configuration at first use.
	// Explicitly-configured endpoint URLs above take precedence over
	// discovered values.
	IssuerURL string `json:"issuerUrl,omitempty"`
	// Audience is the default audience/resource requested with grants when
	// a consumer declares none. IdPs like Microsoft Entra encode the
	// resource inside the scope string (api://<app>/Scope) and need no
	// audience; IdPs like Auth0 and Keycloak-style deployments require an
	// explicit audience or RFC 8707 resource indicator.
	Audience string `json:"audience,omitempty"`
	// AudienceParameter is the request-parameter name used to convey the
	// audience: "audience" (the prevailing de-facto dialect, default) or
	// "resource" (RFC 8707 Resource Indicators).
	AudienceParameter string `json:"audienceParameter,omitempty"`
	// AttributionClaim names the id_token claim used as the operator's
	// attribution identity (telemetry/egress "user" field). Empty uses the
	// standard fallback chain: preferred_username → oid → sub.
	AttributionClaim string `json:"attributionClaim,omitempty"`
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
	// IdentityProvider names the entry in OAuth that carries the signed-in
	// operator's OIDC identity (e.g. "entra"). This is the identity whose
	// tokens back the SDK's pre-authenticated HTTP surface, per-server MCP
	// token forwarding, and authenticated log egress. Empty means no
	// operator identity is configured.
	IdentityProvider string `json:"identityProvider,omitempty"`
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
	// DisableLanWarmup skips the macOS local-network warmup probe the engine
	// runs at startup (one UDP datagram to the default gateway via
	// Network.framework, which materializes the Local Network privacy verdict
	// so LAN connections work for the engine and its subprocesses). Set only
	// when Local Network policy is managed externally (e.g. MDM). No effect
	// on non-darwin platforms.
	DisableLanWarmup bool `json:"disableLanWarmup,omitempty"`
}

// --- Telemetry Types (from engine/src/telemetry/types.ts) ---

// TelemetryConfig controls telemetry collection and export.
type TelemetryConfig struct {
	Enabled      bool              `json:"enabled"`
	Targets      []string          `json:"targets,omitempty"`
	HttpEndpoint string            `json:"httpEndpoint,omitempty"`
	HttpHeaders  map[string]string `json:"httpHeaders,omitempty"`
	FilePath     string            `json:"filePath,omitempty"`
	PrivacyLevel string            `json:"privacyLevel,omitempty"`
	BatchSize    int               `json:"batchSize,omitempty"`
	// FlushIntervalMs controls how often the file/stdout/http Collector
	// automatically flushes its in-memory event buffer to disk. When zero
	// (the default, and the common case where the operator omits the field),
	// normalizeTelemetryConfig applies the 5 000 ms default. Set explicitly
	// to override. This is distinct from OtelBridge's own flush interval
	// (which remains a separate config on OtelConfig).
	FlushIntervalMs int64       `json:"flushIntervalMs,omitempty"`
	Otel            *OtelConfig `json:"otel,omitempty"`
}

// TelemetryEvent is a structured telemetry span or point event.
type TelemetryEvent struct {
	Name         string         `json:"name"`
	TraceID      string         `json:"trace_id"`
	SpanID       string         `json:"span_id"`
	ParentSpanID string         `json:"parent_span_id,omitempty"`
	SessionID    string         `json:"session_id,omitempty"`
	Timestamp    int64          `json:"timestamp"`
	DurationMs   *int64         `json:"durationMs,omitempty"`
	Attributes   map[string]any `json:"attributes"`
	Status       string         `json:"status"`
	ErrorMessage string         `json:"errorMessage,omitempty"`
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

// WebSearchConfig controls web search tool behavior.
type WebSearchConfig struct {
	Mode string `json:"mode,omitempty"` // "auto", "client", or "server"; default "auto"
}

// --- Async-trigger configuration (D-010 / D-011) ---

// WebhooksConfig controls the engine's inbound HTTP webhook listener.
// All fields zero-valued to inherit engine defaults; an engine.json
// without a `webhooks` block produces a sensible listener once any
// extension registers a route.
type WebhooksConfig struct {
	// Port is the TCP port the listener binds. Zero defaults to the
	// engine's built-in 7421.
	Port int `json:"port,omitempty"`
	// BindInterface is the listen address. Empty defaults to
	// 127.0.0.1. A non-loopback bind logs a Warn so accidental
	// network exposure is visible.
	BindInterface string `json:"bindInterface,omitempty"`
	// DefaultMaxBodyBytes caps per-request bodies when the route's
	// own MaxBodyBytes is zero. Zero defaults to 1 MiB.
	DefaultMaxBodyBytes int64 `json:"defaultMaxBodyBytes,omitempty"`
	// FireTimeoutMs caps a single fire's handler invocation. Zero
	// defaults to 30000 (30s).
	FireTimeoutMs int64 `json:"fireTimeoutMs,omitempty"`
	// Enabled is a tri-state override: nil = auto (start when any
	// route registers, stop when last route unregisters); &true =
	// force on; &false = force off (no listener even with routes).
	Enabled *bool `json:"enabled,omitempty"`
}

// SchedulingConfig controls the engine's schedule tick loop.
type SchedulingConfig struct {
	// DefaultTz is the IANA timezone applied to daily/weekly jobs
	// whose ScheduleJob.Tz is empty. Empty inherits the system local
	// timezone.
	DefaultTz string `json:"defaultTz,omitempty"`
	// FireTimeoutMs is the default handler timeout. Zero defaults to
	// 60000 (60s). Per-job override is the job's TimeoutMs.
	FireTimeoutMs int64 `json:"fireTimeoutMs,omitempty"`
	// CatchUpEnabled controls whether missed daily/weekly fires fire
	// on engine startup. Nil treats as default-on.
	CatchUpEnabled *bool `json:"catchUpEnabled,omitempty"`
}
