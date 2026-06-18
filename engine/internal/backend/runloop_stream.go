package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// processStream consumes LLM stream events, emits normalized events, and
// returns the collected assistant content blocks, stop reason, and usage.
func (b *ApiBackend) processStream(
	ctx context.Context,
	run *activeRun,
	events <-chan types.LlmStreamEvent,
	errc <-chan error,
) ([]types.LlmContentBlock, string, *types.LlmUsage, error) {

	var assistantBlocks []types.LlmContentBlock
	var currentBlockIndex int
	var currentPartialJSON strings.Builder
	var stopReason string
	var cumUsage types.LlmUsage
	var toolCallIndex int

	// Per-thinking-block tracking. A reasoning block spans a
	// content_block_start{type:"thinking"|"redacted_thinking"} →
	// content_block_delta{thinking_delta}* → content_block_stop sequence.
	// We track whether the current block is a thinking block, when it
	// started (for ElapsedSeconds), how much reasoning text accumulated (for
	// the token estimate), and whether it is redacted. See issue #158.
	thinkingActive := false
	thinkingRedacted := false
	var thinkingStartedAt time.Time
	var thinkingTextLen int

	for ev := range events {
		if ctx.Err() != nil {
			return nil, "", nil, ctx.Err()
		}

		switch ev.Type {
		case "message_start":
			if ev.MessageInfo != nil {
				cumUsage = ev.MessageInfo.Usage
				// Emit cache token counts so clients see them immediately
				// (TS emits cache_read from message_start).
				if cumUsage.CacheReadInputTokens > 0 || cumUsage.CacheCreationInputTokens > 0 {
					cri := cumUsage.CacheReadInputTokens
					cci := cumUsage.CacheCreationInputTokens
					b.emit(run, types.NormalizedEvent{Data: &types.UsageEvent{
						Usage: types.UsageData{
							CacheReadInputTokens:     &cri,
							CacheCreationInputTokens: &cci,
						},
					}})
				}
			}

		case "content_block_start":
			if ev.ContentBlock == nil {
				continue
			}
			cb := ev.ContentBlock
			block := types.LlmContentBlock{
				Type:      cb.Type,
				ID:        cb.ID,
				Name:      cb.Name,
				Text:      cb.Text,
				ToolUseID: cb.ToolUseID,
			}
			// web_search_tool_result: serialize search results into Content string
			if cb.Type == "web_search_tool_result" && cb.Content != nil {
				if raw, err := json.Marshal(cb.Content); err == nil {
					block.Content = string(raw)
				}
			}
			currentBlockIndex = ev.BlockIndex
			assistantBlocks = appendOrGrow(assistantBlocks, currentBlockIndex, block)

			// Extended-thinking block start (issue #158). Anthropic emits a
			// "thinking" block (readable reasoning, streamed via thinking_delta)
			// or a "redacted_thinking" block (encrypted, no readable text).
			// Emit ThinkingBlockStartEvent for either; the block remains in
			// assistantBlocks for history. Boundaries always emit (the
			// per-token delta stream is gated separately).
			if cb.Type == "thinking" || cb.Type == "redacted_thinking" {
				thinkingActive = true
				thinkingRedacted = cb.Type == "redacted_thinking"
				thinkingStartedAt = time.Now()
				thinkingTextLen = 0
				utils.Debug("ApiBackend", fmt.Sprintf(
					"thinking block start: type=%s blockIndex=%d runID=%s",
					cb.Type, currentBlockIndex, run.requestID))
				b.emit(run, types.NormalizedEvent{Data: &types.ThinkingBlockStartEvent{}})
			} else {
				// Non-thinking block opened: any prior thinking block was
				// already closed by its content_block_stop. Defensive reset so
				// stray state never bleeds across blocks.
				thinkingActive = false
			}

			if cb.Type == "tool_use" {
				b.emit(run, types.NormalizedEvent{Data: &types.ToolCallEvent{
					ToolName: cb.Name,
					ToolID:   cb.ID,
					Index:    toolCallIndex,
				}})
				toolCallIndex++
				currentPartialJSON.Reset()
			}

			// Server-side tool use (e.g. web_search) -- accumulate input JSON but don't execute locally
			if cb.Type == "server_tool_use" {
				currentPartialJSON.Reset()
			}

			// Server-side search results -- emit event so consumers can
			// surface the citations alongside the assistant message.
			if cb.Type == "web_search_tool_result" && cb.Content != nil {
				if results, ok := cb.Content.([]any); ok {
					var hits []types.WebSearchHit
					for _, r := range results {
						if m, ok := r.(map[string]any); ok {
							hit := types.WebSearchHit{}
							if t, ok := m["title"].(string); ok {
								hit.Title = t
							}
							if u, ok := m["url"].(string); ok {
								hit.URL = u
							}
							if hit.URL != "" {
								hits = append(hits, hit)
							}
						}
					}
					if len(hits) > 0 {
						b.emit(run, types.NormalizedEvent{Data: &types.WebSearchResultEvent{
							Results: hits,
						}})
					}
				}
			}

		case "content_block_delta":
			if ev.Delta == nil {
				continue
			}
			delta := ev.Delta

			if delta.Type == "text_delta" && delta.Text != "" {
				if currentBlockIndex < len(assistantBlocks) {
					assistantBlocks[currentBlockIndex].Text += delta.Text
				}
				b.emit(run, types.NormalizedEvent{Data: &types.TextChunkEvent{
					Text: delta.Text,
				}})
			}

			if delta.Type == "input_json_delta" && delta.PartialJSON != "" {
				currentPartialJSON.WriteString(delta.PartialJSON)
				if currentBlockIndex < len(assistantBlocks) {
					toolID := assistantBlocks[currentBlockIndex].ID
					b.emit(run, types.NormalizedEvent{Data: &types.ToolCallUpdateEvent{
						ToolID:       toolID,
						PartialInput: delta.PartialJSON,
					}})
				}
			}

			// Extended-thinking deltas (issue #158).
			//
			// thinking_delta carries readable reasoning text. We accumulate it
			// into the block's Thinking field (so the persistence layer can
			// retain it when persistThinking is on — Phase 2 gates retention)
			// and emit ThinkingDeltaEvent gated by ThinkingConfig.StreamDeltas
			// (default on). Boundaries always emit regardless of the gate.
			//
			// signature_delta carries Anthropic's opaque per-block signature.
			// It is NOT display text: we append it to the block for history /
			// round-trip fidelity but never surface it as a ThinkingDeltaEvent.
			if delta.Type == "thinking_delta" && delta.Thinking != "" {
				if currentBlockIndex < len(assistantBlocks) {
					assistantBlocks[currentBlockIndex].Thinking += delta.Thinking
				}
				thinkingTextLen += len(delta.Thinking)
				if streamThinkingDeltas(run) {
					b.emit(run, types.NormalizedEvent{Data: &types.ThinkingDeltaEvent{
						Text: delta.Thinking,
					}})
				} else {
					utils.Debug("ApiBackend", fmt.Sprintf(
						"thinking delta suppressed (streamDeltas off): len=%d runID=%s",
						len(delta.Thinking), run.requestID))
				}
			}

			if delta.Type == "signature_delta" {
				// Signature is not display text. Persist for fidelity; never
				// emit. (LlmStreamDelta carries the signature in a field the
				// engine does not currently model separately; the block's
				// thinking signature is reconstructed by the provider layer on
				// re-submission, which is moot here because sanitize strips
				// thinking before submission.)
				utils.Debug("ApiBackend", fmt.Sprintf(
					"signature_delta received (not emitted as display text) runID=%s", run.requestID))
			}

		case "content_block_stop":
			// Extended-thinking block end (issue #158). Fires when the block
			// that just closed was a thinking / redacted_thinking block. Emit
			// ThinkingBlockEndEvent with the elapsed time and an estimated
			// token count (chars/4 — providers fold thinking into output-token
			// usage, so no authoritative per-block count exists). Accumulate
			// the estimate onto the run for DispatchAgentResult.ThinkingTokens.
			if thinkingActive {
				elapsed := time.Since(thinkingStartedAt).Seconds()
				// chars/4 is the standard rough token estimate; redacted blocks
				// carry no readable text so their estimate is 0.
				estTokens := 0
				if !thinkingRedacted {
					estTokens = thinkingTextLen / 4
				}
				run.thinkingTokens.Add(int64(estTokens))
				utils.Debug("ApiBackend", fmt.Sprintf(
					"thinking block end: redacted=%t estTokens=%d elapsed=%.2fs runID=%s",
					thinkingRedacted, estTokens, elapsed, run.requestID))
				b.emit(run, types.NormalizedEvent{Data: &types.ThinkingBlockEndEvent{
					TotalTokens:    estTokens,
					ElapsedSeconds: elapsed,
					Redacted:       thinkingRedacted,
				}})
				thinkingActive = false
				thinkingRedacted = false
				thinkingTextLen = 0
				// A thinking block never carries tool input and is not a
				// tool_use, so fall through is unnecessary — but the
				// ToolCallCompleteEvent below is harmless (it carries only the
				// block index). We continue to emit it for index symmetry with
				// every other content_block_stop, matching prior behavior.
			}

			// Parse accumulated tool input JSON (client or server tool).
			// On parse failure we coerce to an empty map and warn — the API
			// rejects messages whose tool_use.input is not a JSON object,
			// which would otherwise poison the conversation history forever.
			if currentBlockIndex < len(assistantBlocks) {
				block := &assistantBlocks[currentBlockIndex]
				if block.Type == "tool_use" || block.Type == "server_tool_use" {
					raw := currentPartialJSON.String()
					if raw == "" {
						// Defect-1 guard: a duplicate content_block_stop for the
						// same block (e.g. OpenRouter emitting a trailing
						// finish_reason chunk after the tool-call turn) arrives
						// with an empty accumulator because the first stop already
						// parsed and reset it. Only default to {} when the input
						// has not already been set — never clobber a parsed input.
						if block.Input == nil {
							utils.Debug("ApiBackend", fmt.Sprintf("content_block_stop: empty accumulator, defaulting input to {} (toolID=%s name=%s idx=%d)", block.ID, block.Name, currentBlockIndex))
							block.Input = map[string]any{}
						} else {
							utils.Debug("ApiBackend", fmt.Sprintf("content_block_stop: empty accumulator but input already set, preserving (toolID=%s name=%s idx=%d)", block.ID, block.Name, currentBlockIndex))
						}
					} else {
						var input map[string]any
						if err := json.Unmarshal([]byte(raw), &input); err == nil {
							block.Input = input
						} else {
							preview := raw
							if len(preview) > 500 {
								preview = preview[:500] + "...(truncated)"
							}
							utils.Warn("ApiBackend", fmt.Sprintf("tool_use input parse failed (toolID=%s name=%s err=%v) coercing to {}: %s", block.ID, block.Name, err, preview))
							block.Input = map[string]any{}
						}
					}
					currentPartialJSON.Reset()
				}
			}

			b.emit(run, types.NormalizedEvent{Data: &types.ToolCallCompleteEvent{
				Index: currentBlockIndex,
			}})

		case "message_delta":
			if ev.Delta != nil && ev.Delta.StopReason != nil {
				stopReason = *ev.Delta.StopReason
			}
			if ev.DeltaUsage != nil {
				// Accumulate final usage
				cumUsage.OutputTokens += ev.DeltaUsage.OutputTokens
			}
		}
	}

	// Check for stream error
	var streamErr error
	if errc != nil {
		streamErr = <-errc
	}

	return assistantBlocks, stopReason, &cumUsage, streamErr
}

