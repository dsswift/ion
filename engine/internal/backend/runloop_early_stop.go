package backend

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// earlyStopContinueKind is the SystemInjectInfo.Kind passed to the
// system_inject hook when the engine injects a continuation prompt. Kept
// as a constant so tests and harness handlers reference the same string.
const earlyStopContinueKind = "early_stop_continue"

// effectiveEarlyStopConfig is the snapshot of resolved early-stop settings
// for a single run. Built once at the top of runLoop by mergeEarlyStopConfig
// and then carried on the activeRun's snapshot (passed as a value to keep
// the runloop free of mutation surprises mid-loop).
type effectiveEarlyStopConfig struct {
	enabled          bool
	budget           int
	thresholdPct     int
	maxContinuations int
	diminishingDelta int
	// source records which layer won the most-specific decision; logged
	// once per run so debugging is trivial. One of: "defaults",
	// "engineConfig", "runOptions".
	source string
}

// mergeEarlyStopConfig resolves the effective early-stop config for a run.
// Resolution order (highest priority last):
//  1. Built-in defaults from types.EarlyStopDefaults()
//  2. engine.json values (RunConfig.EarlyStopContinue)
//  3. RunOptions fields (per-run overrides)
//  4. Sub-agent gate: if opts.IsSubagent and EarlyStopEnabled is nil/false,
//     force disabled. The harness can still force-on via &true.
//
// The function never mutates its inputs; it returns a fresh snapshot.
// Logging happens at the call site (runLoop) so this stays a pure helper.
func mergeEarlyStopConfig(opts types.RunOptions, cfg *RunConfig) effectiveEarlyStopConfig {
	// Start with built-in defaults.
	defaults := types.EarlyStopDefaults()
	out := effectiveEarlyStopConfig{
		enabled:          defaults.Enabled != nil && *defaults.Enabled,
		budget:           defaults.Budget,
		thresholdPct:     defaults.ThresholdPct,
		maxContinuations: defaults.MaxContinuations,
		diminishingDelta: defaults.DiminishingDelta,
		source:           "defaults",
	}

	// Overlay engine.json values when present and non-zero.
	if cfg != nil && cfg.EarlyStopContinue != nil {
		jc := cfg.EarlyStopContinue
		if jc.Enabled != nil {
			out.enabled = *jc.Enabled
			out.source = "engineConfig"
		}
		if jc.Budget != 0 {
			out.budget = jc.Budget
			out.source = "engineConfig"
		}
		if jc.ThresholdPct != 0 {
			out.thresholdPct = jc.ThresholdPct
			out.source = "engineConfig"
		}
		if jc.MaxContinuations != 0 {
			out.maxContinuations = jc.MaxContinuations
			out.source = "engineConfig"
		}
		if jc.DiminishingDelta != 0 {
			out.diminishingDelta = jc.DiminishingDelta
			out.source = "engineConfig"
		}
	}

	// Overlay per-run RunOptions.
	if opts.EarlyStopEnabled != nil {
		out.enabled = *opts.EarlyStopEnabled
		out.source = "runOptions"
	}
	// Negative budget disables the feature for this run (per type docs).
	if opts.EarlyStopBudget < 0 {
		out.enabled = false
		out.source = "runOptions"
	} else if opts.EarlyStopBudget > 0 {
		out.budget = opts.EarlyStopBudget
		out.source = "runOptions"
	}
	if opts.EarlyStopThresholdPct > 0 {
		out.thresholdPct = opts.EarlyStopThresholdPct
		out.source = "runOptions"
	}
	if opts.EarlyStopMaxContinuations > 0 {
		out.maxContinuations = opts.EarlyStopMaxContinuations
		out.source = "runOptions"
	}
	if opts.EarlyStopDiminishingDelta > 0 {
		out.diminishingDelta = opts.EarlyStopDiminishingDelta
		out.source = "runOptions"
	}

	// Sub-agent gate: default off unless the harness explicitly forced on.
	if opts.IsSubagent && (opts.EarlyStopEnabled == nil || !*opts.EarlyStopEnabled) {
		out.enabled = false
		if opts.EarlyStopEnabled == nil {
			out.source = "subagentDefault"
		}
	}

	// Hard safety nets: if budget or threshold are nonsensical, disable
	// rather than divide by zero or produce a permanently-true predicate.
	if out.budget <= 0 || out.thresholdPct <= 0 || out.thresholdPct > 100 {
		out.enabled = false
	}

	return out
}

