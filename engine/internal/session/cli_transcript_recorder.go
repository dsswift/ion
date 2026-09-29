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
	kind string // "text" | "tool_use" | "tool_result" | "native_compaction" | "steer"
	// text (kind "text")
	text string
	// tool_use fields
	toolID   string
	toolName string
	input    map[string]any
	// tool_result fields (toolID shared)
	resultContent string
	resultIsError bool
	// native_compaction payload (kind "native_compaction"): the delegated CLI
	// compacted its own session at this point in the stream.
	nativeCompaction *conversation.NativeCompactionData
	// steer fields (kind "steer"): a mid-turn message the CLI consumed at
	// this point in the stream. steerKind is a types.InjectionKind wire
	// value, empty for a client steer; text carries the message.
	steerKind string
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
	case *types.SteerInjectedEvent:
		// Recorded where the CLI reported consuming it: after the output the
		// model produced without it, before the output it produced with it.
		// A steer without text came from a backend that persists its own
		// steers; there is nothing to record here.
		if e.Text == "" {
			return
		}
		r.flushTextLocked()
		r.items = append(r.items, cliTranscriptItem{kind: "steer", text: e.Text, steerKind: e.Kind})
	case *types.NativeCompactionEvent:
		// Recorded in stream order rather than appended at the end of the turn:
		// a CLI compacts partway through its own work, and the marker is only
		// truthful where it actually happened.
		r.flushTextLocked()
		r.items = append(r.items, cliTranscriptItem{
			kind: "native_compaction",
			nativeCompaction: &conversation.NativeCompactionData{
				Trigger: e.Trigger, PreTokens: e.PreTokens,
				MessagesSummarized: e.MessagesSummarized, DurationMs: e.DurationMs,
			},
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
//
// model is the delegated backend's serving model, stamped on every assistant
// entry this writes. An unstamped entry is unattributable once the run is over.
//
// finalUsage is the run's provider accounting, or nil when the run reported
// none. It is stamped on the LAST assistant message only, because that is the
// message GetContextUsage's backward scan reads as the conversation's
// occupancy baseline; annotating the earlier assistant messages of the same
// turn would inflate conv.TotalInputTokens by counting one turn's cache reads
// once per intermediate tool round-trip.
//
// The items are grouped into ordered writes before anything is appended, so
// "which assistant message is last" is known when the first one is written
// rather than discovered afterwards.
// Returns whether anything was written, and the canonical tree-entry ids of
// the assistant messages written, in transcript order. The ids are what
// engine_assistant_turn_persisted announces: this backend writes its turn at
// run exit, so they cannot ride message_end the way an engine-owned run's do.
func appendStructuredCliTurn(conv *conversation.Conversation, items []cliTranscriptItem, model string, finalUsage *types.LlmUsage) (bool, []string) {
	// One ordered write. Exactly one of the two fields is populated.
	type turnWrite struct {
		assistant        []types.LlmContentBlock
		results          []conversation.ToolResultEntry
		nativeCompaction *conversation.NativeCompactionData
		steer            *cliTranscriptItem
	}
	var writes []turnWrite
	var assistantBlocks []types.LlmContentBlock
	var results []conversation.ToolResultEntry

	flushAssistant := func() {
		if len(assistantBlocks) > 0 {
			writes = append(writes, turnWrite{assistant: assistantBlocks})
			assistantBlocks = nil
		}
	}
	flushResults := func() {
		if len(results) > 0 {
			writes = append(writes, turnWrite{results: results})
			results = nil
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
		case "native_compaction":
			// Close whatever is open so the marker lands between the messages
			// it actually separated, then record it as its own write.
			flushAssistant()
			flushResults()
			writes = append(writes, turnWrite{nativeCompaction: it.nativeCompaction})
		case "steer":
			// A steer is its own user message, after the tool results the
			// model had already received and before its next reply.
			flushAssistant()
			flushResults()
			steer := it
			writes = append(writes, turnWrite{steer: &steer})
		}
	}
	flushAssistant()
	flushResults()

	lastAssistant := -1
	for i := range writes {
		if len(writes[i].assistant) > 0 {
			lastAssistant = i
		}
	}
	assistantEntryIDs := make([]string, 0, len(writes))
	for i := range writes {
		if writes[i].nativeCompaction != nil {
			// Appended as EntryNativeCompaction, never EntryCompaction: this
			// records that the provider evicted its own cache, and must not
			// truncate Ion's context path. See the entry type's doc comment.
			conversation.AppendEntry(conv, conversation.EntryNativeCompaction, *writes[i].nativeCompaction)
			continue
		}
		if len(writes[i].results) > 0 {
			conversation.AddToolResults(conv, writes[i].results)
			continue
		}
		if steer := writes[i].steer; steer != nil {
			appendCliSteer(conv, steer.text, steer.steerKind)
			continue
		}
		if finalUsage != nil && i == lastAssistant {
			conversation.AddAssistantMessageWithUsageAndModel(conv, writes[i].assistant, *finalUsage, model)
		} else {
			conversation.AddAssistantMessageNoUsage(conv, writes[i].assistant, model)
		}
		// Announce only the entries that carry TEXT. A history load flattens one
		// assistant entry into a text row keyed by the entry id plus a tool row
		// per tool_use keyed by its tool id, so a tool-only entry produces no
		// row a consumer could re-key to this id. Announcing them anyway is what
		// made the counts disagree -- a turn with nine tool calls announced ten
		// ids against two text rows, and the consumer correctly refused the
		// whole mapping rather than assign a wrong identity.
		if !blocksCarryText(writes[i].assistant) {
			continue
		}
		if id := conversation.LastMessageEntryID(conv); id != "" {
			assistantEntryIDs = append(assistantEntryIDs, id)
		}
	}
	return len(writes) > 0, assistantEntryIDs
}

// appendCliSteer persists one consumed steer the way the API run loop does: a
// user turn classified by its injection kind, followed by the steer marker
// that lets a reload show where the steer was applied.
func appendCliSteer(conv *conversation.Conversation, text, kind string) {
	entry := conversation.AddUserMessageWithKind(conv, text, kind)
	conversation.AppendEntry(conv, conversation.EntrySteerMarker, conversation.SteerMarkerData{
		MessageLength:   len(text),
		Kind:            kind,
		MachineAuthored: types.InjectionKind(kind).IsMachineToMachine(),
	})
	entryID := ""
	if entry != nil {
		entryID = entry.ID
	}
	utils.LogWithFields(utils.LevelInfo, "session.cli_transcript", "persisted consumed steer", map[string]any{
		"conversation_id": conv.ID, "entry_id": entryID, "count": len(text), "kind": kind,
	})
}

// blocksCarryText reports whether an assistant message has any text block.
// Only such a message yields a non-tool row on a history load, which is what
// makes its entry id re-keyable by a consumer; a tool-only message yields tool
// rows alone, and those are keyed by tool id on both sides.
func blocksCarryText(blocks []types.LlmContentBlock) bool {
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			return true
		}
	}
	return false
}