// streamThinkingDeltas reports whether per-token engine_thinking_delta events
// should be emitted for this run. Default ON (issue #158): the run streams
// reasoning text unless a consumer explicitly opted out via
// ThinkingConfig.StreamDeltas=false. Block-boundary events
// (ThinkingBlockStartEvent / ThinkingBlockEndEvent) are never gated by this —
// they always emit when a reasoning block is present, so the liveness signal
// and block summary survive even when delta streaming is disabled.
//
// Resolution: read the per-run RunOptions.Thinking (run.opts.Thinking). A nil
// ThinkingConfig or a nil StreamDeltas pointer both resolve to ON. Only an
// explicit &false suppresses the deltas.
func streamThinkingDeltas(run *activeRun) bool {
	if run == nil || run.opts == nil {
		return true
	}
	return thinkingStreamDeltasEnabled(run.opts.Thinking)
}

// thinkingStreamDeltasEnabled resolves ThinkingConfig.StreamDeltas with the
// default-ON pointer-bool semantics. Exposed (lowercase, package-scoped) so the
// config-carry test can assert the resolution directly. nil config ⇒ on; nil
// pointer ⇒ on; explicit value ⇒ that value.
func thinkingStreamDeltasEnabled(cfg *types.ThinkingConfig) bool {
	if cfg == nil || cfg.StreamDeltas == nil {
		return true
	}
	return *cfg.StreamDeltas
}

