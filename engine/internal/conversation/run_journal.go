package conversation

import (
	"encoding/json"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// RunJournalEntry is the durable state of one accepted root run. It lives in
// the conversation tree header, so a restart observes the same checkpoint as
// the transcript rather than reconciling a mutable sidecar.
type RunJournalEntry struct {
	RecoveryID         string          `json:"recoveryId"`
	SessionKey         string          `json:"sessionKey"`
	Prompt             string          `json:"prompt"`
	Model              string          `json:"model,omitempty"`
	Overrides          json.RawMessage `json:"overrides,omitempty"`
	UserEntryID        string          `json:"userEntryId,omitempty"`
	CheckpointID       string          `json:"checkpointId,omitempty"`
	AttemptCount       int             `json:"attemptCount,omitempty"`
	CreatedAt          int64           `json:"createdAt"`
	UpdatedAt          int64           `json:"updatedAt"`
	InterruptedToolIDs []string        `json:"interruptedToolIds,omitempty"`
}

// BeginRunRecovery records accepted work before the caller starts its backend
// run. The caller persists the conversation immediately after this mutation.
func BeginRunRecovery(conv *Conversation, entry RunJournalEntry) {
	conv.lock()
	defer conv.unlock()
	if entry.CreatedAt == 0 {
		entry.CreatedAt = time.Now().UnixMilli()
	}
	entry.UpdatedAt = time.Now().UnixMilli()
	if entry.CheckpointID == "" && conv.LeafID != nil {
		entry.CheckpointID = *conv.LeafID
	}
	conv.ActiveRun = &entry
}

// ActiveRunRecovery returns a detached snapshot of recovery state.
func ActiveRunRecovery(conv *Conversation) *RunJournalEntry {
	conv.lock()
	defer conv.unlock()
	if conv.ActiveRun == nil {
		return nil
	}
	out := *conv.ActiveRun
	out.InterruptedToolIDs = append([]string(nil), conv.ActiveRun.InterruptedToolIDs...)
	out.Overrides = append(json.RawMessage(nil), conv.ActiveRun.Overrides...)
	return &out
}

// MarkRunRecoveryAttempt advances durable retry accounting before recovery
// dispatch, preventing a crash between launch and journal update from looping.
func MarkRunRecoveryAttempt(conv *Conversation) *RunJournalEntry {
	conv.lock()
	defer conv.unlock()
	if conv.ActiveRun == nil {
		return nil
	}
	conv.ActiveRun.AttemptCount++
	conv.ActiveRun.UpdatedAt = time.Now().UnixMilli()
	out := *conv.ActiveRun
	return &out
}

// ClearRunRecovery removes the active journal after an authoritative terminal
// outcome or explicit user cancellation.
func ClearRunRecovery(conv *Conversation) {
	conv.lock()
	defer conv.unlock()
	conv.ActiveRun = nil
}

// ClearRunRecoveryIf removes only the journal still owned by recoveryID. A
// delayed exit from an earlier recovery must never erase a replacement journal.
func ClearRunRecoveryIf(conv *Conversation, recoveryID string) bool {
	conv.lock()
	defer conv.unlock()
	if conv.ActiveRun == nil || conv.ActiveRun.RecoveryID != recoveryID {
		return false
	}
	conv.ActiveRun = nil
	return true
}

// RecoveryContinuationPrompt is machine-authored context for a resumed run.
// It deliberately asks the model to inspect durable state before retrying an
// operation whose external effects may have happened before interruption.
func RecoveryContinuationPrompt() string {
	return "[SYSTEM] This run was interrupted by an engine restart. Continue from the durable conversation state. Inspect repository and tool state before retrying any operation because an interrupted tool may have completed externally. Do not repeat the original user request as a new user turn."
}

// AddRecoveryContinuation appends the machine-authored continuation needed to
// restart a root run without duplicating its canonical user entry.
func AddRecoveryContinuation(conv *Conversation) *SessionEntry {
	return AddUserMessageWithKind(conv, RecoveryContinuationPrompt(), string(types.InjectionKindRunRecovery))
}
