package session

// Structured transcript recording for delegated-CLI ROOT runs.
//
// Ion's conversation store is the single source of truth; a delegated
// backend's native session is a disposable cache over it. Before this
// recorder, a CLI-served root turn was persisted as TEXT ONLY (user prompt +
// final assistant text), so any tool activity inside the turn — most
// importantly a client-tool exchange like AskUserQuestions and its structured
// answers — vanished from the canonical transcript. A later cross-provider
// bridge (seedCliHistory) then rebuilt context missing the very answers the
// user just gave.
//
// cliTranscriptRecorder accumulates the run's normalized stream as ordered
// items (assistant text, tool_use with the exact accumulated input JSON, and
// the exact tool result), and persistCliTurn writes them as structured
// conversation messages preserving provider-required tool_use/tool_result
// adjacency. Same-provider native resume is untouched — it rides the
// provider's own thread; this transcript is the cross-provider (and
// restart-bridge) source.
//
// Lifecycle: created at dispatch for native-session backends (beside
// pendingCliUserTurn), fed by handleNormalizedEvent, drained by
// persistCliTurn at run exit. In-memory for the run's duration — the same
// durability class as the text accumulation it replaces.

import (
	"encoding/json"
	"sync"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// cliTranscriptItem is one ordered element of a delegated run's turn content.
type cliTranscriptItem struct {
	kind string // "text" | "tool_use" | "tool_result"
	// text (kind "text")
	text string
	// tool_use fields
	toolID   string
	toolName string
	input    map[string]any
	// tool_result fields (toolID shared)
	resultContent string
	resultIsError bool
}

// cliTranscriptRecorder accumulates one delegated root run's ordered turn
// content. Own lock (not Manager.mu): it is fed from the normalized-event
// path, which must not lengthen its Manager.mu holds for per-token appends.
type cliTranscriptRecorder struct {
	mu    sync.Mutex
	items []cliTranscriptItem
	text  string // pending assistant text, flushed at tool boundaries

	// per-call input accumulation (ToolCallUpdateEvent carries no toolID;
	// the last-started call is the fallback key, mirroring the extension
	// hook accumulation in event_translation.go).
	pendingName map[string]string // toolID → name
	pendingIn   map[string]string // toolID → accumulated input JSON
	indexToID   map[int]string
	lastToolID  string
}

func newCliTranscriptRecorder() *cliTranscriptRecorder {
	return &cliTranscriptRecorder{
		pendingName: make(map[string]string),
		pendingIn:   make(map[string]string),
		indexToID:   make(map[int]string),
	}
}

// record consumes one normalized event. Safe on a nil receiver so the caller
// can invoke it unconditionally for non-CLI runs.
func (r *cliTranscriptRecorder) record(event types.NormalizedEvent) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	switch e := event.Data.(type) {
	case *types.TextChunkEvent:
		r.text += e.Text
	case *types.ToolCallEvent:
		r.flushTextLocked()
		r.pendingName[e.ToolID] = e.ToolName
		r.indexToID[e.Index] = e.ToolID
		r.lastToolID = e.ToolID
	case *types.ToolCallUpdateEvent:
		id := e.ToolID
		if id == "" {
			id = r.lastToolID
		}
		if id != "" {
			r.pendingIn[id] += e.PartialInput
		}
	case *types.ToolCallCompleteEvent:
		id := r.indexToID[e.Index]
		if id == "" {
			return
		}
		var input map[string]any
		if raw := r.pendingIn[id]; raw != "" {
			if err := json.Unmarshal([]byte(raw), &input); err != nil {
				// Keep the call with nil input rather than dropping it: the
				// result that follows still needs its tool_use for adjacency.
				utils.LogWithFields(utils.LevelDebug, "session.cli_transcript", "tool input parse failed; recording tool_use without input", map[string]any{
					"tool_id": id, "error": err.Error(),
				})
			}
		}
		r.items = append(r.items, cliTranscriptItem{
			kind: "tool_use", toolID: id, toolName: r.pendingName[id], input: input,
		})
		delete(r.pendingIn, id)
		delete(r.pendingName, id)
		delete(r.indexToID, e.Index)
	case *types.ToolResultEvent:
		r.items = append(r.items, cliTranscriptItem{
			kind: "tool_result", toolID: e.ToolID,
			resultContent: e.Content, resultIsError: e.IsError,
		})
	}
}

// drain returns the ordered items with any pending text flushed, and resets
// the recorder. Nil-safe (returns nil).
func (r *cliTranscriptRecorder) drain() []cliTranscriptItem {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.flushTextLocked()
	items := r.items
	r.items = nil
	return items
}

func (r *cliTranscriptRecorder) flushTextLocked() {
	if r.text == "" {
		return
	}
	r.items = append(r.items, cliTranscriptItem{kind: "text", text: r.text})
	r.text = ""
}

// appendStructuredCliTurn writes the drained items into the conversation as
// structured messages, preserving provider-required adjacency: an assistant
// message carrying text/tool_use blocks is immediately followed by one user
// message carrying every consecutive tool_result. Returns true when at least
// one message was written.
func appendStructuredCliTurn(conv *conversation.Conversation, items []cliTranscriptItem) bool {
	var assistantBlocks []types.LlmContentBlock
	var results []conversation.ToolResultEntry
	wrote := false

	flushAssistant := func() {
		if len(assistantBlocks) > 0 {
			conversation.AddAssistantMessageNoUsage(conv, assistantBlocks)
			assistantBlocks = nil
			wrote = true
		}
	}
	flushResults := func() {
		if len(results) > 0 {
			conversation.AddToolResults(conv, results)
			results = nil
			wrote = true
		}
	}

	for _, it := range items {
		switch it.kind {
		case "text":
			flushResults()
			assistantBlocks = append(assistantBlocks, types.LlmContentBlock{Type: "text", Text: it.text})
		case "tool_use":
			flushResults()
			assistantBlocks = append(assistantBlocks, types.LlmContentBlock{
				Type: "tool_use", ID: it.toolID, Name: it.toolName, Input: it.input,
			})
		case "tool_result":
			// Results close the assistant message that carried their calls.
			flushAssistant()
			results = append(results, conversation.ToolResultEntry{
				ToolUseID: it.toolID, Content: it.resultContent, IsError: it.resultIsError,
			})
		}
	}
	flushAssistant()
	flushResults()
	return wrote
}