// thinkingPersistEnabled resolves ThinkingConfig.Persist with the default-ON
// pointer-bool semantics. When on, the engine retains reasoning TEXT in
// conversation history; when off, the persisted thinking block carries no text
// (bare {"type":"thinking"}). This NEVER affects provider re-submission —
// SanitizeMessages strips thinking on the submission path regardless. nil
// config ⇒ on; nil pointer ⇒ on; explicit value ⇒ that value.
func thinkingPersistEnabled(cfg *types.ThinkingConfig) bool {
	if cfg == nil || cfg.Persist == nil {
		return true
	}
	return *cfg.Persist
}

// blocksForPersistence applies the persist-thinking gate (issue #158) to the
// assistant blocks about to enter conversation history. When persistThinking is
// on (default), the blocks pass through unchanged and the reasoning text is
// retained for display ("show thinking" on historical turns). When off, the
// reasoning TEXT is stripped (bare {"type":"thinking"} retained), matching the
// pre-#158 shape. This is a persistence-only choice — the provider-submission
// path always strips thinking entirely via SanitizeMessages, so persisted text
// never reaches the model regardless of this gate.
func (b *ApiBackend) blocksForPersistence(run *activeRun, blocks []types.LlmContentBlock) []types.LlmContentBlock {
	var cfg *types.ThinkingConfig
	if run != nil && run.opts != nil {
		cfg = run.opts.Thinking
	}
	if thinkingPersistEnabled(cfg) {
		return blocks
	}
	runID := ""
	if run != nil {
		runID = run.requestID
	}
	utils.Debug("ApiBackend", fmt.Sprintf(
		"persistThinking off: stripping reasoning text from assistant blocks runID=%s", runID))
	return stripThinkingText(blocks)
}

// stripThinkingText returns a copy of blocks with the reasoning TEXT removed
// from every thinking block (the Thinking field zeroed) while keeping the block
// itself. Used when persistThinking is off: history retains a bare
// {"type":"thinking"} block (pre-#158 shape) without the reasoning prose. Does
// not mutate the input slice — the live assistantBlocks must keep their text so
// any in-flight consumer reading them is unaffected.
func stripThinkingText(blocks []types.LlmContentBlock) []types.LlmContentBlock {
	out := make([]types.LlmContentBlock, len(blocks))
	copy(out, blocks)
	for i := range out {
		if out[i].Type == "thinking" || out[i].Type == "redacted_thinking" {
			out[i].Thinking = ""
		}
	}
	return out
}
