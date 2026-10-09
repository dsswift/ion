package providers

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// fakeClock drives the mock's now/wait seams so timing assertions are exact
// and the tests never sleep.
type fakeClock struct {
	t     time.Time
	waits []time.Duration
}

func (c *fakeClock) now() time.Time { return c.t }

func (c *fakeClock) wait(ctx context.Context, d time.Duration) error {
	c.waits = append(c.waits, d)
	c.t = c.t.Add(d)
	return ctx.Err()
}

func mockWithClock(t *testing.T, scenarioJSON string) (*MockScenarioProvider, *fakeClock) {
	t.Helper()
	s, err := ParseMockScenario([]byte(scenarioJSON))
	if err != nil {
		t.Fatalf("parse scenario: %v", err)
	}
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	p := NewMockScenarioProvider(s)
	p.now, p.wait = clock.now, clock.wait
	return p, clock
}

// drainMock collects every event of one stream. The fake clock is touched
// only by the producer goroutine; the closed channels order its writes
// before the caller reads clock.waits.
func drainMock(t *testing.T, p *MockScenarioProvider, opts types.LlmStreamOptions) []types.LlmStreamEvent {
	t.Helper()
	events, errc := p.Stream(context.Background(), opts)
	var out []types.LlmStreamEvent
	for ev := range events {
		out = append(out, ev)
	}
	if err := <-errc; err != nil {
		t.Fatalf("stream error: %v", err)
	}
	return out
}

// planOffsets is the scripted offset of every event, from the pure builder.
func planOffsets(p *MockScenarioProvider, opts types.LlmStreamOptions) []mockStep {
	idx := mockTurnIndex(opts.Messages)
	return p.buildTurn(opts, idx, p.scenario.turnFor(idx))
}

func streamText(evs []types.LlmStreamEvent) string {
	var b strings.Builder
	for _, ev := range evs {
		if ev.Type == "content_block_delta" && ev.Delta != nil && ev.Delta.Type == "text_delta" {
			b.WriteString(ev.Delta.Text)
		}
	}
	return b.String()
}

func firstUserRequest() types.LlmStreamOptions {
	return types.LlmStreamOptions{Model: MockDefaultModel, Messages: []types.LlmMessage{{Role: "user", Content: "hello"}}}
}

func TestMockStream_SameSeedIdenticalStream(t *testing.T) {
	const scenario = `{"seed": 42, "turns": [{"ttft_ms": 120, "tokens": 25, "tokens_per_s": 50, "tool_calls": [{"name": "Read", "input": {"file_path": "/tmp/x"}}]}], "repeat": true}`
	p1, _ := mockWithClock(t, scenario)
	p2, _ := mockWithClock(t, scenario)
	a := drainMock(t, p1, firstUserRequest())
	b := drainMock(t, p2, firstUserRequest())
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("same seed produced different streams:\n%+v\n%+v", a, b)
	}
	if !reflect.DeepEqual(planOffsets(p1, firstUserRequest()), planOffsets(p2, firstUserRequest())) {
		t.Fatal("same seed produced different event timing")
	}
	if got := len(strings.Fields(streamText(a))); got != 25 {
		t.Fatalf("streamed %d words, want 25", got)
	}

	other, _ := mockWithClock(t, strings.Replace(scenario, `"seed": 42`, `"seed": 43`, 1))
	if streamText(drainMock(t, other, firstUserRequest())) == streamText(a) {
		t.Fatal("a different seed streamed the same text")
	}
}

