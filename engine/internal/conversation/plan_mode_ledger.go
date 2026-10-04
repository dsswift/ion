package conversation

import (
	"github.com/dsswift/ion/engine/internal/types"
)

// plan_mode_ledger.go — what the model has been told about plan mode, read
// from the conversation itself.
//
// Plan-mode instructions are delivered as notices appended to the conversation
// where the mode changed, not through the system prompt. Whether a notice is
// due is therefore a question about history: has the model, on the path it can
// currently see, been told what the run's mode now is?
//
// Answering from the tree rather than from a flag on the session is what keeps
// the answer right when the visible history changes underneath the session. A
// rewind moves the leaf, a compaction or a clear drops everything before it,
// and in each case the walk below sees exactly what the model will see.

// PlanModeTold is the plan-mode state the model was last told on the current
// context path.
type PlanModeTold struct {
	// Active is true when the most recent notice was an enter or a reminder,
	// false when it was an exit or when the path holds no notice.
	Active bool
	// PlanFilePath is the plan file the most recent enter or reminder named.
	PlanFilePath string
	// TurnsSince counts assistant turns after the most recent notice.
	TurnsSince int
	// exited holds the plan files an exit notice on the path named.
	exited map[string]bool
}

// HasExited reports whether the path holds an exit notice for planFilePath:
// the model planned against this file, left plan mode, and is now coming back.
func (t PlanModeTold) HasExited(planFilePath string) bool {
	return planFilePath != "" && t.exited[planFilePath]
}

// PlanModeToldAt walks the current context path and reports what the model was
// last told about plan mode. A compaction or a clear resets it, because
// neither carries earlier messages into the context the model sees.
func PlanModeToldAt(conv *Conversation) PlanModeTold {
	var told PlanModeTold
	for _, entry := range getContextPathEntries(conv) {
		switch entry.Type {
		case EntryCompaction, EntryCleared:
			told = PlanModeTold{}
		case EntryMessage:
			md := asMessageData(entry.Data)
			if md == nil || md.DisplayOnly {
				continue
			}
			switch types.InjectionKind(md.InjectionKind) {
			case types.InjectionKindPlanModeEnter, types.InjectionKindPlanModeReminder:
				told.Active = true
				told.PlanFilePath = md.NoticePlanFile
				told.TurnsSince = 0
			case types.InjectionKindPlanModeExit:
				told.Active = false
				told.TurnsSince = 0
				if md.NoticePlanFile != "" {
					if told.exited == nil {
						told.exited = make(map[string]bool, 1)
					}
					told.exited[md.NoticePlanFile] = true
				}
			default:
				if md.Role == "assistant" {
					told.TurnsSince++
				}
			}
		}
	}
	return told
}

// ReconcilePlanMode returns the notice that brings what the model was told in
// line with the run's live mode, or "" when they already agree.
//
//   - Planning, and the model was not told (or was told about another plan
//     file): enter.
//   - Planning, told, and reminderInterval assistant turns have passed since
//     the last notice: reminder. An interval of zero or less never reminds.
//   - Not planning, but the model was told it is: exit.
func ReconcilePlanMode(told PlanModeTold, planning bool, planFilePath string, reminderInterval int) types.InjectionKind {
	if !planning {
		if told.Active {
			return types.InjectionKindPlanModeExit
		}
		return types.InjectionKindNone
	}
	if !told.Active || (planFilePath != "" && told.PlanFilePath != planFilePath) {
		return types.InjectionKindPlanModeEnter
	}
	if reminderInterval > 0 && told.TurnsSince >= reminderInterval {
		return types.InjectionKindPlanModeReminder
	}
	return types.InjectionKindNone
}

// AddPlanModeNotice appends a plan-mode notice as a machine-authored user
// turn. planFilePath is recorded on the entry so PlanModeToldAt can read it
// back.
//
// transient keeps the notice out of the entry tree: the model sees it on this
// call and it is gone on reload. That is the SuppressSystemMessages contract;
// a caller using it must remember for itself that the notice was sent.
func AddPlanModeNotice(conv *Conversation, kind types.InjectionKind, text, planFilePath string, transient bool) *SessionEntry {
	if transient {
		AddTransientUserMessage(conv, text)
		return nil
	}
	blocks := []types.LlmContentBlock{textBlock(text)}

	conv.lock()
	defer conv.unlock()
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks})
	if conv.Entries == nil {
		return nil
	}
	entry := appendEntryLocked(conv, EntryMessage, MessageData{
		Role:            "user",
		Content:         blocks,
		InjectionKind:   string(kind),
		MachineAuthored: kind.IsMachineToMachine(),
		NoticePlanFile:  planFilePath,
	}, "")
	conv.Messages[len(conv.Messages)-1].EntryID = entry.ID
	return entry
}
