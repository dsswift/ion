// Package backend — runloop_context_breakdown.go
//
// The per-category context-usage breakdown helpers, split out of runloop.go to
// keep that file under the 800-line cap. These build and emit the
// context_breakdown normalized event (which the session layer translates to
// engine_context_breakdown), and reconcile it against the provider-reported
// input-token total after the first usage event.
package backend

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// maybeEmitContextBreakdown builds and emits the per-category context breakdown
// once per run, on the first turn that has assembled stream options. The
// builder resolves per-category counts through provider CountTokens (exact) →
// local BPE → char/4, bounded by a content-hash cache. Emitted as a normalized
// context_breakdown event; the session layer translates it to
// engine_context_breakdown. Subsequent turns are no-ops (run.contextBreakdown
// is non-nil), so the breakdown is emitted exactly once at assembly time.
func (b *ApiBackend) maybeEmitContextBreakdown(
	ctx context.Context,
	run *activeRun,
	model string,
	provider providers.LlmProvider,
	streamOpts *types.LlmStreamOptions,
) {
	if run.contextBreakdown != nil {
		return
	}
	// The individual context-file / extension / memory blocks are already
	// folded into streamOpts.System by the session injection steps, so they
	// are captured under the "system" category rather than itemized here.
	bd, err := providers.BuildContextBreakdown(ctx, model, provider, streamOpts, nil, nil, "")
	if err != nil {
		utils.Warn("ApiBackend", fmt.Sprintf("BuildContextBreakdown failed: runID=%s err=%v", run.requestID, err))
		return
	}
	if bd == nil {
		return
	}
	run.contextBreakdown = bd
	b.emit(run, types.NormalizedEvent{Data: bd.ToNormalizedEvent()})
}

// maybeReconcileContextBreakdown reconciles the breakdown with the
// provider-reported input total on the FIRST usage event only. It records the
// drift between the itemized sum and the provider total as an explicit
// "unaccounted" row and re-emits the breakdown so consumers see the reconciled
// numbers. Guarded by run.breakdownReconciled so later turns don't append
// duplicate rows.
func (b *ApiBackend) maybeReconcileContextBreakdown(run *activeRun, apiReportedTotal int) {
	if run.contextBreakdown == nil || run.breakdownReconciled {
		return
	}
	providers.ReconcileBreakdown(run.contextBreakdown, apiReportedTotal)
	run.breakdownReconciled = true
	b.emit(run, types.NormalizedEvent{Data: run.contextBreakdown.ToNormalizedEvent()})
}
