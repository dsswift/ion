package backend

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/tools"
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

func (w *wedgeProvider) CountTokens(_ context.Context, _ providers.CountTokensRequest) (int, error) {
	return 0, providers.ErrCountUnsupported
}

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
			// 500ms threshold. This must be comfortably larger than the
			// time it takes the run goroutine to start and reach
			// provider.Stream() — on a CPU-pressured CI runner under the
			// race detector, goroutine startup can be starved for far
			// longer than the 100ms this test originally used, so the
			// watchdog could declare a stall before Stream() was ever
			// called (streamCalls==0) and Assertion 1 flaked. The sibling
			// TestRunloopWatchdogResetsOnProgress uses 600ms for the same
			// reason. The fast 20ms tick keeps the test quick once the
			// threshold is crossed.
			RunStallMs: 500,
		},
	}
	b.StartRunWithConfig(requestID, types.RunOptions{
		Prompt: "hello",
		Model:  watchdogTestModel,
	}, cfg)

	// Deterministically confirm the run actually started — wait until the
	// wedge provider's Stream() has been entered before relying on the
	// watchdog. This removes the race between run-goroutine startup and the
	// watchdog timer that previously made Assertion 1 flaky: we only proceed
	// to assert stall-detection once we KNOW the run reached the provider.
	streamStarted := false
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
		if provider.streamCalls.Load() > 0 {
			streamStarted = true
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !streamStarted {
		t.Fatal("run goroutine never reached provider.Stream() within 2s — runloop startup regressed")
	}

	if !waitForExit(c, 2*time.Second) {
		t.Fatal("watchdog did not trigger exit within 2s — stall detection regressed")
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// Assertion 1: at least one provider Stream call occurred (the
	// runloop actually started before stalling — not a "the watchdog
	// fired on a not-yet-started run" false positive). Guaranteed by the
	// streamStarted wait above; re-checked here for clarity.
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
	// fired after ctx cancellation unwound runLoop). Waited rather than
	// sampled — the defer runs after the OnExit callback that released
	// waitForExit. See waitForRunRemoved.
	if !waitForRunRemoved(b, requestID, 5*time.Second) {
		t.Error("expected run to be removed from activeRuns after watchdog cancellation")
	}
}

// TestRunStallFiresDespiteToolStallEmits is the regression test for the
// conversation 1782012033034-37d617d3d9ab incident: a wedged, deadline-exempt
// Agent/dispatch tool emitted a ToolStalledEvent every stall interval, each
// emit reset the run-progress clock, and the run-stall watchdog never fired —
// so the run hung for ~10 minutes until the engine restarted.
//
// The fix routes ToolStalledEvent through emitWithoutProgress, so the stall
// advisory no longer counts as forward progress. This test pins that: a tool
// that wedges forever, runs longer than both the tool-stall interval AND the
// run-stall threshold, must still trip the run-stall watchdog. The tool is
// named tools.AgentToolName so the runloop's per-tool-deadline exemption is in
// force (otherwise the per-tool deadline, not the watchdog, would end the run
// and the test would not pin the right mechanism).
//
// On the UNFIXED code this test fails: the periodic ToolStalledEvent emits keep
// lastProgressAt fresh, the watchdog never observes RunStall idleness, and
// waitForExit times out.
func TestRunStallFiresDespiteToolStallEmits(t *testing.T) {
	withFastWatchdogTick(t, 20*time.Millisecond)

	// A tool that wedges until ctx cancellation. Named "Agent" so the runloop
	// takes the deadline-exempt branch (no per-tool DeadlineSuspender). It
	// honors ctx so the watchdog's run.cancel() unblocks it cleanly.
	//
	// toolEntered closes as soon as Execute is reached, which is what makes the
	// timing assertions below deterministic (see the wait after
	// StartRunWithConfig).
	toolEntered := make(chan struct{})
	var toolEnterOnce sync.Once
	tools.RegisterTool(&types.ToolDef{
		Name:        tools.AgentToolName,
		Description: "wedges forever (test)",
		InputSchema: map[string]any{"type": "object"},
		Execute: func(ctx context.Context, _ map[string]any, _ string) (*types.ToolResult, error) {
			toolEnterOnce.Do(func() { close(toolEntered) })
			<-ctx.Done()
			return &types.ToolResult{Content: "cancelled", IsError: true}, ctx.Err()
		},
	})

	// Provider calls the wedging Agent tool, then (never reached) end_turn.
	mock := &mockLlmProvider{
		id: watchdogTestProviderID,
		responses: [][]types.LlmStreamEvent{
			toolUseResponse(tools.AgentToolName, "agent-wedge-1", map[string]any{}, 10, 5),
			textResponse("unreachable", 10, 5),
		},
	}
	registerWatchdogTestProvider(t, mock)

	b := NewApiBackend()
	const requestID = "req-agent-wedge"
	c := collectEvents(b, requestID)

	// Tool-stall interval (50ms) far below the run-stall threshold (2s): many
	// ToolStalledEvents fire before the run-stall window elapses, so the test
	// genuinely exercises "stall emits do not hold the watchdog off".
	//
	// The run-stall threshold must also be comfortably larger than the time it
	// takes the run goroutine to start, stream the tool_use block, and dispatch
	// the tool. The run-stall clock starts at run registration, so on a
	// CPU-starved Linux -race runner the 400ms this test originally used could
	// elapse during startup: the watchdog then cancelled the run before
	// executeTools ever dispatched, no advisory could fire, and the
	// ToolStalledEvent assertion failed while both watchdog assertions still
	// passed. That is the exact engine-test (ubuntu-latest) signature this
	// threshold removes — the same wall-clock-timer-vs-starved-goroutine flake
	// class as TestRunloopWatchdogCancelsStalledRun (#239).
	cfg := &RunConfig{
		Timeouts: &types.TimeoutsConfig{
			ToolStallMs: 50,
			RunStallMs:  2000,
		},
	}
	b.StartRunWithConfig(requestID, types.RunOptions{
		Prompt:           "wedge the agent tool",
		Model:            watchdogTestModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, cfg)

	// Confirm the wedged tool was actually entered before relying on the
	// watchdog, so a startup regression reports itself here rather than as a
	// confusing missing-advisory assertion further down.
	select {
	case <-toolEntered:
	case <-time.After(10 * time.Second):
		t.Fatal("wedged Agent tool was never entered within 10s — tool dispatch regressed")
	}

	// Then wait for the first stall advisory. Ordering the waits this way is
	// what makes the assertions below deterministic: the advisory is emitted
	// 50ms into a tool that the watchdog will not cancel for 2s, so observing
	// one here does not race the cancellation.
	if !waitForToolStalled(c, "agent-wedge-1", 10*time.Second) {
		t.Fatal("no ToolStalledEvent for the wedged Agent tool within 10s — the stall advisory regressed")
	}

	if !waitForExit(c, 15*time.Second) {
		t.Fatal("run-stall watchdog never fired despite a wedged deadline-exempt Agent tool — tool-stall emits are defeating the watchdog (the incident defect)")
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// The stall advisory must still have fired (we did not silence it; we
	// only made it progress-neutral). At least one ToolStalledEvent proves
	// the tool ran long enough to emit, which is precisely the case the
	// watchdog must survive.
	var sawToolStalled, sawRunStalled, sawRunStalledErrorCode bool
	for _, ev := range c.normalized {
		switch d := ev.Data.(type) {
		case *types.ToolStalledEvent:
			if d.ToolID == "agent-wedge-1" {
				sawToolStalled = true
			}
		case *types.RunStalledEvent:
			sawRunStalled = true
		case *types.ErrorEvent:
			if d.ErrorCode == "run_stalled" {
				sawRunStalledErrorCode = true
			}
		}
	}
	if !sawToolStalled {
		t.Error("expected at least one ToolStalledEvent for the wedged Agent tool (advisory must still fire)")
	}
	if !sawRunStalled {
		t.Error("expected RunStalledEvent — the run-stall watchdog must fire despite the periodic tool-stall emits")
	}
	if !sawRunStalledErrorCode {
		t.Error("expected ErrorEvent{run_stalled} for headless consumers")
	}

	if !waitForRunRemoved(b, requestID, 5*time.Second) {
		t.Error("expected run removed from activeRuns after watchdog cancellation")
	}
}

// waitForRunRemoved polls until requestID is gone from b.activeRuns, up to
// timeout.
//
// Sampling activeRuns immediately after waitForExit is a race, not a check:
// runLoop calls emitExit (which fires the OnExit callback waitForExit observes)
// and only then returns, so the deferred removeRun runs *after* the test has
// already been released. On an unstarved machine the defer wins by microseconds
// and the sample passes; under Linux -race on a loaded runner the test wins and
// the assertion fails on a run that was about to be removed correctly. Waiting
// pins the real invariant — the run is removed — without depending on which
// side of the callback the defer lands.
func waitForRunRemoved(b *ApiBackend, requestID string, timeout time.Duration) bool {
	deadline := time.After(timeout)
	for {
		b.mu.Lock()
		_, stillActive := b.activeRuns[requestID]
		b.mu.Unlock()
		if !stillActive {
			return true
		}
		select {
		case <-deadline:
			return false
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
}

// waitForToolStalled polls the collected events for a ToolStalledEvent carrying
// toolID, up to timeout. It exists so the stall-advisory assertion can be an
// explicit wait rather than a post-hoc scan of whatever happened to arrive
// before the run exited: the advisory and the watchdog cancellation are driven
// by two independent timers, and scanning after exit makes the assertion a race
// on which timer won under CPU starvation.
func waitForToolStalled(c *collectedEvents, toolID string, timeout time.Duration) bool {
	deadline := time.After(timeout)
	for {
		c.mu.Lock()
		for _, ev := range c.normalized {
			if d, ok := ev.Data.(*types.ToolStalledEvent); ok && d.ToolID == toolID {
				c.mu.Unlock()
				return true
			}
		}
		c.mu.Unlock()
		select {
		case <-deadline:
			return false
		default:
			time.Sleep(5 * time.Millisecond)
		}
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

func (p *progressDripProvider) CountTokens(_ context.Context, _ providers.CountTokensRequest) (int, error) {
	return 0, providers.ErrCountUnsupported
}

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
