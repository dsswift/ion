package backend

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// Shared test provider/model IDs for the watchdog suite. Distinct from
// the existing testBackendProvider so registering watchdog providers
// doesn't clobber the standard backend test setup.
const (
	watchdogTestProviderID = "watchdog-test-provider"
	watchdogTestModel      = "watchdog-test-model"
)

// registerWatchdogTestProvider wires a freshly-constructed provider into
// the global providers registry under the watchdog test IDs. Tests share
// the same model ID; each test registers its own provider implementation
// (wedge vs. drip) right before StartRunWithConfig.
func registerWatchdogTestProvider(t *testing.T, p providers.LlmProvider) {
	t.Helper()
	providers.RegisterProvider(p)
	providers.RegisterModel(watchdogTestModel, types.ModelInfo{
		ProviderID:      watchdogTestProviderID,
		ContextWindow:   200000,
		CostPer1kInput:  0.003,
		CostPer1kOutput: 0.015,
	})
}

// withFastWatchdogTick temporarily lowers the watchdog tick rate so tests
// can observe stall detection in milliseconds rather than 30s. Restored
// via t.Cleanup so any subsequent test sees the production default.
// The store is atomic so an in-flight watchdog goroutine from a prior
// test cannot race with the override; the goroutine reads the atomic
// each iteration via runProgressWatchdogTick(), and the channel-based
// stop signal in removeRun ensures lingering watchdogs terminate
// before the next test starts touching the var.
func withFastWatchdogTick(t *testing.T, tick time.Duration) {
	t.Helper()
	prev := runProgressWatchdogTickNanos.Load()
	runProgressWatchdogTickNanos.Store(int64(tick))
	t.Cleanup(func() {
		runProgressWatchdogTickNanos.Store(prev)
	})
}

// wedgeProvider blocks indefinitely on Stream so the runloop has no way
// to make progress through normal channels. Cancellation propagates via
// ctx, mirroring real provider behavior — the test asserts that the
// watchdog reaches into ctx via run.cancel() when the threshold elapses.
type wedgeProvider struct {
	id          string
	streamCalls atomic.Int64
}

func (w *wedgeProvider) ID() string { return w.id }

func (w *wedgeProvider) Stream(ctx context.Context, _ types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	w.streamCalls.Add(1)
	events := make(chan types.LlmStreamEvent)
	errc := make(chan error, 1)
	go func() {
		defer close(events)
		defer close(errc)
		<-ctx.Done()
		errc <- ctx.Err()
	}()
	return events, errc
}

