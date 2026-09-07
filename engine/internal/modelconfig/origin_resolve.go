package modelconfig

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// ProviderLockedModelError refuses an LLM-authored request that would change
// provider. Provider selection affects both data residency and billing, so it
// is an operator or extension decision, never model free will.
type ProviderLockedModelError struct {
	Requested       string
	SessionProvider string
	AllowedModels   []string
}

func (e *ProviderLockedModelError) Error() string {
	if len(e.AllowedModels) == 0 {
		return fmt.Sprintf("model %q is not allowed: this session is locked to provider %q and has no configured models matching that request", e.Requested, e.SessionProvider)
	}
	return fmt.Sprintf("model %q is not allowed: this session is locked to provider %q; choose one of: %s", e.Requested, e.SessionProvider, strings.Join(e.AllowedModels, ", "))
}

// ResolveModelForOrigin resolves tier aliases first. A tier is deterministic
// operator configuration, so its configured provider is allowed. A direct
// model string from an LLM is locked to the parent session provider.
func ResolveModelForOrigin(requested, sessionModel string, origin types.ModelOrigin) (string, []string, error) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return "", nil, nil
	}
	if tier, ok := LookupTier(requested); ok {
		// A tier may be written with a bare model name. Bias it onto the
		// operator's default provider when that provider serves the model;
		// an explicitly qualified tier model is never touched.
		return ApplyDefaultProvider(tier.Model), tier.Fallbacks, nil
	}
	if origin != types.ModelOriginAgent {
		return requested, nil, nil
	}

	sessionProvider := providers.ProviderNameForModel(sessionModel)
	if sessionProvider == "" {
		// A test-constructed or legacy session can lack a registered parent
		// model. There is no provider boundary to enforce in that state; retain
		// compatibility rather than inventing a provider from a child string.
		return requested, nil, nil
	}

	if slash := strings.IndexByte(requested, '/'); slash > 0 {
		if requested[:slash] != sessionProvider {
			return "", nil, providerLockedError(requested, sessionProvider)
		}
		if info := providers.GetModelInfo(requested); info != nil && info.ProviderID == sessionProvider {
			return requested, nil, nil
		}
		return "", nil, providerLockedError(requested, sessionProvider)
	}

	if qualified := sessionProvider + "/" + requested; modelBelongsTo(qualified, sessionProvider) {
		return qualified, nil, nil
	}
	if modelBelongsTo(requested, sessionProvider) {
		return requested, nil, nil
	}
	return "", nil, providerLockedError(requested, sessionProvider)
}

func modelBelongsTo(model, providerID string) bool {
	info := providers.GetModelInfo(model)
	return info != nil && info.ProviderID == providerID
}

func providerLockedError(requested, providerID string) error {
	allowed := make([]string, 0)
	for _, model := range providers.ListModels() {
		if model.ProviderID == providerID {
			allowed = append(allowed, model.ID)
		}
	}
	return &ProviderLockedModelError{Requested: requested, SessionProvider: providerID, AllowedModels: allowed}
}