func TestMockStream_ScriptedTTFTAndRate(t *testing.T) {
	p, clock := mockWithClock(t, `{"seed": 1, "turns": [{"ttft_ms": 300, "tokens": 5, "tokens_per_s": 100, "tool_calls": []}], "repeat": false}`)
	plan := planOffsets(p, firstUserRequest())
	if plan[0].ev.Type != "message_start" || plan[0].at != 300*time.Millisecond {
		t.Fatalf("first event %q at %v, want message_start at 300ms", plan[0].ev.Type, plan[0].at)
	}
	var deltaAt []time.Duration
	for _, step := range plan {
		if step.ev.Type == "content_block_delta" {
			deltaAt = append(deltaAt, step.at)
		}
	}
	ms := time.Millisecond
	if want := []time.Duration{300 * ms, 310 * ms, 320 * ms, 330 * ms, 340 * ms}; !reflect.DeepEqual(deltaAt, want) {
		t.Fatalf("token offsets %v, want %v", deltaAt, want)
	}

	// The stream honors the plan: it waits the TTFT, then one token gap per
	// later token, and never otherwise.
	evs := drainMock(t, p, firstUserRequest())
	if want := []time.Duration{300 * ms, 10 * ms, 10 * ms, 10 * ms, 10 * ms}; !reflect.DeepEqual(clock.waits, want) {
		t.Fatalf("stream waits %v, want %v", clock.waits, want)
	}
	if evs[0].Type != "message_start" || evs[len(evs)-1].Type != "message_stop" {
		t.Fatalf("stream framed by %q..%q, want message_start..message_stop", evs[0].Type, evs[len(evs)-1].Type)
	}
	for _, ev := range evs {
		if ev.Type == "message_delta" && (*ev.Delta.StopReason != "end_turn" || ev.DeltaUsage.OutputTokens != 5) {
			t.Fatalf("message_delta stop=%q output=%d, want end_turn/5", *ev.Delta.StopReason, ev.DeltaUsage.OutputTokens)
		}
	}
}

func TestMockStream_ScriptedToolCalls(t *testing.T) {
	p, _ := mockWithClock(t, `{"seed": 9, "turns": [{"ttft_ms": 0, "tokens": 0, "tokens_per_s": 0, "tool_calls": [{"name": "Read", "input": {"file_path": "/tmp/a"}}, {"name": "Glob"}]}], "repeat": true}`)
	evs := drainMock(t, p, firstUserRequest())

	type call struct{ id, name, input string }
	var calls []call
	var stop string
	for _, ev := range evs {
		switch {
		case ev.Type == "content_block_start" && ev.ContentBlock.Type == "tool_use":
			calls = append(calls, call{id: ev.ContentBlock.ID, name: ev.ContentBlock.Name})
		case ev.Type == "content_block_delta" && ev.Delta.Type == "input_json_delta":
			calls[len(calls)-1].input = ev.Delta.PartialJSON
		case ev.Type == "content_block_start" && ev.ContentBlock.Type == "text":
			t.Fatal("a zero-token turn opened a text block")
		case ev.Type == "message_delta":
			stop = *ev.Delta.StopReason
		}
	}
	if len(calls) != 2 || calls[0].name != "Read" || calls[1].name != "Glob" {
		t.Fatalf("tool calls %+v, want Read then Glob", calls)
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(calls[0].input), &input); err != nil || input["file_path"] != "/tmp/a" {
		t.Fatalf("Read input %q (err %v), want file_path /tmp/a", calls[0].input, err)
	}
	if calls[1].input != "{}" {
		t.Fatalf("Glob input %q, want {}", calls[1].input)
	}
	if calls[0].id == calls[1].id || !strings.HasPrefix(calls[0].id, "toolu_mock_0_0_") {
		t.Fatalf("tool ids %q %q must be distinct and turn-scoped", calls[0].id, calls[1].id)
	}
	if stop != "tool_use" {
		t.Fatalf("stop reason %q, want tool_use", stop)
	}
}

func TestMockStream_TurnIndexFromHistory(t *testing.T) {
	const turns = `"turns": [{"ttft_ms": 10, "tokens": 1, "tokens_per_s": 0, "tool_calls": []}, {"ttft_ms": 20, "tokens": 1, "tokens_per_s": 0, "tool_calls": []}]`
	history := func(assistants int) types.LlmStreamOptions {
		opts := firstUserRequest()
		for i := 0; i < assistants; i++ {
			opts.Messages = append(opts.Messages, types.LlmMessage{Role: "assistant", Content: "a"}, types.LlmMessage{Role: "user", Content: "u"})
		}
		return opts
	}
	cases := []struct {
		repeat     bool
		assistants int
		wantTTFT   time.Duration
	}{
		{true, 0, 10 * time.Millisecond},
		{true, 1, 20 * time.Millisecond},
		{true, 2, 10 * time.Millisecond},  // cycles
		{false, 2, 20 * time.Millisecond}, // holds the last turn
		{false, 5, 20 * time.Millisecond},
	}
	for _, tc := range cases {
		repeat := "false"
		if tc.repeat {
			repeat = "true"
		}
		p, _ := mockWithClock(t, `{"seed": 3, `+turns+`, "repeat": `+repeat+`}`)
		if at := planOffsets(p, history(tc.assistants))[0].at; at != tc.wantTTFT {
			t.Errorf("repeat=%v assistants=%d: ttft %v, want %v", tc.repeat, tc.assistants, at, tc.wantTTFT)
		}
	}
}

