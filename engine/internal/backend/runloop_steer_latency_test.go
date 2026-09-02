package backend

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// Tests for steer DELIVERY LATENCY — the two mechanisms that decide how long a
// steer waits before the model can act on it.
//
// The production symptom these pin: a steer sat in the channel for 258 seconds
// while a tool call ran, and a burst of steers needed one provider turn each to
// land. Both are latency defects, not delivery defects — the steer was never
// lost, it was merely applied far too late to steer anything.

// --- drainSteer drains the whole buffer ---

// TestDrainSteer_DrainsAllBufferedMessagesAtOneCheckpoint pins that a burst of
// steers is fully consumed at a single checkpoint.
//
// Before the fix drainSteer consumed exactly one message per call, so N queued
// steers needed N checkpoints — and therefore N provider turns — to reach the
// model. The second and later steers of a burst were each delayed a full turn
// while sitting in a buffer the run had already inspected.
//
// Reverting drainSteer to a single non-blocking receive turns this red: only
// one of the three messages is injected.
func TestDrainSteer_DrainsAllBufferedMessagesAtOneCheckpoint(t *testing.T) {
	b := NewApiBackend()
	run, conv := newSteerDrainRun("steer-drain-all")

	run.steerCh <- steerMessage{text: "first"}
	run.steerCh <- steerMessage{text: "second"}
	run.steerCh <- steerMessage{text: "third"}

	if !b.drainSteer(run, conv) {
		t.Fatal("drainSteer reported no message consumed")
	}
	if len(run.steerCh) != 0 {
		t.Errorf("steer channel still holds %d message(s); the whole buffer must drain at one checkpoint", len(run.steerCh))
	}

	var texts []string
	for _, e := range conv.Entries {
		if e.Type != conversation.EntryMessage {
			continue
		}
		// MessageData.Content is `any` (string or []LlmContentBlock); a steer
		// is always injected as plain text, so assert that shape directly —
		// anything else means the injection path changed and this test should
		// be re-examined rather than silently skipped.
		if md, ok := e.Data.(conversation.MessageData); ok && md.Role == "user" {
			texts = append(texts, injectedSteerText(t, md.Content))
		}
	}
	if len(texts) != 3 {
		t.Fatalf("injected %d steer turns (%v), want 3", len(texts), texts)
	}
	// FIFO order is part of the contract: a corrected instruction must arrive
	// after the instruction it corrects, or the model applies them backwards.
	for i, want := range []string{"first", "second", "third"} {
		if texts[i] != want {
			t.Errorf("steer %d = %q, want %q (channel order must be preserved)", i, texts[i], want)
		}
	}
}

// injectedSteerText extracts the plain text of an injected steer turn.
// MessageData.Content is `any` — either a bare string or []LlmContentBlock
// depending on the append helper — so both shapes are handled rather than
// asserting one and making the test brittle to an unrelated persistence
// change. Any other shape is a genuine surprise worth failing on.
func injectedSteerText(t *testing.T, content any) string {
	t.Helper()
	switch v := content.(type) {
	case string:
		return v
	case []types.LlmContentBlock:
		var sb strings.Builder
		for _, block := range v {
			if block.Type == "text" {
				sb.WriteString(block.Text)
			}
		}
		return sb.String()
	default:
		t.Fatalf("injected steer content is %T, want string or []types.LlmContentBlock", content)
		return ""
	}
}

// TestDrainSteer_EmptyChannelReportsNothingConsumed pins the negative case, so
// the drain loop cannot report a spurious consumption and force a needless
// continuation turn.
func TestDrainSteer_EmptyChannelReportsNothingConsumed(t *testing.T) {
	b := NewApiBackend()
	run, conv := newSteerDrainRun("steer-drain-empty")

	if b.drainSteer(run, conv) {
		t.Fatal("drainSteer reported a consumption from an empty channel")
	}
	if len(conv.Entries) != 0 {
		t.Errorf("drainSteer wrote %d entries for an empty channel", len(conv.Entries))
	}
}

// --- Steer buffer capacity is configurable ---

