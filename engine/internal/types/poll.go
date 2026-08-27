package types

import "time"

// PollVerdict is the poll child's inferred status for the watched work.
type PollVerdict string

const (
	PollVerdictSatisfied PollVerdict = "satisfied"
	PollVerdictFailed    PollVerdict = "failed"
	PollVerdictAdvancing PollVerdict = "advancing"
	PollVerdictStuck     PollVerdict = "stuck"
	PollVerdictExhausted PollVerdict = "exhausted"
)

// PollState is a complete snapshot item for one session-owned Poll.
type PollState struct {
	PollID           string `json:"pollId"`
	Intent           string `json:"intent"`
	Attempt          int    `json:"attempt"`
	DeadlineAt       int64  `json:"deadlineAt"`
	ActiveDispatchID string `json:"activeDispatchId,omitempty"`
	LatestEvidence   string `json:"latestEvidence,omitempty"`
}

// PollTerminalPayload is the terminal, auditable Poll result.
type PollTerminalPayload struct {
	PollState
	Verdict  PollVerdict `json:"verdict"`
	Evidence string      `json:"evidence"`
	Reason   string      `json:"reason,omitempty"`
}

// PollProgressPayload carries an advancing attempt without treating it as a terminal result.
type PollProgressPayload struct {
	Poll     PollState `json:"poll"`
	Evidence string    `json:"evidence"`
}

// PollConfig bounds machine-managed inference loops. The model can request
// narrower work but cannot exceed an operator's configured budget.
type PollConfig struct {
	Model               string `json:"model,omitempty"`
	MinIntervalMs       int64  `json:"minIntervalMs,omitempty"`
	MaxDeadlineMs       int64  `json:"maxDeadlineMs,omitempty"`
	MaxAttempts         int    `json:"maxAttempts,omitempty"`
	MaxActivePerSession int    `json:"maxActivePerSession,omitempty"`
}

const (
	defaultPollMinIntervalMs       int64 = 15_000
	defaultPollMaxDeadlineMs       int64 = 30 * 60 * 1000
	defaultPollMaxAttempts               = 3
	defaultPollMaxActivePerSession       = 4
)

func PollDefaults() PollConfig {
	return PollConfig{
		MinIntervalMs:       defaultPollMinIntervalMs,
		MaxDeadlineMs:       defaultPollMaxDeadlineMs,
		MaxAttempts:         defaultPollMaxAttempts,
		MaxActivePerSession: defaultPollMaxActivePerSession,
	}
}

func (c *PollConfig) Resolved() PollConfig {
	out := PollDefaults()
	if c == nil {
		return out
	}
	if c.Model != "" {
		out.Model = c.Model
	}
	if c.MinIntervalMs > 0 {
		out.MinIntervalMs = c.MinIntervalMs
	}
	if c.MaxDeadlineMs > 0 {
		out.MaxDeadlineMs = c.MaxDeadlineMs
	}
	if c.MaxAttempts > 0 {
		out.MaxAttempts = c.MaxAttempts
	}
	if c.MaxActivePerSession > 0 {
		out.MaxActivePerSession = c.MaxActivePerSession
	}
	return out
}

func (c PollConfig) MinInterval() time.Duration {
	return time.Duration(c.MinIntervalMs) * time.Millisecond
}
func (c PollConfig) MaxDeadline() time.Duration {
	return time.Duration(c.MaxDeadlineMs) * time.Millisecond
}
