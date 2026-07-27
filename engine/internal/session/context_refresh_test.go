package session

// context_refresh_test.go — the run-exit context recompute (RC-4) and the
// cumulative-vs-occupancy separation (RC-1/RC-3).
//
// These two defects together produced the reported bug: a conversation holding
// ~227k tokens reported 0% context at idle. The engine's retained context
// state was written from TaskCompleteEvent.Usage, which is CUMULATIVE RUN
// BILLING (summed across turns) and not context occupancy — a run whose turns
// were almost entirely cache reads sums to a tiny figure. Nothing recomputed
// the value afterwards, so the tiny figure became the idle truth.

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// captureMessageEnd collects engine_message_end events. The shared
// captureEngineStatus helper filters to engine_status only.
type captureMessageEnd struct {
	mu     sync.Mutex
	events []types.EngineEvent
}

func newCaptureMessageEnd() *captureMessageEnd {
	return &captureMessageEnd{}
}

func (c *captureMessageEnd) handler() func(string, types.EngineEvent) {
	return func(_ string, ev types.EngineEvent) {
		if ev.Type != "engine_message_end" {
			return
		}
		c.mu.Lock()
		c.events = append(c.events, ev)
		c.mu.Unlock()
	}
}

func (c *captureMessageEnd) last() (types.EngineEvent, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.events) == 0 {
		return types.EngineEvent{}, false
	}
	return c.events[len(c.events)-1], true
}

// TestRefreshContextUsage_RecomputesFromPersistedConversation proves the run
// exit recomputes occupancy from what is actually on disk. Starting from a
// session whose retained values are zero (the state a backend that emits no
// usage events leaves behind — the ACP backends emit none), handleRunExit must
// produce a non-zero token count and a matching percent.
//
// Fails without the refreshContextUsage call in handleRunExit: the retained
// zeros survive and the idle status reports 0%.
func TestRefreshContextUsage_RecomputesFromPersistedConversation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	const convID = "1781483744990-ctxrefresh1"
	const occupancy = 120000
	seedResumableConversation(t, convID, occupancy)

	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(10 * time.Minute)

	cfg := defaultConfig()
	cfg.SessionID = convID
	if _, err := mgr.StartSession("ctx-refresh", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions["ctx-refresh"]
	if s == nil {
		mgr.mu.Unlock()
		t.Fatalf("session not registered")
	}
	// Zero the retained state so the assertion can only pass if the run-exit
	// recompute actually ran. This models a backend that emitted no usage.
	s.lastContextPct = 0
	s.lastContextTokens = 0
	s.requestID = "run-ctxrefresh-1"
	mgr.bindRunLocked("run-ctxrefresh-1", "ctx-refresh")
	mgr.mu.Unlock()

	code := 0
	mgr.handleRunExit("run-ctxrefresh-1", &code, nil, convID)

	mgr.mu.RLock()
	gotTokens := s.lastContextTokens
	gotPct := s.lastContextPct
	gotWindow := s.lastContextWindow
	mgr.mu.RUnlock()

	if gotTokens < occupancy {
		t.Fatalf("lastContextTokens = %d, want >= %d (recomputed from persisted conversation)", gotTokens, occupancy)
	}
	if gotPct <= 0 {
		t.Fatalf("lastContextPct = %d, want > 0 after run-exit recompute", gotPct)
	}
	// The percent must be consistent with the tokens and window it was
	// computed from, not an unrelated figure carried over from elsewhere.
	wantPct := int(float64(gotTokens) / float64(gotWindow) * 100)
	if gotPct < wantPct-1 || gotPct > wantPct+1 {
		t.Fatalf("lastContextPct = %d, want ≈%d (tokens=%d / window=%d)", gotPct, wantPct, gotTokens, gotWindow)
	}

	// The idle snapshot a consumer receives must carry the same numbers.
	cap := newCaptureEngineStatus()
	mgr.OnEvent(cap.handler())
	mgr.emitStatusSnapshot("ctx-refresh", "test")
	last, ok := cap.last("ctx-refresh")
	if !ok || last.Fields == nil {
		t.Fatalf("no idle status emitted after run exit")
	}
	if last.Fields.ContextTokens != gotTokens {
		t.Fatalf("status ContextTokens = %d, want %d", last.Fields.ContextTokens, gotTokens)
	}
	if last.Fields.ContextPercent != gotPct {
		t.Fatalf("status ContextPercent = %d, want %d", last.Fields.ContextPercent, gotPct)
	}
}