// TestRunloopWatchdogCancelsStalledRun is the regression test for the
// silent-wedge defect documented in the dispatch-stall plan. A provider
// that blocks forever inside Stream() reproduces the observable symptom
// from conversation 1780874102870-12aee36b1e8d: the runloop has issued
// the outbound request but the response (or its post-processing) never
// returns, so emit() is never called and lastProgressAt does not move.
//
// The watchdog must observe the idle window, emit RunStalledEvent +
// engine_error{run_stalled} for consumers, cancel the run's context,
// and let the existing ctx-cancelled branch of runLoop produce the
// terminal exit signal. Without this watchdog the run sits invisibly
// until the engine process restarts — which is exactly what happened
// in the original incident.
func TestRunloopWatchdogCancelsStalledRun(t *testing.T) {
	withFastWatchdogTick(t, 20*time.Millisecond)

	provider := &wedgeProvider{id: watchdogTestProviderID}
	registerWatchdogTestProvider(t, provider)

	b := NewApiBackend()
	const requestID = "req-watchdog-stall"
	c := collectEvents(b, requestID)

	cfg := &RunConfig{
		Timeouts: &types.TimeoutsConfig{
			RunStallMs: 100, // 100ms threshold so we can see it fire in well under 1s
		},
	}
	b.StartRunWithConfig(requestID, types.RunOptions{
		Prompt: "hello",
		Model:  watchdogTestModel,
	}, cfg)

	if !waitForExit(c, 2*time.Second) {
		t.Fatal("watchdog did not trigger exit within 2s — stall detection regressed")
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// Assertion 1: at least one provider Stream call occurred (the
	// runloop actually started before stalling — not a "the watchdog
	// fired on a not-yet-started run" false positive).
	if got := provider.streamCalls.Load(); got == 0 {
		t.Errorf("expected provider.Stream() to be called at least once, got %d", got)
	}

	// Assertion 2: a RunStalledEvent was emitted before the run exited.
	var sawRunStalled bool
	var sawRunStalledErrorCode bool
	for _, ev := range c.normalized {
		switch d := ev.Data.(type) {
		case *types.RunStalledEvent:
			sawRunStalled = true
			if d.StalledDuration <= 0 {
				t.Errorf("RunStalledEvent.StalledDuration must be positive, got %f", d.StalledDuration)
			}
		case *types.ErrorEvent:
			if d.ErrorCode == "run_stalled" {
				sawRunStalledErrorCode = true
			}
		}
	}
	if !sawRunStalled {
		t.Error("expected RunStalledEvent to be emitted before exit")
	}
	if !sawRunStalledErrorCode {
		t.Error("expected ErrorEvent with ErrorCode=run_stalled (for headless consumers that don't subscribe to RunStalledEvent)")
	}

	// Assertion 3: the run is no longer in activeRuns (deferred removeRun
	// fired after ctx cancellation unwound runLoop).
	b.mu.Lock()
	_, stillActive := b.activeRuns[requestID]
	b.mu.Unlock()
	if stillActive {
		t.Error("expected run to be removed from activeRuns after watchdog cancellation")
	}
}

// TestRunloopWatchdogResetsOnProgress locks in the negative case: a
// run that legitimately makes incremental progress must NOT trip the
// watchdog. Every emit() bumps lastProgressAt, so a provider that
// streams chunks faster than the threshold should reach end_turn
// cleanly even when the threshold is tight.
//
// This pins the design choice that emit() is the canonical progress
// signal. If a future refactor moves a progress source out of emit()
// (or stops calling emit() in some path), this test should catch it.
func TestRunloopWatchdogResetsOnProgress(t *testing.T) {
	// Tick fast (20ms) so we get many checks during the run, but pick
	// a threshold (600ms) comfortably larger than the drip interval
	// (50ms) so the test is robust against scheduler jitter and the
	// post-stream conversation.Save() call. The point of this test is
	// that a *continuously progressing* run does not trip the
	// watchdog — not that the threshold is tight to the drip cadence.
	withFastWatchdogTick(t, 20*time.Millisecond)

	provider := newProgressDripProvider(watchdogTestProviderID)
	registerWatchdogTestProvider(t, provider)

	b := NewApiBackend()
	const requestID = "req-watchdog-progress"
	c := collectEvents(b, requestID)

	cfg := &RunConfig{
		Timeouts: &types.TimeoutsConfig{
			RunStallMs: 600,
		},
	}
	b.StartRunWithConfig(requestID, types.RunOptions{
		Prompt: "hello",
		Model:  watchdogTestModel,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("run did not complete within 5s")
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	for _, ev := range c.normalized {
		if _, ok := ev.Data.(*types.RunStalledEvent); ok {
			t.Fatal("RunStalledEvent fired during a run that should have made continuous progress — watchdog reset on emit() is broken")
		}
		if e, ok := ev.Data.(*types.ErrorEvent); ok && e.ErrorCode == "run_stalled" {
			t.Fatal("engine_error{run_stalled} fired during a run that should have made continuous progress")
		}
	}

	if c.exitCode == nil {
		t.Fatal("expected an exit code from a normal completion")
	}
	if *c.exitCode != 0 {
		t.Errorf("expected exit code 0 for normal completion, got %d", *c.exitCode)
	}
}

// progressDripProvider streams content_block_delta chunks at a fixed
// cadence then ends with end_turn. Each chunk reaches the runloop and
// flows through emit(), bumping the watchdog clock. Used by
// TestRunloopWatchdogResetsOnProgress.
type progressDripProvider struct {
	id    string
	mu    sync.Mutex
	calls int
}

func newProgressDripProvider(id string) *progressDripProvider {
	return &progressDripProvider{id: id}
}

func (p *progressDripProvider) ID() string { return p.id }

func (p *progressDripProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	p.mu.Lock()
	p.calls++
	p.mu.Unlock()

	events := make(chan types.LlmStreamEvent, 16)
	errc := make(chan error, 1)
	go func() {
		defer close(events)
		defer close(errc)

		// message_start
		events <- types.LlmStreamEvent{
			Type: "message_start",
			MessageInfo: &types.LlmStreamMessageInfo{
				ID: "msg_progress", Model: opts.Model,
				Usage: types.LlmUsage{InputTokens: 5},
			},
		}
		events <- types.LlmStreamEvent{
			Type:         "content_block_start",
			BlockIndex:   0,
			ContentBlock: &types.LlmStreamContentBlock{Type: "text", Text: ""},
		}

		// Drip 4 chunks at 50ms each — well under the 200ms threshold.
		for i := range 4 {
			select {
			case <-ctx.Done():
				errc <- ctx.Err()
				return
			case <-time.After(50 * time.Millisecond):
			}
			_ = i
			events <- types.LlmStreamEvent{
				Type:       "content_block_delta",
				BlockIndex: 0,
				Delta: &types.LlmStreamDelta{
					Type: "text_delta",
					Text: "tick ",
				},
			}
		}

		events <- types.LlmStreamEvent{Type: "content_block_stop", BlockIndex: 0}
		stopReason := "end_turn"
		events <- types.LlmStreamEvent{
			Type: "message_delta",
			Delta: &types.LlmStreamDelta{
				Type:       "message_delta",
				StopReason: &stopReason,
			},
			DeltaUsage: &types.LlmUsage{OutputTokens: 8},
		}
		events <- types.LlmStreamEvent{Type: "message_stop"}
	}()
	return events, errc
}
