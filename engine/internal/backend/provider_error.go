package backend

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// emitProviderError emits the failure of a request to providerID. When that
// provider's key comes from the Provider Subscription lookup and the lookup
// has no key applied, the error carries the lookup's snapshot.
func (b *ApiBackend) emitProviderError(run *activeRun, providerID string, err error) {
	b.emitErrorWith(run, err, b.unappliedSubscription(run, providerID))
}

func (b *ApiBackend) unappliedSubscription(run *activeRun, providerID string) *types.ProviderSubscriptionStatus {
	runID := ""
	if run != nil {
		runID = run.requestID
	}
	b.mu.Lock()
	resolver := b.authResolver
	b.mu.Unlock()
	if resolver == nil {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "provider error: no auth resolver, subscription state not attached", map[string]any{"run_id": runID, "provider": providerID})
		return nil
	}
	status := resolver.UnappliedSubscription(providerID)
	if status == nil {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "provider error: no unapplied subscription for provider", map[string]any{"run_id": runID, "provider": providerID})
		return nil
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "provider error: subscription state attached", map[string]any{
		"run_id": runID, "provider": providerID, "state": status.State,
	})
	return status
}