func TestMockStream_CancelEndsWithContextError(t *testing.T) {
	s, err := ParseMockScenario([]byte(`{"seed": 1, "turns": [{"ttft_ms": 60000, "tokens": 1, "tokens_per_s": 0, "tool_calls": []}], "repeat": true}`))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	events, errc := NewMockScenarioProvider(s).Stream(ctx, firstUserRequest())
	cancel()
	for range events {
		t.Fatal("no event may arrive before a 60s TTFT")
	}
	if err := <-errc; !errors.Is(err, context.Canceled) {
		t.Fatalf("stream error %v, want context.Canceled", err)
	}
}

func TestParseMockScenario_Refusals(t *testing.T) {
	cases := map[string]string{
		"no turns":      `{"seed": 1, "turns": [], "repeat": true}`,
		"unknown field": `{"seed": 1, "turns": [{"ttft": 1}], "repeat": true}`,
		"negative ttft": `{"seed": 1, "turns": [{"ttft_ms": -1}], "repeat": true}`,
		"unnamed tool":  `{"seed": 1, "turns": [{"tool_calls": [{"input": {}}]}], "repeat": true}`,
	}
	for name, body := range cases {
		if _, err := ParseMockScenario([]byte(body)); err == nil {
			t.Errorf("%s: parsed, want an error", name)
		}
	}
}

// The perf runner's shipped scenarios must load as-is: the runner writes their
// provider block verbatim to the file providers.mock.scenarioFile names.
func TestParseMockScenario_PerfScenarios(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("..", "..", "..", "scripts", "perf", "scenarios", "*.json"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("no perf scenarios found (err %v)", err)
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var file struct {
			Provider json.RawMessage `json:"provider"`
		}
		if err := json.Unmarshal(data, &file); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if _, err := ParseMockScenario(file.Provider); err != nil {
			t.Errorf("%s: %v", path, err)
		}
	}
}

func TestApplyConfig_SelectsMockProvider(t *testing.T) {
	t.Cleanup(func() {
		UnregisterProvider(MockProviderID)
		UnregisterModel(MockDefaultModel)
	})
	path := filepath.Join(t.TempDir(), "scenario.json")
	if err := os.WriteFile(path, []byte(`{"seed": 5, "turns": [{"ttft_ms": 0, "tokens": 2, "tokens_per_s": 0, "tool_calls": []}], "repeat": true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var cfg types.EngineRuntimeConfig
	if err := json.Unmarshal([]byte(`{"providers": {"mock": {"scenarioFile": "`+path+`"}}}`), &cfg); err != nil {
		t.Fatal(err)
	}
	ApplyConfig(cfg.Providers)

	p := ResolveProvider(MockDefaultModel)
	if p == nil || p.ID() != MockProviderID {
		t.Fatalf("ResolveProvider(%q) = %v, want the mock provider", MockDefaultModel, p)
	}
	if info := GetModelInfo(MockDefaultModel); info == nil || info.ProviderID != MockProviderID {
		t.Fatalf("model %q not registered to the mock provider: %+v", MockDefaultModel, info)
	}
	if name := ProviderNameForModel(MockDefaultModel); name != MockProviderID {
		t.Fatalf("ProviderNameForModel = %q, want %q", name, MockProviderID)
	}
}

func TestApplyConfig_MockWithBadScenarioStaysUnregistered(t *testing.T) {
	t.Cleanup(func() {
		UnregisterProvider(MockProviderID)
		UnregisterModel(MockDefaultModel)
	})
	UnregisterProvider(MockProviderID)
	UnregisterModel(MockDefaultModel)
	ApplyConfig(map[string]types.ProviderConfig{MockProviderID: {ScenarioFile: filepath.Join(t.TempDir(), "missing.json")}})
	if p := GetProvider(MockProviderID); p != nil {
		t.Fatalf("mock registered from a missing scenario: %v", p)
	}
}
