package auth

import (
	"os"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// ProviderEnvValues is the resolved set of logical fields for a provider whose
// credential is more than one environment variable (AWS access key + secret +
// session token + region for Bedrock; a token + project for Vertex; a key with
// a documented fallback for Foundry). Source is always "env" today; the field
// exists so future set-valued sources (e.g. a partitioned file-store entry
// carrying JSON) can populate the same shape.
type ProviderEnvValues struct {
	Values map[string]string // logical name -> resolved value
	Source string            // "env"
}

// envField declares one logical field of a multi-value provider credential:
// the ordered list of environment variable names it may come from, and
// whether the field must be present for the whole set to resolve.
type envField struct {
	Logical  string
	Names    []string
	Required bool
}

// providerEnvSets declares, per provider, the logical fields and the ordered
// environment names each may come from. Single-key providers keep resolving
// through resolveFromEnv/providerEnvVars unchanged; this table exists only for
// the multi-value providers that a single ResolveKey string cannot carry.
//
// This is the resolver-side completion of baseline.md §1.2: every variable a
// provider constructor read directly is resolvable here before child 03
// removes the constructor's own read.
var providerEnvSets = map[string][]envField{
	"bedrock": {
		{Logical: "accessKeyID", Names: []string{"AWS_ACCESS_KEY_ID"}, Required: true},
		{Logical: "secretAccessKey", Names: []string{"AWS_SECRET_ACCESS_KEY"}, Required: true},
		{Logical: "sessionToken", Names: []string{"AWS_SESSION_TOKEN"}},
		{Logical: "region", Names: []string{"AWS_REGION", "AWS_DEFAULT_REGION"}},
	},
	"foundry": {
		{Logical: "apiKey", Names: []string{"ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_API_KEY"}, Required: true},
		{Logical: "baseURL", Names: []string{"ANTHROPIC_FOUNDRY_BASE_URL"}},
	},
	"vertex": {
		{Logical: "accessToken", Names: []string{"GOOGLE_ACCESS_TOKEN"}, Required: true},
		{Logical: "projectID", Names: []string{"GOOGLE_CLOUD_PROJECT"}},
	},
}

// firstNonEmptyEnv returns the first non-empty (after trimming) value among
// the named environment variables, trying each in order. Whitespace-only
// values are treated as absent, not present-and-empty.
func firstNonEmptyEnv(names []string) string {
	for _, name := range names {
		if v := strings.TrimSpace(os.Getenv(name)); v != "" {
			return v
		}
	}
	return ""
}

// ResolveProviderEnvField resolves a single named field from a provider's
// declared env set, independent of whether the set's OTHER required fields
// are present. Used when one field has a different lifecycle than the rest
// -- Vertex's projectID is baked into a request URL at construction time,
// while its accessToken is resolved fresh per request, so requiring both to
// be present just to read one would wrongly couple the two. Returns ("",
// false) when the provider has no such field declared, or the field's own
// value is absent.
func ResolveProviderEnvField(provider, logical string) (string, bool) {
	provider = strings.ToLower(provider)
	fields, ok := providerEnvSets[provider]
	if !ok {
		return "", false
	}
	for _, f := range fields {
		if f.Logical != logical {
			continue
		}
		v := firstNonEmptyEnv(f.Names)
		if v == "" {
			return "", false
		}
		return v, true
	}
	return "", false
}

// ResolveProviderEnv resolves the multi-value environment set for a provider,
// if one is declared. Returns (nil, false) for a provider with no entry in
// providerEnvSets -- the caller falls back to the single-key ResolveKey path,
// untouched. Resolution is all-or-nothing per the set's Required fields,
// matching the constructors' current behavior: a partially configured Bedrock
// (access key present, secret absent) resolves to nothing rather than a
// broken partial credential.
func ResolveProviderEnv(provider string) (*ProviderEnvValues, bool) {
	provider = strings.ToLower(provider)
	fields, ok := providerEnvSets[provider]
	if !ok {
		return nil, false
	}

	values := make(map[string]string, len(fields))
	var missing []string
	for _, f := range fields {
		v := firstNonEmptyEnv(f.Names)
		if v == "" {
			if f.Required {
				missing = append(missing, f.Logical)
			}
			continue
		}
		values[f.Logical] = v
	}

	if len(missing) > 0 {
		utils.LogWithFields(utils.LevelDebug, "auth", "provider env set incomplete", map[string]any{
			"provider": provider, "missing": missing,
		})
		return nil, false
	}

	lengths := make(map[string]int, len(values))
	fieldNames := make([]string, 0, len(values))
	for k, v := range values {
		lengths[k] = len(v)
		fieldNames = append(fieldNames, k)
	}
	utils.LogWithFields(utils.LevelInfo, "auth", "provider env set resolved", map[string]any{
		"provider": provider, "fields": fieldNames, "lengths": lengths,
	})
	return &ProviderEnvValues{Values: values, Source: "env"}, true
}
