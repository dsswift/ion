package types

// Usage limit kinds a delegated CLI can report for its signed-in account.
const (
	// UsageLimitSession is the short rolling window (Claude's 5-hour window,
	// Codex's primary window).
	UsageLimitSession = "session"
	// UsageLimitWeekly is the weekly window across every model.
	UsageLimitWeekly = "weekly"
	// UsageLimitWeeklyModel is a weekly window scoped to one model; Label
	// names the model.
	UsageLimitWeeklyModel = "weekly_model"
	// UsageLimitSpend is a spend cap (a gateway or extra-usage budget).
	UsageLimitSpend = "spend"
)

// ProviderAccount identifies the account a delegated CLI is signed in to.
type ProviderAccount struct {
	// Provider is the provider id the CLI serves (e.g. "anthropic").
	Provider string `json:"provider"`
	Email    string `json:"email,omitempty"`
	// OrgID and OrgName name the account's organization when the CLI
	// reports one.
	OrgID   string `json:"orgId,omitempty"`
	OrgName string `json:"orgName,omitempty"`
	// PlanType is the subscription plan when known (e.g. "max", "pro").
	PlanType string `json:"planType,omitempty"`
	// AuthMethod is the CLI's active auth method (e.g. "claude.ai",
	// "chatgpt", "apiKey").
	AuthMethod string `json:"authMethod,omitempty"`
	// Label is a human-friendly auth summary (e.g. "Claude Max").
	Label string `json:"label,omitempty"`
}

// ProviderUsageLimit is one usage limit of an account, as its CLI reported it.
type ProviderUsageLimit struct {
	// Kind is one of the UsageLimit* constants.
	Kind string `json:"kind"`
	// Label names what the limit covers when the kind alone does not (the
	// model of a weekly_model limit).
	Label string `json:"label,omitempty"`
	// Percent is how much of the limit is used, 0..100 (above 100 once
	// exceeded).
	Percent float64 `json:"percent"`
	// ResetsAt is the RFC3339 time the limit resets; empty when unknown.
	ResetsAt string `json:"resetsAt,omitempty"`
}

// ProviderAccountUsage is one delegated CLI's account and usage limits at
// FetchedAt. It is the element of the provider_account_usage result.
type ProviderAccountUsage struct {
	// Backend names the CLI backend (e.g. "claude-code", "codex").
	Backend string `json:"backend"`
	// Account is the signed-in account; nil when the CLI is signed out.
	Account *ProviderAccount `json:"account,omitempty"`
	// Limits are the account's usage limits. Empty for an API-key login or
	// a CLI that reports none.
	Limits []ProviderUsageLimit `json:"limits"`
	// FetchedAt is the RFC3339 time this entry was read.
	FetchedAt string `json:"fetchedAt"`
	// Error is why the limits could not be read; the account is still
	// reported.
	Error string `json:"error,omitempty"`
}
