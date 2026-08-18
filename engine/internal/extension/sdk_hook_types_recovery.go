package extension

// BeforeRunRecoveryInfo is the payload for the before_run_recovery hook.
// Carries metadata about the run the engine is about to re-execute after
// a crash or daemon restart.
type BeforeRunRecoveryInfo struct {
	// RecoveryID is the engine-issued identifier for this recovery attempt.
	RecoveryID string `json:"recoveryId"`
	// ConversationID is the conversation whose run is being recovered.
	ConversationID string `json:"conversationId"`
	// Attempt is the 1-based recovery attempt number for this run.
	Attempt int `json:"attempt"`
	// MaxAttempts is the configured ceiling on recovery retries.
	MaxAttempts int `json:"maxAttempts"`
	// Prompt is the original user prompt that initiated the recovered run.
	Prompt string `json:"prompt,omitempty"`
	// Model is the model that was in use when the run was interrupted.
	Model string `json:"model,omitempty"`
	// SessionKey identifies the session within the conversation.
	SessionKey string `json:"sessionKey,omitempty"`
}

// BeforeRunRecoveryResult is the optional return value from a
// before_run_recovery handler. The Action field determines whether the
// engine proceeds with recovery ("recover") or abandons it ("skip").
// Nil / zero-valued results mean "no opinion; use engine default (recover)".
type BeforeRunRecoveryResult struct {
	// Action is "recover" (proceed) or "skip" (abandon). Empty means
	// no opinion.
	Action string `json:"action,omitempty"`
	// Instruction is an optional replacement instruction injected into
	// the recovered run's context. Only meaningful when Action is
	// "recover". Empty means use the engine's default recovery context.
	Instruction string `json:"instruction,omitempty"`
}
