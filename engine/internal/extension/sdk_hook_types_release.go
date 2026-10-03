package extension

// Session release reasons carried by SessionReleaseInfo.Reason.
const (
	// SessionReleaseReasonIdleTimeout: the session stayed quiescent for the
	// configured duration.
	SessionReleaseReasonIdleTimeout = "idle_timeout"
	// SessionReleaseReasonIdleAbort: an abort arrived for a session that was
	// already quiescent.
	SessionReleaseReasonIdleAbort = "idle_abort"
)

// SessionReleaseInfo is the payload for session_before_release: the engine is
// about to release a quiescent session on its own initiative.
//
// Field stability: published hook contract — additive only.
type SessionReleaseInfo struct {
	// Reason is one of the SessionReleaseReason* values. New values may be
	// added; handlers should treat an unknown reason as a release.
	Reason string `json:"reason"`
	// IdleMs is how long the session has been continuously quiescent.
	IdleMs int64 `json:"idleMs"`
}
