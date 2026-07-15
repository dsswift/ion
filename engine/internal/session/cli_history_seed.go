package session

import (
	"strings"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// cliHistoryTranscriptMaxBytes bounds the seeded transcript so a very long
// conversation does not produce an unbounded first-CLI prompt. The most recent
// messages are kept (they carry the live thread of the conversation); older
// turns beyond the budget are dropped with a marker.
const cliHistoryTranscriptMaxBytes = 60 * 1024

// seedCliHistory is the BRIDGE half of the resume-vs-bridge decision: it
// gives a delegated-CLI backend (claude-code / codex / grok / cursor) the
// prior conversation history its native session does not carry.
//
// The ApiBackend loads conversation.Messages in-engine, so it always has the
// full history. The delegated CLIs instead run a subprocess that only receives
// opts.Prompt and relies on their own native session resume
// (--resume / ThreadResume / SessionLoad). When no still-valid native session
// exists — a conversation built on the ApiBackend, a fresh CLI run, a restart
// with no persisted cursor, or a cross-provider turn that advanced the leaf
// and staled the cursor — this prepends a transcript of the prior turns to
// opts.Prompt. All three CLI backends send opts.Prompt as the user message,
// so this one change bridges every one of them. The run's exit then captures
// a fresh cursor at the new head (see native_session.go), so subsequent
// same-provider turns resume natively and skip the bridge.
//
// Callers own the decision: resolveCliContinuity (native_session.go) is the
// only call site and invokes this exactly when the serving backend is a
// native-session backend with no valid cursor (opts.CliResumeSessionID is
// left empty on this path). Must be called after opts.Prompt is finalized
// (post slash-expansion) and before dispatch. opts.Prompt is mutated in place.
func (m *Manager) seedCliHistory(s *engineSession, opts *types.RunOptions) {
	if s.conversationID == "" {
		return
	}
	msgs, err := conversation.LoadMessages(s.conversationID, "")
	if err != nil || len(msgs) == 0 {
		return // no prior history to seed (fresh conversation, or load failure)
	}
	transcript := buildCliHistoryTranscript(msgs, cliHistoryTranscriptMaxBytes)
	if transcript == "" {
		return
	}
	opts.Prompt = transcript + "\n\n" + opts.Prompt
	utils.LogWithFields(utils.LevelInfo, "session.cli_history", "seeded prior conversation into CLI turn", map[string]any{
		"key":              s.key,
		"conversation_id":  s.conversationID,
		"messages":         len(msgs),
		"transcript_bytes": len(transcript),
	})
}

// buildCliHistoryTranscript renders prior conversation messages as a bounded,
// recent-biased text transcript wrapped in a <prior-conversation> block. Rows
// are selected newest-first up to maxBytes, then emitted in chronological
// order. Internal rows and empty rows are skipped; tool rows are summarized
// compactly rather than dumping raw payloads. Returns "" when there is nothing
// to seed.
func buildCliHistoryTranscript(msgs []types.SessionMessage, maxBytes int) string {
	type line struct{ text string }
	var picked []line
	total := 0
	truncated := false

	for i := len(msgs) - 1; i >= 0; i-- {
		msg := msgs[i]
		if msg.Internal {
			continue
		}
		content := strings.TrimSpace(msg.Content)
		if content == "" && msg.ToolName != "" {
			content = "(used tool: " + msg.ToolName + ")"
		}
		if content == "" {
			continue
		}
		role := msg.Role
		if role == "" {
			role = "assistant"
		}
		entry := "[" + role + "]: " + content
		if total+len(entry) > maxBytes && len(picked) > 0 {
			truncated = true
			break
		}
		picked = append(picked, line{entry})
		total += len(entry)
	}
	if len(picked) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("This conversation is continuing. Here is the conversation so far, for context:\n\n<prior-conversation>\n")
	if truncated {
		sb.WriteString("[earlier turns omitted]\n\n")
	}
	// picked is newest-first; emit chronologically.
	for i := len(picked) - 1; i >= 0; i-- {
		sb.WriteString(picked[i].text)
		sb.WriteString("\n\n")
	}
	sb.WriteString("</prior-conversation>\n\n")
	sb.WriteString("Continue the conversation. The user's new message follows.")
	return sb.String()
}
