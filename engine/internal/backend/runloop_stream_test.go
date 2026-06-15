package backend

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// streamEventChan turns a fixed slice of stream events into the (events, errc)
// pair processStream expects. errc yields a single nil (clean completion).
func streamEventChan(evs []types.LlmStreamEvent) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, len(evs))
	for _, ev := range evs {
		events <- ev
	}
	close(events)
	errc := make(chan error, 1)
	errc <- nil
	return events, errc
}

// TestProcessStreamDuplicateStopPreservesToolInput pins Defect 1 (layer 1)
// directly at processStream — bypassing the openai provider — so the
// no-clobber guard in the content_block_stop handler is exercised on its own.
//
// The sequence feeds a tool_use block, streams its JSON args, emits a
// content_block_stop (which parses + stores the args), then emits a SECOND
// content_block_stop for the same block with an empty accumulator (the
// duplicate-stop case). The parsed input must survive on the correct block
// index instead of being clobbered to {}.
//
// Reverting the layer-1 guard (`block.Input == nil`) turns this test red;
// the layer-2 provider state-reset is NOT exercised here (it is covered by
// openai_stream_test.go), so this test pins layer 1 independently.
func TestProcessStreamDuplicateStopPreservesToolInput(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "dup-stop"}

	evs := []types.LlmStreamEvent{
		{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m1", Model: "test"}},
		{
			Type:         "content_block_start",
			BlockIndex:   0,
			ContentBlock: &types.LlmStreamContentBlock{Type: "tool_use", ID: "call_1", Name: "WebFetch"},
		},
		{
			Type:       "content_block_delta",
			BlockIndex: 0,
			Delta:      &types.LlmStreamDelta{Type: "input_json_delta", PartialJSON: `{"url":`},
		},
		{
			Type:       "content_block_delta",
			BlockIndex: 0,
			Delta:      &types.LlmStreamDelta{Type: "input_json_delta", PartialJSON: `"https://example.com"}`},
		},
		// First stop: parses + stores the args, resets the accumulator.
		{Type: "content_block_stop", BlockIndex: 0},
		// Duplicate stop for the same block: empty accumulator. Must NOT clobber.
		{Type: "content_block_stop", BlockIndex: 0},
		{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: strPtr("tool_use")}},
	}

	events, errc := streamEventChan(evs)
	blocks, stopReason, _, err := b.processStream(context.Background(), run, events, errc)
	if err != nil {
		t.Fatalf("processStream error: %v", err)
	}
	if stopReason != "tool_use" {
		t.Fatalf("stopReason = %q, want tool_use", stopReason)
	}
	if len(blocks) != 1 {
		t.Fatalf("blocks len = %d, want 1", len(blocks))
	}

	// The parsed input must survive on block index 0.
	input := blocks[0].Input
	if input == nil {
		t.Fatalf("block[0].Input is nil (input was clobbered)")
	}
	if got := input["url"]; got != "https://example.com" {
		t.Fatalf("block[0].Input[url] = %v, want https://example.com (duplicate stop clobbered the parsed args)", got)
	}
}

// TestProcessStreamSingleEmptyStopDefaultsToEmptyMap confirms the guard does
// NOT regress the legitimate empty-args case: a tool_use block with no streamed
// args still gets Input == {} after its (single) stop.
func TestProcessStreamSingleEmptyStopDefaultsToEmptyMap(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "empty-stop"}

	evs := []types.LlmStreamEvent{
		{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m1", Model: "test"}},
		{
			Type:         "content_block_start",
			BlockIndex:   0,
			ContentBlock: &types.LlmStreamContentBlock{Type: "tool_use", ID: "call_1", Name: "TaskList"},
		},
		{Type: "content_block_stop", BlockIndex: 0},
		{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: strPtr("tool_use")}},
	}

	events, errc := streamEventChan(evs)
	blocks, _, _, err := b.processStream(context.Background(), run, events, errc)
	if err != nil {
		t.Fatalf("processStream error: %v", err)
	}
	if len(blocks) != 1 {
		t.Fatalf("blocks len = %d, want 1", len(blocks))
	}
	input := blocks[0].Input
	if input == nil {
		t.Fatalf("block[0].Input is nil, want empty map")
	}
	if len(input) != 0 {
		t.Fatalf("block[0].Input = %v, want empty map", input)
	}
}
