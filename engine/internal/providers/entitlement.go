// Package providers: per-principal model entitlement (child 05, FR-05).
//
// Model discovery was process-wide (a package-level sync.Once plus
// discoveryCache): every
// principal on a shared engine saw the same catalog, resolved from whichever
// credential happened to trigger the first fetch. Two real subscription keys
// against the same gateway returned 16 and 9 models sharing only 5 ids
// (baseline.md §4) -- a principal reading another's catalog is shown models
// their own credential cannot call.
//
// Shared model METADATA (dialect, context window, pricing, capabilities)
// still lives in the process-wide modelRegistry (provider.go) and is
// unaffected: the same measurement showed dialect does NOT vary by caller
// (R-21). Only the discovered ID SET is per principal, held here.
package providers

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// entitlementKey identifies one principal's discovered catalog for one
// provider. Subject "" is the unattributed principal -- the single-user path.
type entitlementKey struct {
	Subject  string
	Provider string
}

type entitlementEntry struct {
	modelIDs  []string
	fetchedAt time.Time
	err       string
}

type entitlementFlight struct {
	done chan struct{}
	ids  []string
	err  error
}

var (
	entMu      sync.Mutex
	entCache   = map[entitlementKey]*entitlementEntry{}
	entFlights = map[entitlementKey]*entitlementFlight{}
)

// ResetEntitlementForTest clears all cached entitlement and in-flight
// fetches. Test-only, mirroring ResetRegistries/ResetDiscoveryCache.
func ResetEntitlementForTest() {
	entMu.Lock()
	defer entMu.Unlock()
	entCache = map[entitlementKey]*entitlementEntry{}
	entFlights = map[entitlementKey]*entitlementFlight{}
}

// EntitlementFor returns the model ids subject's credential is entitled to
// for providerID -- the set list_models filters against and a run may
// select from. fetch performs the actual discovery HTTP call (built by the
// caller with the principal's resolved authenticator; entitlement.go never
// touches a credential itself).
//
// Caching: an entry fresher than discoveryStaleDur (24h, matching B-18's
// existing per-provider staleness window, now per (subject, provider)) is
// served without calling fetch. A fetch in flight for the same key is
// joined rather than duplicated (R-17): concurrent first-use collapses to
// one HTTP call. A failed fetch falls back to the static catalog by
// returning (nil, err) -- the caller (CredentialContext.Entitlement)
// treats nil as "not yet discovered, do not filter" (B-17's spirit,
// per-principal now).
func EntitlementFor(ctx context.Context, subject, providerID string, fetch func(ctx context.Context) ([]types.ModelEntry, error)) ([]string, error) {
	key := entitlementKey{Subject: subject, Provider: providerID}

	entMu.Lock()
	if e := entCache[key]; e != nil && time.Since(e.fetchedAt) < discoveryStaleDur {
		ids := e.modelIDs
		entMu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "ModelDiscovery", "entitlement cache hit", map[string]any{
			"subject": subject, "provider": providerID, "count": len(ids),
		})
		return ids, nil
	}
	if flight := entFlights[key]; flight != nil {
		entMu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "ModelDiscovery", "entitlement fetch coalesced", map[string]any{
			"subject": subject, "provider": providerID,
		})
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-flight.done:
			return flight.ids, flight.err
		}
	}
	flight := &entitlementFlight{done: make(chan struct{})}
	entFlights[key] = flight
	entMu.Unlock()

	utils.LogWithFields(utils.LevelDebug, "ModelDiscovery", "entitlement fetch started", map[string]any{
		"subject": subject, "provider": providerID,
	})
	models, err := fetch(ctx)

	entMu.Lock()
	if err == nil {
		ids := make([]string, len(models))
		for i, m := range models {
			ids[i] = m.ID
		}
		entCache[key] = &entitlementEntry{modelIDs: ids, fetchedAt: time.Now()}
		flight.ids = ids
		// Shared metadata (dialect, cost, capabilities) still lands in the
		// process-wide modelRegistry, so routing and dialect resolution are
		// unaffected by which principal triggered the fetch (R-21).
		storeResult(providerID, models, nil)
	} else {
		entCache[key] = &entitlementEntry{fetchedAt: time.Now(), err: err.Error()}
		flight.err = err
		utils.LogWithFields(utils.LevelWarn, "ModelDiscovery", "entitlement fetch failed, falling back to static catalog", map[string]any{
			"subject": subject, "provider": providerID, "error": err.Error(),
		})
	}
	delete(entFlights, key)
	close(flight.done)
	entMu.Unlock()

	if err != nil {
		return nil, err
	}
	utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "entitlement resolved", map[string]any{
		"subject": subject, "provider": providerID, "count": len(flight.ids),
	})
	return flight.ids, nil
}

