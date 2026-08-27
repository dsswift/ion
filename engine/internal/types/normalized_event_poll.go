package types

// PollStartedEvent announces a session-owned poll.
type PollStartedEvent struct {
	Poll PollState `json:"poll"`
}

func (PollStartedEvent) eventType() string { return EventPollStarted }

// PollProgressEvent announces one advancing poll attempt.
type PollProgressEvent struct {
	Poll     PollState `json:"poll"`
	Evidence string    `json:"evidence"`
}

func (PollProgressEvent) eventType() string { return EventPollProgress }

// PollTerminalEvent announces one terminal poll verdict.
type PollTerminalEvent struct {
	Result PollTerminalPayload `json:"result"`
}

func (PollTerminalEvent) eventType() string { return EventPollTerminal }
