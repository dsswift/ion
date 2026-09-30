package types

// provider_subscription.go — Provider Subscription lookup: the config block
// that names a lookup endpoint, and the credential-free status the engine
// reports about it.

// SubscriptionLookupConfig declares an endpoint that resolves a provider's
// subscription key for the signed-in identity. After sign-in the engine calls
// Endpoint with the identity's bearer token and applies the returned key to
// Provider. The request and response are the published v1 contract in
// docs/configuration/subscription-lookup.md. Nil (the default) leaves manual
// key entry as the only path.
type SubscriptionLookupConfig struct {
	// Endpoint is the http(s) URL the engine GETs.
	Endpoint string `json:"endpoint"`
	// Provider is the provider id the resolved key authenticates (a key
	// under the providers map, e.g. "dci-marketing").
	Provider string `json:"provider"`
	// Scope and Audience shape the bearer token sent to Endpoint. Empty uses
	// the identity grant's base scope and the provider's default audience.
	Scope    string `json:"scope,omitempty"`
	Audience string `json:"audience,omitempty"`
	// TimeoutMs bounds one lookup. Zero uses DefaultSubscriptionLookupTimeoutMs.
	TimeoutMs int `json:"timeoutMs,omitempty"`
	// CacheMaxAgeSeconds bounds how long a cached key is reused at launch
	// without a fresh lookup. Zero reuses the cached key until a lookup is
	// requested (provider_subscription_refresh), the identity changes, or a
	// selection changes. A positive value makes a launch past that age look
	// the key up again, which is how centrally rotated keys reach every
	// installation.
	CacheMaxAgeSeconds int `json:"cacheMaxAgeSeconds,omitempty"`
}

// DefaultSubscriptionLookupTimeoutMs bounds one lookup when TimeoutMs is zero.
const DefaultSubscriptionLookupTimeoutMs = 15000

// LookupTimeoutMs returns the configured timeout, or the default.
func (c SubscriptionLookupConfig) LookupTimeoutMs() int {
	if c.TimeoutMs > 0 {
		return c.TimeoutMs
	}
	return DefaultSubscriptionLookupTimeoutMs
}

// Provider Subscription states. A consumer switches on these; each is a
// distinct situation that needs a different response from the operator.
const (
	// SubscriptionStateDisabled: no subscriptionLookup is configured.
	SubscriptionStateDisabled = "disabled"
	// SubscriptionStateAwaitingIdentity: configured, but no identity is
	// signed in, so there is nothing to look up with.
	SubscriptionStateAwaitingIdentity = "awaiting_identity"
	// SubscriptionStateResolving: a lookup is in flight and no key from this
	// identity is applied yet.
	SubscriptionStateResolving = "resolving"
	// SubscriptionStateApplied: a key is applied to the provider. Source says
	// whether it came from a lookup or the cache.
	SubscriptionStateApplied = "applied"
	// SubscriptionStateSelectionRequired: the lookup returned several
	// subscriptions and none is selected. Options lists them.
	SubscriptionStateSelectionRequired = "selection_required"
	// SubscriptionStateNone: the lookup succeeded and returned zero
	// subscriptions for this identity.
	SubscriptionStateNone = "none"
	// SubscriptionStateFailed: the lookup failed and no cached key exists.
	// Any manually configured key stays in effect. Error says why.
	SubscriptionStateFailed = "failed"
)

// Provider Subscription key sources.
const (
	SubscriptionSourceLookup = "lookup"
	SubscriptionSourceCache  = "cache"
)

// SubscriptionOption is one subscription returned by the lookup, without its
// key. The key never leaves the engine.
type SubscriptionOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// ProviderSubscriptionStatus is the complete Provider Subscription state. It
// is carried by the engine_provider_subscription event, a snapshot: consumers
// replace their local view with it. Tracked by contract sync.
type ProviderSubscriptionStatus struct {
	// State is one of the SubscriptionState* values.
	State string `json:"state"`
	// Provider is the provider id the key applies to. Empty when disabled.
	Provider string `json:"provider,omitempty"`
	// ProviderDisplayName is the provider's configured displayName
	// (providers.<id>.displayName), so a consumer can name the provider the
	// key configures the way its model picker does. Empty when none is set.
	ProviderDisplayName string `json:"providerDisplayName,omitempty"`
	// Selected is the subscription whose key is applied. Nil unless State is
	// applied.
	Selected *SubscriptionOption `json:"selected,omitempty"`
	// Options are the subscriptions the last lookup returned, in response
	// order. A consumer offers these for selection.
	Options []SubscriptionOption `json:"options,omitempty"`
	// Source says where the applied key came from: "lookup" or "cache".
	Source string `json:"source,omitempty"`
	// ResolvedAt is when the lookup behind the applied key or the options
	// ran, in Unix milliseconds. Zero when no lookup has run.
	ResolvedAt int64 `json:"resolvedAt,omitempty"`
	// Error is the most recent lookup failure. It can accompany the applied
	// state when a refresh failed and the cached key stayed in effect.
	Error string `json:"error,omitempty"`
}