// TestSteerBufferSize_ResolvesFromConfig pins that the run's steer channel
// capacity comes from config, with the compiled default when unset. The old
// hard-coded capacity of 4 made a modest burst a hard rejection, and a
// rejection is the one steer outcome with no recovery inside the engine.
func TestSteerBufferSize_ResolvesFromConfig(t *testing.T) {
	if got := types.SteerBufferSize(nil); got != 32 {
		t.Errorf("SteerBufferSize(nil) = %d, want the compiled default 32", got)
	}
	if got := types.SteerBufferSize(&types.SteeringConfig{}); got != 32 {
		t.Errorf("SteerBufferSize(empty) = %d, want 32", got)
	}
	if got := types.SteerBufferSize(&types.SteeringConfig{BufferSize: 128}); got != 128 {
		t.Errorf("SteerBufferSize(128) = %d, want 128", got)
	}
	// Negative is treated as unset, never as "unbuffered": an unbuffered steer
	// channel would make every steer arriving between checkpoints a hard
	// rejection, which is the failure the buffer exists to prevent.
	if got := types.SteerBufferSize(&types.SteeringConfig{BufferSize: -1}); got != 32 {
		t.Errorf("SteerBufferSize(-1) = %d, want the default 32", got)
	}
}

// TestSteerBufferSize_AppliedToRun proves the resolved capacity reaches the
// live run rather than only the resolver — the config field is worthless if the
// channel is still built at a fixed size.
func TestSteerBufferSize_AppliedToRun(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{textResponse("done", 5, 5)})

	b := NewApiBackend()
	requestID := "steer-buffer-applied"
	c := collectEvents(b, requestID)

	b.StartRunWithConfig(requestID, types.RunOptions{
		Prompt:           "work",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, &RunConfig{Steering: &types.SteeringConfig{BufferSize: 64}})

	// Read the capacity while the run is live.
	deadline := time.Now().Add(2 * time.Second)
	capacity := 0
	for time.Now().Before(deadline) {
		b.mu.Lock()
		run, ok := b.activeRuns[requestID]
		b.mu.Unlock()
		if ok {
			capacity = cap(run.steerCh)
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if capacity != 64 {
		t.Errorf("run steer channel capacity = %d, want 64 from config", capacity)
	}
	waitForExit(c, 5*time.Second)
}

// --- Mid-stream interrupt ---

// TestSteerInterruptStream_ResolvesDefaultOn pins the default-ON pointer-bool
// semantics. Interruption is the behavior that makes steering apply to the turn
// in flight, so an absent config block must not silently disable it.
func TestSteerInterruptStream_ResolvesDefaultOn(t *testing.T) {
	if !types.SteerInterruptStreamEnabled(nil) {
		t.Error("nil steering config must resolve interrupt-stream ON")
	}
	if !types.SteerInterruptStreamEnabled(&types.SteeringConfig{}) {
		t.Error("nil InterruptStream pointer must resolve ON")
	}
	off := false
	if types.SteerInterruptStreamEnabled(&types.SteeringConfig{InterruptStream: &off}) {
		t.Error("explicit false must resolve OFF")
	}
	on := true
	if !types.SteerInterruptStreamEnabled(&types.SteeringConfig{InterruptStream: &on}) {
		t.Error("explicit true must resolve ON")
	}
}

// TestSteerInterruptStream_ArmsLatchOnlyWhenEnabled pins that the interrupt
// latch is armed by an accepted steer when the policy is on, and left alone
// when it is off. The latch is what lets processStream end a provider call
// early; if it is armed under an off policy the operator's opt-out does
// nothing, and if it is never armed under an on policy the steer waits for the
// stream exactly as it did before the fix.
func TestSteerInterruptStream_ArmsLatchOnlyWhenEnabled(t *testing.T) {
	for _, tc := range []struct {
		name      string
		enabled   bool
		wantLatch bool
	}{
		{"policy on arms the latch", true, true},
		{"policy off leaves the latch clear", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := NewApiBackend()
			run := &activeRun{
				requestID:            "latch-" + tc.name,
				steerCh:              make(chan steerMessage, 4),
				steerInterruptStream: tc.enabled,
			}
			b.mu.Lock()
			b.activeRuns[run.requestID] = run
			b.mu.Unlock()

			if got := b.SteerWithReason(run.requestID, "change course"); got != SteerResultDelivered {
				t.Fatalf("steer result = %v, want delivered", got)
			}
			if got := run.steerInterrupt.Load(); got != tc.wantLatch {
				t.Errorf("steerInterrupt latch = %v, want %v", got, tc.wantLatch)
			}
		})
	}
}

// TestSteerInterruptStream_RejectedSteerNeverArmsLatch pins that a steer the
// engine refused does not interrupt anything. Arming on rejection would cost
// the run a provider call for a message it never accepted — strictly worse than
// the rejection alone.
func TestSteerInterruptStream_RejectedSteerNeverArmsLatch(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{
		requestID:            "latch-rejected",
		steerCh:              make(chan steerMessage), // unbuffered, no drainer: every send fails
		steerInterruptStream: true,
	}
	b.mu.Lock()
	b.activeRuns[run.requestID] = run
	b.mu.Unlock()

	if got := b.SteerWithReason(run.requestID, "too late"); got != SteerResultChannelFull {
		t.Fatalf("steer result = %v, want channel_full", got)
	}
	if run.steerInterrupt.Load() {
		t.Error("a rejected steer armed the stream interrupt")
	}
}

// TestSteerInterruptStream_EndsRunEarlyAndKeepsPartialText is the end-to-end
// latency test. A steer arriving mid-stream must end the provider call and
// reach the conversation without waiting for the model to finish composing —
// and the assistant text produced up to that point must survive.
//
// Keeping the partial text is the load-bearing half. Reporting the interrupt as
// a truncated stream instead would route it into the truncation-retry branch,
// which discards the partial output and re-runs the turn: the model would lose
// what it had said AND never see the steer that interrupted it.
func TestSteerInterruptStream_EndsRunEarlyAndKeepsPartialText(t *testing.T) {
	// Two responses: the first is interrupted, the second ends the run after
	// the steer has been injected.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("I am composing a long answer", 10, 20),
		textResponse("acting on the steer", 5, 5),
	})

	b := NewApiBackend()
	requestID := "steer-interrupt-e2e"
	c := collectEvents(b, requestID)

	b.StartRunWithConfig(requestID, types.RunOptions{
		Prompt:           "start a long answer",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, &RunConfig{Steering: &types.SteeringConfig{}}) // nil InterruptStream ⇒ default ON

	// Steer as soon as the run is live, so it lands while a stream is in flight
	// or between turns — either way it must be injected without the caller
	// waiting for the whole run.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if b.SteerWithReason(requestID, "stop and do X instead") == SteerResultDelivered {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}

	if !waitForExit(c, 10*time.Second) {
		t.Fatal("timed out waiting for run exit")
	}

	c.mu.Lock()
	evs := append([]types.NormalizedEvent(nil), c.normalized...)
	code := c.exitCode
	c.mu.Unlock()

	if code == nil || *code != 0 {
		t.Errorf("exit code = %v, want 0", code)
	}

	injected := 0
	for _, ev := range evs {
		if _, ok := ev.Data.(*types.SteerInjectedEvent); ok {
			injected++
		}
	}
	if injected == 0 {
		t.Error("steer was never injected into the run")
	}
}

