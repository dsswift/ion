package extension

// PlanModeOutcome reports what an extension's plan-mode request did. It is
// the result of ext/set_plan_mode alongside "ok".
//
// Field stability: new fields may be added with zero-value defaults; existing
// fields must not be removed or renamed.
type PlanModeOutcome struct {
	// Allowed is false when a before_plan_mode_* handler vetoed the change.
	Allowed bool `json:"allowed"`
	// Changed is true when the session's mode actually flipped. A request for
	// the current mode is allowed and unchanged.
	Changed bool `json:"changed"`
	// Reason is the vetoing handler's explanation.
	Reason string `json:"reason,omitempty"`
}
