package types

// RunRecoveryConfig resolves through engine-wide and per-session layers.
// A nil Enabled means "inherit"; when every layer omits it, recovery is off.
// MaxAttempts bounds durable restart retries; zero means use the engine default.
type RunRecoveryConfig struct {
	Enabled     *bool `json:"enabled,omitempty"`
	MaxAttempts int   `json:"maxAttempts,omitempty"`
	// MaxConcurrent caps restart recovery launches across the daemon. This is
	// engine-runtime policy, not a per-session override. Zero uses the bounded
	// default so a desktop restoring many tabs cannot stampede providers.
	MaxConcurrent int `json:"maxConcurrent,omitempty"`
}

const (
	// RunRecoveryDefaultMaxAttempts bounds automatic restarts for a session. The
	// engine applies it only after a recovery policy has enabled the mechanism.
	RunRecoveryDefaultMaxAttempts = 2
	// RunRecoveryDefaultMaxConcurrent limits restart recovery work while
	// retaining prompt recovery for a normal set of restored sessions.
	RunRecoveryDefaultMaxConcurrent = 2
)
