package ion

// RunRecoveryConfig controls durable recovery for later runs in this session.
// Enabled is required by [Context.SetRunRecovery]. MaxAttempts of zero uses
// the engine default.
type RunRecoveryConfig struct {
	Enabled     *bool `json:"enabled,omitempty"`
	MaxAttempts int   `json:"maxAttempts,omitempty"`
}

// BeforeRunRecoveryInfo is delivered before the engine resumes a journaled run.
type BeforeRunRecoveryInfo struct {
	RecoveryID     string `json:"recoveryId"`
	ConversationID string `json:"conversationId"`
	Attempt        int    `json:"attempt"`
	MaxAttempts    int    `json:"maxAttempts"`
	Prompt         string `json:"prompt,omitempty"`
	Model          string `json:"model,omitempty"`
	SessionKey     string `json:"sessionKey,omitempty"`
}

// BeforeRunRecoveryResult lets an extension skip recovery or replace the
// engine's generic continuation instruction. Empty fields abstain.
type BeforeRunRecoveryResult struct {
	Action      string `json:"action,omitempty"`
	Instruction string `json:"instruction,omitempty"`
}
