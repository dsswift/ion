package backend

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// CompactRequest carries everything the engine needs to run user-initiated
// compaction outside of an active agent loop. Built by the session layer
// from session state (conversation ID, last-known model, generated request
// ID) and passed verbatim into ApiBackend.CompactNow.
//
// All fields are required EXCEPT RunConfig, which may be nil. When nil,
// CompactNow falls back to the ApiBackend's lastRunConfig (the config
// captured at the last StartRunWithConfig call). When both are nil the
// compaction proceeds with an empty hook set — observability still fires
// (CompactingEvent, tree entry, save) but the session-memory tier and the
// session_compact hook are skipped because their plumbing is not wired up.
//
// Adding new fields here is non-breaking — zero-valued defaults work
// because every consumer constructs the struct in-process; this is not a
// wire-protocol type.
type CompactRequest struct {
	// ConversationID is the file-system ID of the conversation to compact.
	// Loaded from disk via conversation.Load(id, ""). An empty value is a
	// caller error; CompactNow returns an error in that case.
	ConversationID string

	// Model identifies the model the session is currently using so the
	// engine can size the context window. Passed through resolveContextWindow
	// for window lookup; unknown models (and zero-window registry entries)
	// fall back to conversation.DefaultContext with a warning log, matching
	// the agent-loop's resolution path.
	Model string

	// RequestID is the synthetic run ID under which emitted events fire.
	// Consumers see this in the runID-keyed routing of CompactingEvent and
	// UsageEvent emissions. Should be unique per call so consumers can
	// correlate the user-trigger with the resulting events; the session
	// layer typically generates one with a "user-compact-" prefix.
	RequestID string

	// RunConfig optionally overrides the backend's cached config. When nil,
	// CompactNow uses ApiBackend.lastRunConfig (set by StartRunWithConfig).
	// Tests and headless consumers may set this to a constructed
	// RunConfig{} to exercise specific hook scenarios.
	RunConfig *RunConfig
}