// InvalidateEntitlement drops a principal's cached entitlement and discovery
// entry for one provider (or every provider when providerID is ""), so the
// next resolution re-fetches. Used by child 07's single invalidation entry
// point (InvalidatePrincipal, below) and by child 08's per-principal
// credential write path (B-12: store_credential triggers rediscovery).
func InvalidateEntitlement(subject, providerID string) {
	entMu.Lock()
	defer entMu.Unlock()
	dropped := 0
	for key := range entCache {
		if key.Subject != subject {
			continue
		}
		if providerID != "" && key.Provider != providerID {
			continue
		}
		delete(entCache, key)
		dropped++
	}
	if dropped > 0 {
		utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "entitlement invalidated", map[string]any{
			"subject": subject, "provider": providerID, "count": dropped,
		})
	}
}

// EntitlementForPrincipal is the full per-principal discovery entry point:
// it resolves the provider's base URL from providerConfigs (the same
// resolution DiscoverProvider/RefreshModels use for the unattributed path),
// builds an authApplier from the already-resolved auth.RequestAuthenticator
// (never a raw key -- R-06), and delegates to EntitlementFor for the
// cache/singleflight/staleness behavior.
//
// Returns (nil, nil) when the provider has no base URL configured (nothing
// to discover) -- the caller (auth.CredentialContext.Entitlement) treats nil
// as "not yet discovered, do not filter", matching B-17's fallback spirit.
func EntitlementForPrincipal(ctx context.Context, subject, providerID string, authenticator auth.RequestAuthenticator, providerConfigs map[string]types.ProviderConfig) ([]string, error) {
	if isCliBacked(providerID) {
		utils.LogWithFields(utils.LevelDebug, "ModelDiscovery", "skipping entitlement fetch for cli-backed provider", map[string]any{
			"subject": subject, "provider": providerID,
		})
		return nil, nil
	}
	baseURL := resolveBaseURL(providerID, providerConfigs)
	if baseURL == "" {
		utils.LogWithFields(utils.LevelDebug, "ModelDiscovery", "no base url for entitlement fetch", map[string]any{
			"subject": subject, "provider": providerID,
		})
		return nil, nil
	}
	return EntitlementFor(ctx, subject, providerID, func(ctx context.Context) ([]types.ModelEntry, error) {
		return fetchModelsForProviderAuth(providerID, baseURL, func(req *http.Request) error {
			if authenticator == nil {
				return nil
			}
			return authenticator.Authenticate(ctx, req, nil)
		})
	})
}

// WireEntitlement sets cc.Entitlement to the real per-principal discovery
// closure, so any caller holding a *auth.CredentialContext -- the session
// layer's per-run wiring, or a standalone per-command CredentialContext like
// list_models' cmd.Principal path -- gets identical entitlement behavior
// with no duplicated wiring logic. Safe to call on a CredentialContext built
// with any FallThroughPolicy; entitlement resolution always goes through
// cc.Authenticator, so a refused principal simply resolves nothing (nil,
// which does not filter -- see filterModelsByEntitlement's caller).
func WireEntitlement(cc *auth.CredentialContext, providerConfigs map[string]types.ProviderConfig) {
	if cc == nil {
		return
	}
	subject := cc.Subject()
	cc.Entitlement = func(providerID string) []string {
		a, err := cc.Authenticator(context.Background(), providerID)
		if err != nil || a == nil {
			// No credential (or a refusal): nothing to discover with. nil
			// means "not yet discovered, do not filter" -- never claim an
			// empty entitlement for a principal whose credential simply
			// was not resolved.
			return nil
		}
		ids, err := EntitlementForPrincipal(context.Background(), subject, providerID, a, providerConfigs)
		if err != nil {
			return nil
		}
		return ids
	}
}

// InvalidatePrincipal is the single credential invalidation entry point
// (child 07, R-18): one call drops every cached artifact derived from one
// principal's credential for one provider (or every provider when providerID
// is "") -- the HasKey negative cache, the authenticator/token cache, and
// the entitlement + discovery cache together, so a caller cannot
// half-invalidate and leave one of the three stale. Lives in this package
// (rather than auth, where the spec's own pseudocode first placed it)
// because it needs both auth.InvalidatePrincipalCredential and
// InvalidateEntitlement, and internal/auth cannot import internal/providers
// (providers already imports auth) -- providers is the layer that sees both.
func InvalidatePrincipal(subject, providerID string) {
	auth.InvalidatePrincipalCredential(subject, providerID)
	InvalidateEntitlement(subject, providerID)
	utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "principal invalidation complete", map[string]any{
		"subject": subject, "provider": providerID,
	})
}