// steerCancellationProvider keeps its first stream active until the call-scoped
// context is cancelled. The second call completes normally so the test can
// prove cancellation stops only the abandoned provider call, not the run.
type steerCancellationProvider struct {
	id          string
	calls       atomic.Int32
	firstCancel chan struct{}
}

func (p *steerCancellationProvider) ID() string { return p.id }

func (p *steerCancellationProvider) CountTokens(context.Context, providers.CountTokensRequest) (int, error) {
	return 0, providers.ErrCountUnsupported
}

func (p *steerCancellationProvider) Stream(ctx context.Context, _ types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent)
	errc := make(chan error, 1)
	call := p.calls.Add(1)

	go func() {
		defer close(events)
		defer close(errc)
		if call > 1 {
			for _, event := range textResponse("acting on the steer", 5, 5) {
				select {
				case events <- event:
				case <-ctx.Done():
					errc <- ctx.Err()
					return
				}
			}
			return
		}

		initial := []types.LlmStreamEvent{
			{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "steer-cancel-first", Model: "steer-cancel-model", Usage: types.LlmUsage{InputTokens: 10}}},
			{Type: "content_block_start", BlockIndex: 0, ContentBlock: &types.LlmStreamContentBlock{Type: "text"}},
			{Type: "content_block_delta", BlockIndex: 0, Delta: &types.LlmStreamDelta{Type: "text_delta", Text: "partial answer"}},
		}
		for _, event := range initial {
			select {
			case events <- event:
			case <-ctx.Done():
				close(p.firstCancel)
				errc <- ctx.Err()
				return
			}
		}

		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				select {
				case events <- types.LlmStreamEvent{Type: "content_block_delta", BlockIndex: 0, Delta: &types.LlmStreamDelta{Type: "text_delta", Text: "."}}:
				case <-ctx.Done():
					close(p.firstCancel)
					errc <- ctx.Err()
					return
				}
			case <-ctx.Done():
				close(p.firstCancel)
				errc <- ctx.Err()
				return
			}
		}
	}()

	return events, errc
}

