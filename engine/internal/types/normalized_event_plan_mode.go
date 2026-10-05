package types

// PlanModeChangeRejectedEvent reports that a requested plan-mode change was
// vetoed by a before_plan_mode_enter or before_plan_mode_exit handler. The
// session's plan-mode state is unchanged. Emitted for "wire" and "extension"
// requests; a vetoed model tool call already carries the reason in its tool
// result.
type PlanModeChangeRejectedEvent struct {
	// RequestedEnabled is the mode that was asked for.
	RequestedEnabled bool `json:"requestedEnabled"`
	// Source is "wire" or "extension".
	Source string `json:"source"`
	// Reason is the handler's explanation. Empty when it gave none.
	Reason string `json:"reason,omitempty"`
}

func (PlanModeChangeRejectedEvent) eventType() string { return EventPlanModeChangeRejected }
