package types

// ApplicationConfigSource declares the authenticated, deferred application
// configuration source. The engine resolves it once per verified identity,
// after that identity becomes available, and holds the result in memory
// only. Nil (the block absent from engine.json) leaves the subsystem inert.
type ApplicationConfigSource struct {
	// Endpoint is the absolute http(s) URL the engine GETs with the
	// identity's bearer token. The response is an application config
	// document: a common section every extension reads, one section per
	// enterprise-allowlisted extension, and secrets that stay in the engine.
	Endpoint string `json:"endpoint"`
	// RefreshSeconds is the interval between refreshes for the same
	// identity. A failed first resolution also retries on this interval.
	// Zero or negative selects DefaultApplicationConfigRefreshSeconds.
	RefreshSeconds int `json:"refreshSeconds,omitempty"`
	// Scope is the token scope minted for the request. Empty requests a
	// token with the identity's base grant.
	Scope string `json:"scope,omitempty"`
	// Audience is the token audience, for identity providers that bind a
	// grant to a resource instead of encoding it in the scope.
	Audience string `json:"audience,omitempty"`
	// TimeoutMs bounds one fetch. Zero or negative selects
	// DefaultApplicationConfigTimeoutMs.
	TimeoutMs int `json:"timeoutMs,omitempty"`
}

const (
	// DefaultApplicationConfigRefreshSeconds is the refresh interval used
	// when RefreshSeconds is unset.
	DefaultApplicationConfigRefreshSeconds = 900
	// MinApplicationConfigRefreshSeconds floors RefreshSeconds so a typo
	// cannot turn refresh into a request loop against the endpoint.
	MinApplicationConfigRefreshSeconds = 30
	// DefaultApplicationConfigTimeoutMs bounds one fetch when TimeoutMs is
	// unset.
	DefaultApplicationConfigTimeoutMs = 30_000
)

// RefreshInterval returns the effective refresh interval in seconds.
func (c *ApplicationConfigSource) RefreshInterval() int {
	if c == nil || c.RefreshSeconds <= 0 {
		return DefaultApplicationConfigRefreshSeconds
	}
	if c.RefreshSeconds < MinApplicationConfigRefreshSeconds {
		return MinApplicationConfigRefreshSeconds
	}
	return c.RefreshSeconds
}

// FetchTimeoutMs returns the effective per-fetch timeout in milliseconds.
func (c *ApplicationConfigSource) FetchTimeoutMs() int {
	if c == nil || c.TimeoutMs <= 0 {
		return DefaultApplicationConfigTimeoutMs
	}
	return c.TimeoutMs
}
