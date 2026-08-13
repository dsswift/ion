package conversation

import (
	"errors"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// DispatchTranscriptRecorder mirrors a dispatched native-session backend into
// Ion conversation storage. Native backends own their resume state externally,
// but clients load dispatch history through get_conversation, which requires an
// Ion file at the published child conversation id.
//
// Engine-owned child backends already create that file before SessionInit. In
// that case SetConversationID detects it and disables the mirror, preventing
// duplicate turns. Native children have no file, so the recorder creates one
// with the dispatch task and then persists normalized text/tool activity.
type DispatchTranscriptRecorder struct {
	mu       sync.Mutex
	task     string
	model    string
	convID   string
	conv     *Conversation
	text     string
	disabled bool
	closed   bool
}

func NewDispatchTranscriptRecorder(task, model string) *DispatchTranscriptRecorder {
	return &DispatchTranscriptRecorder{task: task, model: model}
}

// SetConversationID binds the recorder once SessionInit reveals the backend's
// child id. Existing files are authoritative and disable mirroring.
func (r *DispatchTranscriptRecorder) SetConversationID(conversationID string) {
	if r == nil || conversationID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.convID != "" || r.disabled || r.closed {
		return
	}
	r.convID = conversationID
	if _, err := Load(conversationID, ""); err == nil {
		r.disabled = true
		return
	} else if !errors.Is(err, ErrNotFound) {
		r.disabled = true
		utils.LogWithFields(utils.LevelWarn, "conversation.dispatch_transcript", "dispatch transcript probe failed", map[string]any{
			"conversation_id": conversationID, "error": err.Error(),
		})
		return
	}
	r.conv = CreateConversation(conversationID, "", r.model)
	if r.task != "" {
		AddUserMessage(r.conv, r.task)
	}
	r.saveLocked("init")
}

// Record persists the normalized child stream at message/tool boundaries. Text
// chunks are buffered until a tool boundary or Close, avoiding a disk rewrite
// per token while preserving exact text order around tool calls.
func (r *DispatchTranscriptRecorder) Record(event types.NormalizedEvent) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.disabled || r.closed || r.conv == nil {
		return
	}
	switch e := event.Data.(type) {
	case *types.TextChunkEvent:
		r.text += e.Text
	case *types.ToolCallEvent:
		r.flushTextLocked()
		AddAssistantMessageNoUsage(r.conv, []types.LlmContentBlock{{
			Type: "tool_use", ID: e.ToolID, Name: e.ToolName,
		}})
		r.saveLocked("tool_start")
	case *types.ToolResultEvent:
		AddToolResults(r.conv, []ToolResultEntry{{
			ToolUseID: e.ToolID, Content: e.Content, IsError: e.IsError,
		}})
		r.saveLocked("tool_result")
	}
}

// Close seals the mirror before terminal agent state is published. finalOutput
// is used only when the normalized stream carried no assistant text.
func (r *DispatchTranscriptRecorder) Close(finalOutput string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.disabled || r.closed {
		return
	}
	r.closed = true
	if r.conv == nil {
		// SessionInit may be absent on a failed backend. There is no stable id to
		// publish or load, so the caller's warning remains the diagnostic.
		return
	}
	if r.text == "" && !hasAssistantText(r.conv) {
		r.text = finalOutput
	}
	r.flushTextLocked()
	r.saveLocked("terminal")
}

func (r *DispatchTranscriptRecorder) flushTextLocked() {
	if r.text == "" || r.conv == nil {
		return
	}
	AddAssistantMessageNoUsage(r.conv, []types.LlmContentBlock{{Type: "text", Text: r.text}})
	r.text = ""
}

func (r *DispatchTranscriptRecorder) saveLocked(reason string) {
	if r.conv == nil {
		return
	}
	if err := Save(r.conv, ""); err != nil {
		utils.LogWithFields(utils.LevelWarn, "conversation.dispatch_transcript", "dispatch transcript save failed", map[string]any{
			"conversation_id": r.convID, "reason": reason, "error": err.Error(),
		})
	}
}

func hasAssistantText(conv *Conversation) bool {
	for _, message := range conv.Messages {
		if message.Role != "assistant" {
			continue
		}
		blocks, _ := message.Content.([]types.LlmContentBlock) //nolint:errcheck // non-block assistant content has no structured text
		for _, block := range blocks {
			if block.Type == "text" && block.Text != "" {
				return true
			}
		}
	}
	return false
}

// MaterializeDispatchTranscript creates a minimal Ion-readable transcript when
// only terminal output is available (legacy recovery and defensive fallback).
func MaterializeDispatchTranscript(conversationID, task, output, model string) error {
	if conversationID == "" || (task == "" && output == "") {
		return nil
	}
	if _, err := Load(conversationID, ""); err == nil {
		return nil
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	conv := CreateConversation(conversationID, "", model)
	if task != "" {
		AddUserMessage(conv, task)
	}
	if output != "" {
		AddAssistantMessageNoUsage(conv, []types.LlmContentBlock{{Type: "text", Text: output}})
	}
	if err := Save(conv, ""); err != nil {
		return err
	}
	utils.LogWithFields(utils.LevelInfo, "conversation.dispatch_transcript", "dispatch transcript materialized", map[string]any{
		"conversation_id": conversationID, "task_bytes": len(task), "output_bytes": len(output),
	})
	return nil
}