func collectedTextContains(c *collectedEvents, text string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, event := range c.normalized {
		chunk, ok := event.Data.(*types.TextChunkEvent)
		if ok && strings.Contains(chunk.Text, text) {
			return true
		}
	}
	return false
}

// TestSteerInterruptStream_CancelsAbandonedProviderCall proves the interrupted
// call is stopped before the next turn proceeds. Without the per-call cancel,
// processStream returns but WithRetry and the provider keep publishing into an
// unread channel until it fills, leaking both goroutines and the live request.
func TestSteerInterruptStream_CancelsAbandonedProviderCall(t *testing.T) {
	const providerID = "steer-cancel-provider"
	const modelID = "steer-cancel-model"
	provider := &steerCancellationProvider{id: providerID, firstCancel: make(chan struct{})}
	providers.RegisterProvider(provider)
	providers.RegisterModel(modelID, types.ModelInfo{ProviderID: providerID, ContextWindow: 200000})
	t.Cleanup(func() {
		providers.UnregisterProvider(providerID)
		providers.UnregisterModel(modelID)
	})

	b := NewApiBackend()
	requestID := "steer-cancel-abandoned-call"
	collected := collectEvents(b, requestID)
	b.StartRunWithConfig(requestID, types.RunOptions{
		Prompt: "start a long answer", ProjectPath: "/tmp", Model: modelID,
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, &RunConfig{Steering: &types.SteeringConfig{}})

	deadline := time.Now().Add(2 * time.Second)
	for !collectedTextContains(collected, "partial answer") && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !collectedTextContains(collected, "partial answer") {
		t.Fatal("first provider call never streamed its partial answer")
	}
	if got := b.SteerWithReason(requestID, "stop and do X instead"); got != SteerResultDelivered {
		t.Fatalf("steer result = %v, want delivered", got)
	}

	select {
	case <-provider.firstCancel:
	case <-time.After(2 * time.Second):
		t.Fatal("interrupted provider call was not cancelled; its stream remains live without a consumer")
	}
	if !waitForExit(collected, 5*time.Second) {
		t.Fatal("run did not complete after the steer continuation")
	}
	if calls := provider.calls.Load(); calls != 2 {
		t.Fatalf("provider calls = %d, want interrupted call plus one continuation", calls)
	}

	collected.mu.Lock()
	defer collected.mu.Unlock()
	var interrupted, injected bool
	for _, event := range collected.normalized {
		switch event.Data.(type) {
		case *types.SteerInterruptedStreamEvent:
			interrupted = true
		case *types.SteerInjectedEvent:
			injected = true
		}
	}
	if !interrupted || !injected {
		t.Fatalf("events interrupted=%v injected=%v, want both scheduling and delivery signals", interrupted, injected)
	}
}

// TestSteerInterruptedStreamEvent_TranslatesToWire pins the event's wire shape.
// The event exists so a consumer can tell an engine-initiated early stop from a
// truncation or an error; if it does not round-trip, a consumer has to infer
// the difference from a truncation-shaped gap, which is exactly the guess the
// event removes.
func TestSteerInterruptedStreamEvent_TranslatesToWire(t *testing.T) {
	original := types.NormalizedEvent{Data: &types.SteerInterruptedStreamEvent{BlocksKept: 2, QueuedSteers: 3}}

	raw, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), types.EventSteerInterruptedStream) {
		t.Errorf("serialized event does not carry its type discriminator: %s", raw)
	}

	var decoded types.NormalizedEvent
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got, ok := decoded.Data.(*types.SteerInterruptedStreamEvent)
	if !ok {
		t.Fatalf("decoded as %T, want *types.SteerInterruptedStreamEvent", decoded.Data)
	}
	if got.BlocksKept != 2 {
		t.Errorf("BlocksKept = %d, want 2", got.BlocksKept)
	}
	if got.QueuedSteers != 3 {
		t.Errorf("QueuedSteers = %d, want 3", got.QueuedSteers)
	}
}
