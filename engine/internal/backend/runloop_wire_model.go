package backend

import (
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/utils"
)

// providerWireModel returns the model id the run loop puts on provider's
// wire for the run model: the bare id when model carries provider's own
// qualifier, model unchanged otherwise.
//
// A provider-qualified id ("anthropic/<model>") is engine routing identity --
// it exists so two providers can serve one bare id, and so a client's
// explicit provider pick cannot be moved by a defaultProvider preference. No
// provider API accepts it. The gateway provider strips its own prefix inside
// Stream; every other provider forwarded the qualified id verbatim and the
// API refused the request, so the strip lives here, once, for all of them.
func providerWireModel(provider providers.LlmProvider, model string) string {
	wire := providers.StripProviderQualifier(provider.ID(), model)
	if wire != model {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "provider-qualified run model stripped for the wire", map[string]any{
			"provider": provider.ID(), "model": model, "wire_model": wire,
		})
	}
	return wire
}
