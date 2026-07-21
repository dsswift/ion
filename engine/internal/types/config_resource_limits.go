package types

// ResourceLimits caps the number of concurrent orchestration contexts the
// engine will host. Declared by enterprise configuration (D-007) so managed
// deployments — multisession VMs in particular — can bound per-user compute
// consumption at the application layer, complementing gateway-side rate
// limits which only bound API throughput.
//
// Both fields are pointers so "not set" (nil, meaning unlimited — the
// default for every unmanaged install) is distinguishable from an explicit
// zero. Enforcement is a sealed ceiling: EnforceEnterprise lowers any
// user-configured value that exceeds the enterprise value, and the session
// layer consults the merged result at creation time.
type ResourceLimits struct {
	// MaxSessions is the maximum number of concurrent engine sessions.
	// When reached, StartSession returns an error instead of creating a
	// new session. Nil means unlimited.
	MaxSessions *int `json:"maxSessions,omitempty"`
	// MaxAgentsPerSession is the maximum number of concurrently-running
	// dispatched agents within a single session. When reached, new agent
	// dispatches are rejected. Nil means unlimited.
	MaxAgentsPerSession *int `json:"maxAgentsPerSession,omitempty"`
}