// CompactNow runs user-initiated compaction on the given conversation
// outside of an active agent loop. Routes through the same performCompact
// helper as compactIfNeeded so the boundary block, event sequence, hook
// payload, and tree entry are byte-identical to a proactive compaction —
// only the strategy/trigger string differs ("user" instead of "auto").
//
// Lifecycle:
//   - Load conversation from disk via conversation.Load. If not found,
//     return a typed error so the session layer can surface a friendly
//     "nothing to compact" message rather than a stack trace.
//   - Resolve the model's context window via resolveContextWindow.
//     Unknown and zero-window models fall back to conversation.DefaultContext (logged).
//   - Resolve RunConfig (req.RunConfig → b.lastRunConfig → empty).
//   - Build compactParams from RunConfig's defaults and session-memory
//     accessors — mirroring buildCompactParams's role in the agent loop
//     but populated from the RunConfig's GetSessionMemory /
//     GetLastSummarizedEntryID / ResetMemoryTracking helpers when present.
//   - Construct a minimal synthetic activeRun (just enough for b.emit to
//     route events through the runID-keyed callback).
//   - Fire session_before_compact hook; honour cancellation.
//   - Call performCompact with trigger="user".
//
// CompactNow does NOT:
//   - Re-check whether compaction is "needed" against the token limit.
//     The user is explicitly asking; the trigger is the decision.
//   - Increment compactionsWithoutProgress. The circuit breaker exists
//     to bound proactive cascades; user requests are deliberate and
//     shouldn't share that budget.
//
// Returns an error only on hard failures (conversation not found,
// session_before_compact hook cancellation, save failure). A successful
// compaction returns nil even if every summary tier produced an empty
// result — the boundary block injection and event emission still happen.
func (b *ApiBackend) CompactNow(ctx context.Context, req CompactRequest) error {
	utils.Log("ApiBackend", fmt.Sprintf("CompactNow: convID=%s model=%s requestID=%s", req.ConversationID, req.Model, req.RequestID))

	if req.ConversationID == "" {
		return fmt.Errorf("CompactNow: ConversationID is required")
	}
	if req.RequestID == "" {
		return fmt.Errorf("CompactNow: RequestID is required")
	}

	// Load the conversation from disk. ErrNotFound is surfaced verbatim
	// so the session layer can render a friendly message; other errors
	// also surface (load corruption, disk failure).
	conv, err := conversation.Load(req.ConversationID, "")
	if err != nil {
		utils.Log("ApiBackend", fmt.Sprintf("CompactNow: load failed convID=%s err=%v", req.ConversationID, err))
		return fmt.Errorf("CompactNow: load conversation %s: %w", req.ConversationID, err)
	}

	// Resolve the model's context window. Unknown models (and registry
	// entries with a zero window) fall back to the engine default —
	// matching the agent-loop's resolution in runloop.go so /compact's
	// window math agrees with the proactive trigger's measurement.
	contextWindow := resolveContextWindow(req.Model)

	// Resolve effective RunConfig: explicit request value > cached >
	// empty. The cached value is populated by StartRunWithConfig so a
	// session that has already had at least one run gets its hooks
	// replayed automatically.
	cfg := req.RunConfig
	if cfg == nil {
		b.mu.Lock()
		cfg = b.lastRunConfig
		b.mu.Unlock()
	}
	var hooks RunHooks
	if cfg != nil {
		hooks = cfg.Hooks
	}

	// Build compaction params from RunOptions defaults (caller didn't
	// supply RunOptions because there's no run; we use built-in
	// defaults from the conversation package, which is what buildCompactParams
	// would do for a no-override case).
	opts := types.RunOptions{}
	cp := buildCompactParams(&opts, "")
	if cfg != nil {
		// Thread session-memory plumbing the same way StartRunWithConfig's
		// run loop does. Without this, the four-tier summary fallback
		// would skip tier 1 (session memory) even when the harness has
		// wired it up.
		if cfg.GetSessionMemory != nil {
			cp.getSessionMemory = cfg.GetSessionMemory
		}
		if cfg.GetLastSummarizedEntryID != nil {
			cp.getLastSummarizedEntryID = cfg.GetLastSummarizedEntryID
		}
		if cfg.ResetMemoryTracking != nil {
			cp.resetMemoryTracking = cfg.ResetMemoryTracking
		}
	}

	// Synthetic activeRun — just enough for b.emit's routing. We intentionally
	// do NOT register this run in b.activeRuns because (a) it has no agent
	// loop attached and (b) Cancel/IsRunning queries against it would be
	// nonsensical. The run.lastProgressAt initialisation mirrors the
	// StartRunWithConfig pattern so b.emit's progress-bump doesn't compare
	// against a zero timestamp.
	run := &activeRun{
		requestID: req.RequestID,
		conv:      conv,
		startTime: time.Now(),
		opts:      &opts,
		cfg:       cfg,
	}
	run.lastProgressAt.Store(run.startTime.UnixNano())

	// Fire session_before_compact hook (can cancel). Same gate as the
	// proactive path — a harness can veto user-initiated compaction the
	// same way it can veto auto compaction.
	if hooks.OnSessionBeforeCompact != nil && hooks.OnSessionBeforeCompact(run.requestID) {
		utils.Log("ApiBackend", fmt.Sprintf("CompactNow: cancelled by OnSessionBeforeCompact hook requestID=%s", run.requestID))
		return fmt.Errorf("CompactNow: cancelled by session_before_compact hook")
	}

	// tokenLimit is informational here (the user is forcing compaction
	// regardless of usage). Pass the auto-trigger threshold so the hook
	// payload and logs show what the proactive system would have used.
	tokenLimit := conversation.AutoCompactTokenLimit(contextWindow, opts.MaxTokens)

	b.performCompact(performCompactParams{
		ctx:           ctx,
		run:           run,
		conv:          conv,
		hooks:         hooks,
		contextWindow: contextWindow,
		tokenLimit:    tokenLimit,
		cp:            cp,
		trigger:       "user",
	})

	utils.Log("ApiBackend", fmt.Sprintf("CompactNow COMPLETE: convID=%s requestID=%s", req.ConversationID, req.RequestID))
	return nil
}
