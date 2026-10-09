package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// MockScenarioProvider is a runtime LlmProvider that streams a scripted
// scenario instead of calling a model. It exists so a performance harness can
// drive the real run loop (spans, telemetry, tool execution, persistence)
// with a fixed, repeatable provider: per-turn TTFT, token count, token rate,
// and tool calls come from the script; the words and tool-use ids come from
// the scenario seed.
//
// It holds no per-conversation state. The turn a request plays is derived
// from the request itself (its assistant-message count), so concurrent
// conversations never perturb each other's scripts.
type MockScenarioProvider struct {
	scenario *MockScenario
	// now and wait are the clock seams. Production uses the wall clock.
	now  func() time.Time
	wait func(ctx context.Context, d time.Duration) error
}

// NewMockScenarioProvider builds a mock provider over a validated scenario.
func NewMockScenarioProvider(s *MockScenario) *MockScenarioProvider {
	return &MockScenarioProvider{scenario: s, now: time.Now, wait: waitCtx}
}

// ID implements LlmProvider.
func (p *MockScenarioProvider) ID() string { return MockProviderID }

// CountTokens implements LlmProvider. The mock has no native endpoint;
// callers fall back to local counting exactly as for any provider without one.
func (p *MockScenarioProvider) CountTokens(context.Context, CountTokensRequest) (int, error) {
	return 0, ErrCountUnsupported
}

// mockVocabulary is the word pool streamed text is drawn from. One word is one
// token on the stream.
var mockVocabulary = []string{
	"the", "engine", "streams", "a", "scripted", "turn", "with", "fixed",
	"timing", "so", "every", "run", "measures", "the", "same", "work",
	"latency", "span", "provider", "token", "event", "loop", "tool", "result",
	"context", "window", "message", "block", "delta", "seed", "harness", "trace",
}

// Stream implements LlmProvider. It plays the scenario turn for this request:
// waits TTFT, emits message_start, then the text tokens paced at the scripted
// rate, then each scripted tool_use block, then message_delta and
// message_stop. Cancellation ends the stream with ctx.Err() on the error
// channel, as a real provider's aborted HTTP stream does.
func (p *MockScenarioProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 64)
	errc := make(chan error, 1)

	turnIndex := mockTurnIndex(opts.Messages)
	turn := p.scenario.turnFor(turnIndex)
	plan := p.buildTurn(opts, turnIndex, turn)
	utils.LogWithFields(utils.LevelDebug, "Providers", "mock stream start", map[string]any{
		"provider": MockProviderID, "model": opts.Model, "turn_index": turnIndex,
		"ttft_ms": turn.TTFTMs, "tokens": turn.Tokens, "tokens_per_s": turn.TokensPerSecond,
		"tool_calls": len(turn.ToolCalls), "seed": p.scenario.Seed,
	})

	go func() {
		defer close(events)
		defer close(errc)
		start := p.now()
		for _, step := range plan {
			if err := p.waitUntil(ctx, start.Add(step.at)); err != nil {
				utils.LogWithFields(utils.LevelInfo, "Providers", "mock stream cancelled", map[string]any{
					"provider": MockProviderID, "model": opts.Model, "turn_index": turnIndex, "error": err.Error(),
				})
				errc <- err
				return
			}
			select {
			case events <- step.ev:
			case <-ctx.Done():
				utils.LogWithFields(utils.LevelInfo, "Providers", "mock stream cancelled", map[string]any{
					"provider": MockProviderID, "model": opts.Model, "turn_index": turnIndex, "error": ctx.Err().Error(),
				})
				errc <- ctx.Err()
				return
			}
		}
		utils.LogWithFields(utils.LevelDebug, "Providers", "mock stream complete", map[string]any{
			"provider": MockProviderID, "model": opts.Model, "turn_index": turnIndex,
			"events": len(plan), "duration_ms": p.now().Sub(start).Milliseconds(),
		})
	}()
	return events, errc
}

// mockStep is one stream event and its offset from the start of the call.
type mockStep struct {
	at time.Duration
	ev types.LlmStreamEvent
}

