package extcontext

import (
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Activity-kind discriminators for engine_dispatch_activity. These mirror the
// DispatchActivityKind wire field values documented on EngineEvent.
const (
	dispatchActivityText      = "text"
	dispatchActivityToolStart = "tool_start"
	dispatchActivityToolEnd   = "tool_end"
)

// textCoalesceInterval is how long streamed text chunks accumulate before a
// single engine_dispatch_activity{kind:text} delta is emitted. Coalescing cuts
// relay frame count (a token-by-token stream is chatty over the LAN/relay
// WebSocket) while staying far under the stale-transcript threshold the live
// sub-agent forwarding feature exists to avoid. See the plan's "Resolved
// design defaults".
const textCoalesceInterval = 500 * time.Millisecond

// DispatchActivityEmitter forwards a running dispatched (sub-)agent's
// intra-turn activity — tool calls starting, tool results returning, and
// streamed assistant text — to the parent session's client event stream as
// engine_dispatch_activity events. It is the push half of the live-dispatch
// transcript (the file-backed reconcile is the snapshot authority).
//
// Concurrency: the child backend's OnNormalized callback runs on the child's
// event-delivery goroutine; a single dispatch has exactly one such goroutine,
// so the per-call methods (HandleToolStart/End, AccumulateText) are not
// concurrent with each other. The flush timer, however, fires on its own
// goroutine, so every field touched by both the timer and the callback is
// guarded by mu.
//
// Exported so both sub-agent spawn paths reuse it: the extension-dispatch path
// (dispatch_agent.go in this package) and the Agent-tool spawn path
// (prompt_agent_spawner.go in the session package). Both produce the same child
// OnNormalized stream and must emit the same engine_dispatch_activity deltas.
type DispatchActivityEmitter struct {
	// emit is the parent-keyed emit sink — the same path engine_dispatch_start
	// and engine_dispatch_end use. The dispatch path passes sa.Emit; the
	// spawner passes a closure over m.emit(capturedKey, …).
	emit      func(types.EngineEvent)
	agentID   string
	agentName string

	mu sync.Mutex
	// convID is the child conversation id, learned from SessionInitEvent. Until
	// it is known, deltas are buffered-but-not-emitted would be wrong (we'd lose
	// ordering), so we emit with an empty convID and let the client route on
	// DispatchAgentID; convID fills in as soon as SessionInit arrives. In
	// practice SessionInitEvent is the child's first event, so convID is set
	// before any tool/text delta.
	convID string
	// seq is the monotonic per-dispatch sequence assigned to every emitted
	// delta. It orders deltas and keys a streaming-text run on the client.
	seq int
	// textBuf accumulates streamed text between flushes. flushTimer fires once
	// per buffered run; textSeq is the seq slot the whole coalesced run is keyed
	// to (assigned when the run starts, reused for the single emitted delta).
	textBuf    string
	textSeq    int
	flushTimer *time.Timer
	closed     bool
}

// NewDispatchActivityEmitter builds an emitter that forwards engine_dispatch_activity
// events through the provided parent-keyed emit sink.
func NewDispatchActivityEmitter(emit func(types.EngineEvent), agentID, agentName string) *DispatchActivityEmitter {
	return &DispatchActivityEmitter{emit: emit, agentID: agentID, agentName: agentName}
}

// SetConversationID records the child conversation id once it is known (from
// SessionInitEvent). Safe to call once; later calls are ignored so the id is
// stable for the dispatch's lifetime.
func (e *DispatchActivityEmitter) SetConversationID(convID string) {
	if convID == "" {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.convID == "" {
		e.convID = convID
	}
}

// nextSeq returns the next monotonic sequence number. Caller holds e.mu.
func (e *DispatchActivityEmitter) nextSeq() int {
	e.seq++
	return e.seq
}

// emitEvent builds and emits one engine_dispatch_activity EngineEvent through
// the parent-keyed emit sink. Caller holds e.mu (so convID/seq reads are
// consistent with concurrent flushes).
func (e *DispatchActivityEmitter) emitEvent(ev types.EngineEvent) {
	ev.Type = "engine_dispatch_activity"
	ev.DispatchAgentID = e.agentID
	ev.DispatchConversationID = e.convID
	ev.DispatchActivityTs = time.Now().UnixMilli()
	e.emit(ev)
}

// HandleToolStart flushes any pending text (so ordering is preserved: text
// before the tool that follows it), then emits a tool_start delta.
func (e *DispatchActivityEmitter) HandleToolStart(toolName, toolID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.flushTextLocked()
	seq := e.nextSeq()
	e.emitEvent(types.EngineEvent{
		DispatchActivityKind: dispatchActivityToolStart,
		DispatchSeq:          seq,
		ToolName:             toolName,
		ToolID:               toolID,
	})
	utils.LogWithFields(utils.LevelDebug, "server", "activity emit", map[string]any{"dispatch_activity_tool_start": dispatchActivityToolStart, "agent_name": e.agentName, "tool_i_d": toolID, "seq": seq, "conversation_id": e.convID})
}

// HandleToolEnd flushes pending text, then emits a tool_end delta (status-only:
// the reconcile snapshot carries the full tool result body within one cycle).
func (e *DispatchActivityEmitter) HandleToolEnd(toolID string, isError bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.flushTextLocked()
	seq := e.nextSeq()
	e.emitEvent(types.EngineEvent{
		DispatchActivityKind: dispatchActivityToolEnd,
		DispatchSeq:          seq,
		ToolID:               toolID,
		DispatchToolIsError:  isError,
	})
	utils.LogWithFields(utils.LevelDebug, "server", "activity emit", map[string]any{"dispatch_activity_tool_end": dispatchActivityToolEnd, "agent_name": e.agentName, "tool_i_d": toolID, "is_error": isError, "seq": seq, "conversation_id": e.convID})
}

// AccumulateText appends a streamed text chunk to the coalesce buffer and
// arms the flush timer if it is not already running. The buffered run is keyed
// to a single seq slot, assigned when the run starts.
func (e *DispatchActivityEmitter) AccumulateText(text string) {
	if text == "" {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	if e.textBuf == "" {
		// Starting a fresh coalesced run: reserve its seq slot now so the
		// emitted delta orders correctly relative to surrounding tool deltas.
		e.textSeq = e.nextSeq()
	}
	e.textBuf += text
	if e.flushTimer == nil {
		e.flushTimer = time.AfterFunc(textCoalesceInterval, e.flushTextTimer)
		utils.LogWithFields(utils.LevelDebug, "server", "activity text buffered (flush armed)", map[string]any{"agent_name": e.agentName, "text_seq": e.textSeq, "count": len(e.textBuf), "conversation_id": e.convID})
	} else {
		utils.LogWithFields(utils.LevelDebug, "server", "activity text buffered (flush pending)", map[string]any{"agent_name": e.agentName, "text_seq": e.textSeq, "count": len(e.textBuf), "conversation_id": e.convID})
	}
}

// flushTextTimer is the time.AfterFunc callback. It acquires the lock and
// flushes the buffer.
func (e *DispatchActivityEmitter) flushTextTimer() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.flushTextLocked()
}

// flushTextLocked emits the accumulated text as one text delta and clears the
// buffer. Caller holds e.mu. No-op when the buffer is empty. Stops/clears the
// flush timer so the next AccumulateText re-arms it.
func (e *DispatchActivityEmitter) flushTextLocked() {
	if e.flushTimer != nil {
		e.flushTimer.Stop()
		e.flushTimer = nil
	}
	if e.textBuf == "" {
		return
	}
	text := e.textBuf
	seq := e.textSeq
	e.textBuf = ""
	e.emitEvent(types.EngineEvent{
		DispatchActivityKind: dispatchActivityText,
		DispatchSeq:          seq,
		DispatchTextDelta:    text,
	})
	utils.LogWithFields(utils.LevelDebug, "server", "activity emit (flushed)", map[string]any{"dispatch_activity_text": dispatchActivityText, "agent_name": e.agentName, "seq": seq, "count": len(text), "conversation_id": e.convID})
}

// Close flushes any pending text and disables further buffering. Called when
// the dispatch finishes so a trailing partial text run is not lost.
func (e *DispatchActivityEmitter) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.flushTextLocked()
	e.closed = true
}
