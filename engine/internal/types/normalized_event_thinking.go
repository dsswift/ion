package types

// --- Extended-thinking events (issue #158) ---
//
// These three variants surface the model's reasoning activity as a first-class
// signal so consumers can (a) distinguish "actively reasoning" from "genuinely
// stalled" during long reasoning phases that produce no user-facing text, and
// (b) observe the reasoning lifecycle (start, incremental text, end) and
// interpret it however they choose. The engine emits typed data; consumers
// decide what, if anything, to render.
//
// Emission contract:
//   - The engine emits these ONLY when the provider supplies a reasoning
//     stream (Anthropic extended thinking). Providers that don't stream
//     reasoning emit nothing — consumers must treat a thinking block as
//     OPTIONAL per turn and must not assume one exists.
//   - Boundaries (ThinkingBlockStartEvent / ThinkingBlockEndEvent) always emit
//     when a reasoning block is present; the per-token ThinkingDeltaEvent
//     stream is gated by ThinkingConfig.StreamDeltas (default on). A consumer
//     that disables delta streaming still receives the boundaries, so the
//     liveness signal and the block summary survive.
//   - signature_delta (Anthropic's opaque per-block signature) is NOT display
//     text and is never surfaced as a ThinkingDeltaEvent; it rides only in the
//     persisted assistant block.
//   - redacted_thinking blocks (encrypted, no readable text) emit
//     ThinkingBlockStartEvent and a ThinkingBlockEndEvent with Redacted=true
//     and produce no ThinkingDeltaEvent.

// ThinkingBlockStartEvent marks the start of a reasoning block. Empty payload;
// its arrival is the signal. Signals that a reasoning segment has begun;
// consumers may track elapsed time or surface progress as appropriate.
type ThinkingBlockStartEvent struct{}

func (ThinkingBlockStartEvent) eventType() string { return EventThinkingBlockStart }

// ThinkingDeltaEvent carries an incremental chunk of reasoning text — the peer
// of TextChunkEvent for the thinking channel. Gated by
// ThinkingConfig.StreamDeltas (default on).
type ThinkingDeltaEvent struct {
	Text string `json:"text"`
}

func (ThinkingDeltaEvent) eventType() string { return EventThinkingDelta }

// ThinkingBlockEndEvent marks the end of a reasoning block and carries a
// summary so consumers know the segment completed and can surface the elapsed
// time as appropriate — without having accumulated the deltas (and so consumers
// that disabled delta streaming, or that loaded the block from history without
// persisted text, still have a summary).
type ThinkingBlockEndEvent struct {
	// TotalTokens is an APPROXIMATE thinking-token count for this block.
	// Providers fold thinking into the final output-token usage (Anthropic
	// does not break out a per-block thinking-token count), so the engine
	// estimates this from accumulated reasoning text length (~chars/4) when
	// no authoritative count is available. Treat as advisory, not billing
	// ground truth.
	TotalTokens int `json:"totalTokens,omitempty"`
	// ElapsedSeconds is the wall-clock duration from block start to block end.
	ElapsedSeconds float64 `json:"elapsedSeconds,omitempty"`
	// Redacted is true for redacted_thinking blocks (encrypted reasoning with
	// no readable text). Signals that reasoning was performed but its content
	// was redacted by the provider; consumers interpret. When true, no
	// ThinkingDeltaEvent was emitted for this block.
	Redacted bool `json:"redacted,omitempty"`
}

func (ThinkingBlockEndEvent) eventType() string { return EventThinkingBlockEnd }