// buildTurn renders a turn into its timed event sequence. Everything except
// the offsets is a pure function of (seed, turnIndex, turn, request), which
// is what makes two streams of the same request identical.
func (p *MockScenarioProvider) buildTurn(opts types.LlmStreamOptions, turnIndex int, turn MockTurn) []mockStep {
	//nolint:gosec // G404: deterministic scripted output keyed by the scenario seed, not a security value.
	rng := rand.New(rand.NewPCG(uint64(p.scenario.Seed), uint64(turnIndex)))
	ttft := time.Duration(turn.TTFTMs) * time.Millisecond
	var tokenGap time.Duration
	if turn.TokensPerSecond > 0 {
		tokenGap = time.Duration(float64(time.Second) / turn.TokensPerSecond)
	}

	steps := make([]mockStep, 0, turn.Tokens+4*len(turn.ToolCalls)+6)
	steps = append(steps, mockStep{at: ttft, ev: types.LlmStreamEvent{
		Type: "message_start",
		MessageInfo: &types.LlmStreamMessageInfo{
			ID:    fmt.Sprintf("msg_mock_%d_%d", p.scenario.Seed, turnIndex),
			Model: opts.Model,
			Usage: types.LlmUsage{InputTokens: mockInputTokens(opts)},
		},
	}})

	at := ttft
	block := 0
	if turn.Tokens > 0 {
		steps = append(steps, mockStep{at: at, ev: types.LlmStreamEvent{
			Type: "content_block_start", BlockIndex: block,
			ContentBlock: &types.LlmStreamContentBlock{Type: "text"},
		}})
		for i := 0; i < turn.Tokens; i++ {
			at = ttft + time.Duration(i)*tokenGap
			word := mockVocabulary[rng.IntN(len(mockVocabulary))]
			if i > 0 {
				word = " " + word
			}
			steps = append(steps, mockStep{at: at, ev: types.LlmStreamEvent{
				Type: "content_block_delta", BlockIndex: block,
				Delta: &types.LlmStreamDelta{Type: "text_delta", Text: word},
			}})
		}
		steps = append(steps, mockStep{at: at, ev: types.LlmStreamEvent{Type: "content_block_stop", BlockIndex: block}})
		block++
	}

	for i, call := range turn.ToolCalls {
		id := fmt.Sprintf("toolu_mock_%d_%d_%016x", turnIndex, i, rng.Uint64())
		steps = append(steps,
			mockStep{at: at, ev: types.LlmStreamEvent{
				Type: "content_block_start", BlockIndex: block,
				ContentBlock: &types.LlmStreamContentBlock{Type: "tool_use", ID: id, Name: call.Name},
			}},
			mockStep{at: at, ev: types.LlmStreamEvent{
				Type: "content_block_delta", BlockIndex: block,
				Delta: &types.LlmStreamDelta{Type: "input_json_delta", PartialJSON: mockToolInputJSON(call)},
			}},
			mockStep{at: at, ev: types.LlmStreamEvent{Type: "content_block_stop", BlockIndex: block}},
		)
		block++
	}

	stopReason := "end_turn"
	if len(turn.ToolCalls) > 0 {
		stopReason = "tool_use"
	}
	steps = append(steps,
		mockStep{at: at, ev: types.LlmStreamEvent{
			Type:       "message_delta",
			Delta:      &types.LlmStreamDelta{Type: "message_delta", StopReason: &stopReason},
			DeltaUsage: &types.LlmUsage{OutputTokens: turn.Tokens},
		}},
		mockStep{at: at, ev: types.LlmStreamEvent{Type: "message_stop"}},
	)
	return steps
}

// waitUntil blocks until the deadline or ctx ends. A deadline already passed
// returns at once, so a slow consumer never makes the stream sleep twice.
func (p *MockScenarioProvider) waitUntil(ctx context.Context, deadline time.Time) error {
	if d := deadline.Sub(p.now()); d > 0 {
		return p.wait(ctx, d)
	}
	return ctx.Err()
}

func waitCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// mockTurnIndex is the number of assistant messages already in the request:
// 0 for a conversation's first call, 1 after one assistant reply or tool
// round, and so on.
func mockTurnIndex(messages []types.LlmMessage) int {
	n := 0
	for _, m := range messages {
		if m.Role == "assistant" {
			n++
		}
	}
	return n
}

// mockInputTokens estimates prompt size at four bytes per token, so usage
// and cost accounting see a number that grows with the conversation.
func mockInputTokens(opts types.LlmStreamOptions) int {
	size := len(opts.System)
	if b, err := json.Marshal(opts.Messages); err == nil {
		size += len(b)
	} else {
		utils.LogWithFields(utils.LevelDebug, "Providers", "mock input token estimate skipped messages", map[string]any{"error": err.Error()})
	}
	return size / 4
}

// mockToolInputJSON renders a scripted tool input. The scenario decoded it
// from JSON, so encoding it back cannot fail for anything but a programming
// error; that case falls back to {} and logs.
func mockToolInputJSON(call MockToolCall) string {
	if len(call.Input) == 0 {
		return "{}"
	}
	b, err := json.Marshal(call.Input)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "Providers", "mock tool input encode failed", map[string]any{"tool": call.Name, "error": err.Error()})
		return "{}"
	}
	return string(b)
}

// registerMockFromConfig loads the scenario a providers.mock entry names and
// registers the mock provider and its model. A missing or invalid scenario
// leaves the mock unregistered, so a run that selects it fails as an unknown
// model rather than streaming an unscripted default.
func registerMockFromConfig(cfg types.ProviderConfig) {
	s, err := LoadMockScenario(cfg.ScenarioFile)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "Providers", "mock provider not registered", map[string]any{
			"provider": MockProviderID, "scenario_file": cfg.ScenarioFile, "error": err.Error(),
		})
		return
	}
	RegisterProvider(NewMockScenarioProvider(s))
	RegisterModel(MockDefaultModel, types.ModelInfo{
		ProviderID:    MockProviderID,
		DisplayName:   "Mock (scripted)",
		ContextWindow: 200000,
	})
	tools := 0
	for _, t := range s.Turns {
		tools += len(t.ToolCalls)
	}
	utils.LogWithFields(utils.LevelInfo, "Providers", "mock provider registered", map[string]any{
		"provider": MockProviderID, "model": MockDefaultModel, "scenario_file": cfg.ScenarioFile,
		"seed": s.Seed, "turns": len(s.Turns), "repeat": s.Repeat, "scripted_tool_calls": tools,
	})
}
