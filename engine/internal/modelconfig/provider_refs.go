package modelconfig

import (
	"fmt"
	"sort"
	"strings"
)

// ProviderReferences names every place models.json selects one of a
// provider's provider-qualified models ("<provider>/<model>"): the default
// model, and each model tier's model and fallbacks. Each entry reads as a
// phrase, such as `the default model corp/m` or `the standard tier's model
// corp/m`. Removing the provider would leave each of them naming a model
// nothing serves.
func ProviderReferences(providerID string) []string {
	config := LoadModelsConfig()
	prefix := providerID + "/"
	var refs []string
	if model, _ := config["defaultModel"].(string); strings.HasPrefix(model, prefix) { //nolint:errcheck // a non-string defaultModel names no provider
		refs = append(refs, "the default model "+model)
	}
	tiers, _ := config["tiers"].(map[string]interface{}) //nolint:errcheck // a missing or non-map tiers block names no provider
	names := make([]string, 0, len(tiers))
	for name := range tiers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		entry, ok := parseTier(name, tiers[name])
		if !ok {
			continue
		}
		if strings.HasPrefix(entry.Model, prefix) {
			refs = append(refs, fmt.Sprintf("the %s tier's model %s", entry.Name, entry.Model))
		}
		for _, fallback := range entry.Fallbacks {
			if strings.HasPrefix(fallback, prefix) {
				refs = append(refs, fmt.Sprintf("the %s tier's fallback %s", entry.Name, fallback))
			}
		}
	}
	return refs
}
