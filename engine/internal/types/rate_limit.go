package types

// RateLimitPayload is the wire payload of engine_rate_limit: what a backend
// reported about the signed-in account's usage limits during a run.
type RateLimitPayload struct {
	// Status is the backend's verdict for the next request ("allowed",
	// "allowed_warning", "rejected").
	Status string `json:"status"`
	// ResetsAt is the unix second the RateLimitType window resets.
	ResetsAt int64 `json:"resetsAt"`
	// RateLimitType names the window the status is about ("five_hour",
	// "seven_day").
	RateLimitType string `json:"rateLimitType"`
	// Utilization is the fraction (0..1) of the RateLimitType window used.
	// Nil when the backend did not report one.
	Utilization *float64 `json:"utilization,omitempty"`
	// Windows is every usage window the backend reported with this event,
	// keyed by window name.
	Windows map[string]RateLimitWindow `json:"windows,omitempty"`
}