// maybeContinueEarlyStop is the decision point invoked from runloop.go when
// the model emits end_turn / stop. Returns true when the engine should
// inject a continuation and re-run the turn; false to fall through to the
// usual TaskCompleteEvent emission.
//
// On a true return the function has already:
//   - fired before_early_stop_decision (if a handler is wired)
//   - fired OnSystemInject through injectSystemMessage (which appended the
//     user message to the conversation, persisted it, and respected
//     suppress / rewrite return values)
//   - bumped run.continuationCount and recorded the delta
//   - fired early_stop_continued (if a handler is wired)
//
// Verbose logging at every branch satisfies the logging policy in CLAUDE.md:
// from the log alone a reader can reconstruct exactly which combination of
// engine defaults / engine.json / RunOptions / hook overrides produced the
// final decision.
func (b *ApiBackend) maybeContinueEarlyStop(
	run *activeRun,
	conv *conversation.Conversation,
	hooks RunHooks,
	opts types.RunOptions,
	cfg effectiveEarlyStopConfig,
	currentTurnOutputTokens int,
	stopReason string,
	turn, maxTurns int,
) bool {
	if !cfg.enabled {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "earlyStop: disabled (skip)", map[string]any{
			"run_id": run.requestID,
			"turn":   turn,
			"source": cfg.source,
		})
		return false
	}

	// Compute current delta (how much this turn produced relative to the
	// previous continuation). On the first decision the delta equals the
	// current turn's output tokens, since lastContinuationDelta is zero.
	currentDelta := currentTurnOutputTokens

	pct := 0
	if cfg.budget > 0 {
		pct = (run.cumulativeOutputTokens * 100) / cfg.budget
	}

	// Diminishing-returns guard: after the cap is reached the model is
	// already done; after 3 nudges with tiny deltas we give up and let
	// the run end. The double-check on both lastContinuationDelta and
	// currentDelta matches Claude Code's `isDiminishing` predicate.
	diminishing := run.continuationCount >= 3 &&
		run.lastContinuationDelta < cfg.diminishingDelta &&
		currentDelta < cfg.diminishingDelta

	// Tentative engine verdict before any harness hook gets a vote.
	wouldContinue := pct < cfg.thresholdPct &&
		run.continuationCount < cfg.maxContinuations &&
		!diminishing

	// Fire the dedicated hook. Handlers may rewrite ForceContinue,
	// OverrideBudget, OverrideThresholdPct, or ContinueMessage. The
	// runloop already runs in a goroutine the cancellation context owns,
	// so we don't need a separate timeout here — handlers are documented
	// as fast / observe-style.
	effBudget := cfg.budget
	effThresholdPct := cfg.thresholdPct
	customMessage := ""
	if hooks.OnBeforeEarlyStopDecision != nil {
		info := EarlyStopDecisionInfo{
			RunID:                  run.requestID,
			Model:                  conv.Model,
			TurnNumber:             turn,
			StopReason:             stopReason,
			CumulativeOutputTokens: run.cumulativeOutputTokens,
			Budget:                 cfg.budget,
			ThresholdPct:           cfg.thresholdPct,
			ContinuationCount:      run.continuationCount,
			MaxContinuations:       cfg.maxContinuations,
			LastContinuationDelta:  run.lastContinuationDelta,
			WouldContinue:          wouldContinue,
			IsSubagent:             opts.IsSubagent,
		}
		var result *EarlyStopDecisionResult
		func() {
			// Defensive: a panicking handler must not crash the run.
			// Mirrors OnBeforeProviderRequest's recovery shape.
			defer func() {
				if r := recover(); r != nil {
					utils.LogWithFields(utils.LevelError, "backend.runloop", "OnBeforeEarlyStopDecision panicked", map[string]any{
						"run_id": run.requestID,
						"panic":  r,
					})
				}
			}()
			result = hooks.OnBeforeEarlyStopDecision(info)
		}()
		if result != nil {
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "earlyStop: hook returned overrides", map[string]any{
				"run_id":             run.requestID,
				"turn":               turn,
				"force_continue":     result.ForceContinue != nil,
				"override_budget":    result.OverrideBudget,
				"override_threshold": result.OverrideThresholdPct,
				"custom_msg":         result.ContinueMessage != "",
			})
			if result.OverrideBudget > 0 {
				effBudget = result.OverrideBudget
				// Recompute pct against the new budget. Don't update
				// wouldContinue here — ForceContinue (if set) overrides
				// directly; otherwise we recompute below.
				pct = (run.cumulativeOutputTokens * 100) / effBudget
			}
			if result.OverrideThresholdPct > 0 {
				effThresholdPct = result.OverrideThresholdPct
			}
			if result.ContinueMessage != "" {
				customMessage = result.ContinueMessage
			}
			if result.ForceContinue != nil {
				wouldContinue = *result.ForceContinue
			} else {
				// No explicit force; re-evaluate against the (possibly
				// updated) budget/threshold so a harness can effectively
				// "open the gate" by bumping the budget alone.
				wouldContinue = pct < effThresholdPct &&
					run.continuationCount < cfg.maxContinuations &&
					!diminishing
			}
		}
	}

	if !wouldContinue {
		switch {
		case diminishing:
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "earlyStop: diminishing returns, stopping", map[string]any{
				"run_id":     run.requestID,
				"turn":       turn,
				"count":      run.continuationCount,
				"pct":        pct,
				"budget":     effBudget,
				"cum_out":    run.cumulativeOutputTokens,
				"last_delta": run.lastContinuationDelta,
				"curr_delta": currentDelta,
			})
		case run.continuationCount >= cfg.maxContinuations:
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "earlyStop: cap reached , stopping", map[string]any{
				"max_continuations": cfg.maxContinuations,
				"run_id":            run.requestID,
				"turn":              turn,
				"pct":               pct,
				"budget":            effBudget,
			})
		default:
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "earlyStop: at/above threshold or hook vetoed", map[string]any{
				"run_id":    run.requestID,
				"turn":      turn,
				"pct":       pct,
				"threshold": effThresholdPct,
				"budget":    effBudget,
				"count":     run.continuationCount,
			})
		}
		return false
	}

	// Build the continuation text. The engine ships no default — a
	// consumer must supply ContinueMessage via the before_early_stop_decision
	// hook return value. If nothing did, log the no-op and fall through to
	// normal task-complete emission (semantically: "engine is willing to
	// continue, but nobody asked it to inject anything, so don't").
	if customMessage == "" {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "earlyStop: enabled but no ContinueMessage supplied by hook; skipping injection", map[string]any{
			"run_id": run.requestID,
			"turn":   turn,
			"pct":    pct,
			"budget": effBudget,
			"count":  run.continuationCount,
		})
		return false
	}
	text := customMessage

	// Snapshot conversation length so we can detect whether OnSystemInject
	// (called inside injectSystemMessage) or the DisableEarlyStopContinue
	// flag suppressed the injection. When suppressed, the conversation
	// length is unchanged — and we must NOT continue the loop, because the
	// model has no new user message to react to. Falling through to
	// TaskCompleteEvent matches the user-facing intent of OnSystemInject
	// returning suppress=true ("don't inject this message").
	beforeLen := len(conv.Messages)
	b.injectSystemMessage(run, conv, hooks, opts, earlyStopContinueKind, text, turn, maxTurns)
	injected := len(conv.Messages) > beforeLen
	if !injected {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "earlyStop: injection suppressed (OnSystemInject or DisableEarlyStopContinue), stopping run", map[string]any{
			"run_id": run.requestID,
			"turn":   turn,
		})
		// Fire the observed-only hook so handlers see "we tried but were
		// suppressed". Bookkeeping is NOT updated since no nudge actually
		// happened — the run is about to stop.
		if hooks.OnEarlyStopContinued != nil {
			info := EarlyStopContinuedInfo{
				RunID:                  run.requestID,
				TurnNumber:             turn,
				ContinuationCount:      run.continuationCount, // unchanged
				Pct:                    pct,
				CumulativeOutputTokens: run.cumulativeOutputTokens,
				Budget:                 effBudget,
				InjectedText:           "",
			}
			func() {
				defer func() {
					if r := recover(); r != nil {
						utils.LogWithFields(utils.LevelError, "backend.runloop", "OnEarlyStopContinued panicked", map[string]any{
							"run_id": run.requestID,
							"panic":  r,
						})
					}
				}()
				hooks.OnEarlyStopContinued(info)
			}()
		}
		return false
	}

	// Update bookkeeping AFTER injection so the next decision sees the
	// correct count and delta.
	run.continuationCount++
	run.lastContinuationDelta = currentDelta

	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "earlyStop: continuation injected", map[string]any{
		"run_id":         run.requestID,
		"turn":           turn,
		"count":          run.continuationCount,
		"pct":            pct,
		"budget":         effBudget,
		"cum_out":        run.cumulativeOutputTokens,
		"delta":          currentDelta,
		"custom_message": customMessage != "",
	})

	if hooks.OnEarlyStopContinued != nil {
		info := EarlyStopContinuedInfo{
			RunID:                  run.requestID,
			TurnNumber:             turn,
			ContinuationCount:      run.continuationCount,
			Pct:                    pct,
			CumulativeOutputTokens: run.cumulativeOutputTokens,
			Budget:                 effBudget,
			InjectedText:           text,
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					utils.LogWithFields(utils.LevelError, "backend.runloop", "OnEarlyStopContinued panicked", map[string]any{
						"run_id": run.requestID,
						"panic":  r,
					})
				}
			}()
			hooks.OnEarlyStopContinued(info)
		}()
	}

	return true
}