// TestTaskComplete_CumulativeUsageDoesNotOverwriteOccupancy is the direct
// regression test for the reported bug. A per-turn UsageEvent establishes real
// occupancy; the TaskCompleteEvent that follows carries CUMULATIVE run billing
// — the sum of every turn's input tokens, which for a long multi-turn run is
// several times the actual occupancy. Feeding that sum through the
// occupancy math produced a wildly wrong percent (and, in the inverse
// cache-heavy case, the tiny figure the desktop rendered as 0%).
//
// Fails on the unfixed code: the TaskComplete arm wrote
// s2.lastContextPct = *tc.Usage.InputTokens * 100 / contextWindow.
func TestTaskComplete_CumulativeUsageDoesNotOverwriteOccupancy(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(10 * time.Minute)

	if _, err := mgr.StartSession("cumul", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions["cumul"]
	if s == nil {
		mgr.mu.Unlock()
		t.Fatalf("session not registered")
	}
	s.lastContextWindow = 1000000
	s.requestID = "run-cumul-1"
	mgr.bindRunLocked("run-cumul-1", "cumul")
	mgr.mu.Unlock()

	// Per-turn occupancy: the backend already summed input + cache_read +
	// cache_creation before emitting this. 227099 / 1M ≈ 22%.
	const occupancy = 227099
	occ := occupancy
	out := 326
	mgr.handleNormalizedEvent("run-cumul-1", types.NormalizedEvent{
		Data: &types.UsageEvent{Usage: types.UsageData{InputTokens: &occ, OutputTokens: &out}},
	})

	mgr.mu.RLock()
	pctAfterUsage := s.lastContextPct
	tokensAfterUsage := s.lastContextTokens
	mgr.mu.RUnlock()
	if tokensAfterUsage != occupancy {
		t.Fatalf("precondition: lastContextTokens = %d, want %d from the UsageEvent", tokensAfterUsage, occupancy)
	}
	if pctAfterUsage <= 0 {
		t.Fatalf("precondition: lastContextPct = %d, want > 0 from the UsageEvent", pctAfterUsage)
	}

	// Run completes. Cumulative billing sums ten turns of ~200k each — an
	// order of magnitude above the conversation's actual occupancy.
	cumIn := 2000000
	cumOut := 3385
	captured := newCaptureMessageEnd()
	mgr.OnEvent(captured.handler())
	mgr.handleNormalizedEvent("run-cumul-1", types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			SessionID: "cumul-conv",
			CostUsd:   2.18,
			Usage:     types.UsageData{InputTokens: &cumIn, OutputTokens: &cumOut},
		},
	})

	mgr.mu.RLock()
	pctAfterComplete := s.lastContextPct
	tokensAfterComplete := s.lastContextTokens
	mgr.mu.RUnlock()

	if tokensAfterComplete != occupancy {
		t.Fatalf("cumulative TaskComplete usage overwrote occupancy tokens: got %d, want %d retained", tokensAfterComplete, occupancy)
	}
	if pctAfterComplete != pctAfterUsage {
		t.Fatalf("cumulative TaskComplete usage overwrote occupancy percent: got %d, want %d retained", pctAfterComplete, pctAfterUsage)
	}

	// The run-complete engine_message_end must report the occupancy percent
	// alongside its cumulative token counts — the two are different
	// quantities and the percent is the one consumers render.
	end, ok := captured.last()
	if !ok || end.EndUsage == nil {
		t.Fatalf("no engine_message_end emitted for the completed run")
	}
	if end.EndUsage.ContextPercent != pctAfterUsage {
		t.Fatalf("message_end ContextPercent = %d, want occupancy %d (not cumulative-derived)", end.EndUsage.ContextPercent, pctAfterUsage)
	}
}

// TestStartSession_SeedsContextWithEmptyHeaderModel closes RC-5. Every
// conversation first persisted by the delegated-CLI path carries model:"" in
// its .llm.jsonl header (persistCliTurn calls CreateConversation with an empty
// model, and nothing ever rewrites it). The seed used to be gated on a
// non-empty header model, so those conversations reported 0% forever.
//
// Fails without the gate split in StartSession.
func TestStartSession_SeedsContextWithEmptyHeaderModel(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	const convID = "1781483744990-emptymodel"
	const occupancy = 90000

	// Header model deliberately empty — the delegated-CLI shape.
	conv := conversation.CreateConversation(convID, "", "")
	conversation.AddUserMessage(conv, "hello there")
	conversation.AddAssistantMessage(conv,
		[]types.LlmContentBlock{{Type: "text", Text: "hi"}},
		types.LlmUsage{InputTokens: occupancy, OutputTokens: 10})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save conversation: %v", err)
	}

	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(10 * time.Minute)

	cap := newCaptureEngineStatus()
	mgr.OnEvent(cap.handler())

	cfg := defaultConfig()
	cfg.SessionID = convID
	if _, err := mgr.StartSession("empty-model", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.RLock()
	s := mgr.sessions["empty-model"]
	var gotTokens, gotPct int
	if s != nil {
		gotTokens = s.lastContextTokens
		gotPct = s.lastContextPct
	}
	mgr.mu.RUnlock()

	if gotTokens < occupancy {
		t.Fatalf("lastContextTokens = %d, want >= %d despite empty header model", gotTokens, occupancy)
	}
	if gotPct <= 0 {
		t.Fatalf("lastContextPct = %d, want > 0 despite empty header model", gotPct)
	}

	last, ok := cap.last("empty-model")
	if !ok || last.Fields == nil {
		t.Fatalf("no engine_status emitted")
	}
	if last.Fields.ContextTokens != gotTokens {
		t.Fatalf("status ContextTokens = %d, want %d", last.Fields.ContextTokens, gotTokens)
	}
}
